import { db } from "@workspace/db";
import { beamAnswerFeedbackTable, beamAnswerLogTable, userSettingsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { SCENT_FAMILIES, type ScentFamily } from "@workspace/scent-weather-engine";
import { logger } from "../lib/logger";
import { aggregateFeedbackPreferenceSignals, type FeedbackRow } from "../beam-agent/beamFeedbackCore";

/**
 * Beam Agent — durable answer log + feedback persistence.
 *
 * Writes are best-effort and NEVER affect the run or its SSE stream: a missing
 * table (the deploy doesn't run `drizzle push`) or any DB fault is caught and
 * logged, mirroring `apiUsageLedger`. The answer log is the record a user's
 * feedback report points at; the feedback row is the user's verdict.
 *
 * Retention: the log row carries an `expires_at` ~30 days out so this is a
 * diagnostic buffer, not a transcript store. No secrets are written.
 */

/** ~30-day retention window for a diagnostic answer record. */
const ANSWER_LOG_TTL_MS = 30 * 24 * 60 * 60_000;

/** Cap stored answer text so a runaway draft can't bloat the row. */
const MAX_ANSWER_CHARS = 8000;
/** Cap retained candidates so the jsonb stays small. */
const MAX_GROUNDED_CANDIDATES = 40;

function isTableMissingError(err: unknown, table: string): boolean {
  const value = err as { code?: unknown; message?: unknown } | null;
  return (
    value?.code === "42P01" ||
    (typeof value?.message === "string" &&
      new RegExp(`relation ["']?${table}["']? does not exist`, "i").test(value.message))
  );
}

export type BeamGroundedCandidate = {
  canonicalName: string;
  brand?: string;
  owned: boolean;
};

export type RecordBeamAnswerLogInput = {
  /** = the run id (`run_<uuid>`); the durable answer id returned to the client. */
  id: string;
  tenantId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  userMessage: string;
  derivedState?: unknown;
  lane?: string | null;
  orchestrationModel?: string | null;
  synthesisModel?: string | null;
  groundedCandidates?: BeamGroundedCandidate[];
  finalAnswer?: string | null;
  gatePassed?: boolean;
  gateViolations?: string[];
  shippedWithSoftViolations?: boolean;
  outcome?: string | null;
  failureCode?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

/**
 * Persist one Beam answer turn. Best-effort: a write failure is logged and
 * swallowed so the agent path is never blocked or crashed by logging.
 */
export async function recordBeamAnswerLog(input: RecordBeamAnswerLogInput): Promise<void> {
  try {
    await db
      .insert(beamAnswerLogTable)
      .values({
        id: input.id,
        tenantId: input.tenantId ?? null,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        userMessage: input.userMessage.slice(0, 2000),
        derivedState: input.derivedState ?? null,
        lane: input.lane ?? null,
        orchestrationModel: input.orchestrationModel ?? null,
        synthesisModel: input.synthesisModel ?? null,
        groundedCandidates: (input.groundedCandidates ?? []).slice(0, MAX_GROUNDED_CANDIDATES),
        finalAnswer: (input.finalAnswer ?? "").slice(0, MAX_ANSWER_CHARS),
        gatePassed: input.gatePassed ?? true,
        gateViolations: input.gateViolations ?? [],
        shippedWithSoftViolations: input.shippedWithSoftViolations ?? false,
        outcome: input.outcome ?? null,
        failureCode: input.failureCode ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        expiresAt: new Date(Date.now() + ANSWER_LOG_TTL_MS),
      })
      // The run id is stable; a retry/duplicate must not throw on the PK.
      .onConflictDoNothing({ target: beamAnswerLogTable.id });
  } catch (err) {
    if (isTableMissingError(err, "beam_answer_log")) return;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[beamAnswerLog] failed to record answer log",
    );
  }
}

/**
 * Confirm an answer log row exists for this id AND belongs to this user. Used by
 * the feedback route so a verdict can only attach to the user's own real answer.
 * Returns false on any DB fault (fail-closed for feedback — better to drop a
 * verdict than attach it to nothing).
 */
export async function beamAnswerLogExistsForUser(id: string, userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: beamAnswerLogTable.id })
      .from(beamAnswerLogTable)
      .where(and(eq(beamAnswerLogTable.id, id), eq(beamAnswerLogTable.userId, userId)))
      .limit(1);
    return Boolean(row);
  } catch (err) {
    if (isTableMissingError(err, "beam_answer_log")) return false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[beamAnswerLog] failed to look up answer log",
    );
    return false;
  }
}

export type RecordBeamAnswerFeedbackInput = {
  answerLogId: string;
  tenantId?: string | null;
  userId?: string | null;
  rating: "down" | "up";
  reasonCode?: string | null;
  detail?: string | null;
};

/** Insert a feedback row. Throws table-missing as a typed signal for the route. */
export class BeamFeedbackUnavailableError extends Error {
  constructor() {
    super("beam_answer_feedback table is missing");
    this.name = "BeamFeedbackUnavailableError";
  }
}

export async function recordBeamAnswerFeedback(input: RecordBeamAnswerFeedbackInput): Promise<void> {
  try {
    await db.insert(beamAnswerFeedbackTable).values({
      answerLogId: input.answerLogId,
      tenantId: input.tenantId ?? null,
      userId: input.userId ?? null,
      rating: input.rating,
      reasonCode: input.reasonCode ?? null,
      detail: input.detail?.slice(0, 1000) ?? null,
    });
  } catch (err) {
    if (isTableMissingError(err, "beam_answer_feedback")) {
      throw new BeamFeedbackUnavailableError();
    }
    throw err;
  }
}

/** Canonical engine families, lowercased, for cheap membership tests. */
const SCENT_FAMILY_SET = new Set<string>(SCENT_FAMILIES as readonly string[]);
/** Upper bound on a learned dislike list so accumulated feedback can't bloat it. */
const MAX_DISLIKED_FAMILIES = 15;

/**
 * Extract the canonical scent families a turn explicitly asked to AVOID, off the
 * answer log's `derivedState.slots.avoid` (a comma-joined free-text list). Only
 * tokens that resolve to a real ScentFamily survive — free-text notes ("no
 * vanilla", "oud") that aren't families are dropped, never guessed into one.
 */
function avoidFamiliesFromDerivedState(derivedState: unknown): string[] {
  const state = derivedState as { slots?: { avoid?: unknown } } | null;
  const avoidRaw = state?.slots?.avoid;
  if (typeof avoidRaw !== "string" || !avoidRaw.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of avoidRaw.split(/[,;]/)) {
    const fam = part.trim().toLowerCase();
    if (!fam || seen.has(fam) || !SCENT_FAMILY_SET.has(fam)) continue;
    seen.add(fam);
    out.push(fam);
  }
  return out;
}

/**
 * A5-GAP3: read a user's accumulated feedback back into their scent-taste profile,
 * closing the previously write-only loop. Joins each down-vote to its
 * `beam_answer_log` row so the families the answer was scored against (the turn's
 * explicit `avoid` slot) come back as candidate dislike context, then aggregates
 * (see aggregateFeedbackPreferenceSignals) and applies the derived engine
 * preference axes + learned disliked families to user_settings.
 *
 * Non-destructive: the engine-preference axes only fill fields the user has NOT
 * explicitly set (null), and learned dislikes are MERGED into the existing
 * dislikedFamilies (deduped, capped) and never added to a family the user has
 * explicitly marked as preferred — so learning refines, never overrides, an
 * explicit choice.
 *
 * Fully best-effort: any DB fault, a missing feedback/log table, or an un-migrated
 * user_settings is swallowed so feedback recording is never blocked. Returns the
 * applied updates (empty when nothing changed) for observability/tests.
 */
export async function applyFeedbackToScentPreferences(
  userId: string,
  tenantId?: string | null,
): Promise<Record<string, unknown>> {
  try {
    // LEFT JOIN so a down-vote whose log row has rotated out of the 30-day buffer
    // still counts for the reason-code-only signals (it just carries no families).
    const rows = await db
      .select({
        rating: beamAnswerFeedbackTable.rating,
        reasonCode: beamAnswerFeedbackTable.reasonCode,
        derivedState: beamAnswerLogTable.derivedState,
      })
      .from(beamAnswerFeedbackTable)
      .leftJoin(beamAnswerLogTable, eq(beamAnswerFeedbackTable.answerLogId, beamAnswerLogTable.id))
      .where(eq(beamAnswerFeedbackTable.userId, userId))
      .limit(200);

    const feedbackRows: FeedbackRow[] = rows.map((row) => ({
      rating: row.rating,
      reasonCode: row.reasonCode,
      avoidFamilies: avoidFamiliesFromDerivedState(row.derivedState),
    }));

    const signals = aggregateFeedbackPreferenceSignals(feedbackRows);
    if (Object.keys(signals).length === 0) return {};

    // Read the current profile: engine axes (only fill when unset) and the
    // existing liked/disliked families (so a merge can't override an explicit
    // like or duplicate an existing dislike).
    const [existing] = await db
      .select({
        lasts: userSettingsTable.scentLastsOnMe,
        projection: userSettingsTable.projectionPreference,
        preferred: userSettingsTable.preferredFamilies,
        disliked: userSettingsTable.dislikedFamilies,
      })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, userId))
      .limit(1);

    const updates: Record<string, unknown> = {};
    if (signals.projectionPreference && !existing?.projection) {
      updates.projectionPreference = signals.projectionPreference;
    }
    if (signals.scentLastsOnMe && !existing?.lasts) {
      updates.scentLastsOnMe = signals.scentLastsOnMe;
    }

    if (signals.dislikedFamilies && signals.dislikedFamilies.length > 0) {
      const preferredSet = new Set<string>(
        (Array.isArray(existing?.preferred) ? existing.preferred : []).map((f) => f.toLowerCase()),
      );
      const merged: string[] = [];
      const seen = new Set<string>();
      // Keep existing dislikes first (stable order), then append new ones.
      for (const fam of Array.isArray(existing?.disliked) ? existing.disliked : []) {
        const norm = String(fam).toLowerCase();
        if (!SCENT_FAMILY_SET.has(norm) || seen.has(norm)) continue;
        seen.add(norm);
        merged.push(norm);
      }
      let changed = false;
      for (const fam of signals.dislikedFamilies) {
        // Never blacklist a family the user explicitly likes; never duplicate.
        if (preferredSet.has(fam) || seen.has(fam)) continue;
        seen.add(fam);
        merged.push(fam);
        changed = true;
        if (merged.length >= MAX_DISLIKED_FAMILIES) break;
      }
      if (changed) {
        updates.dislikedFamilies = merged.slice(0, MAX_DISLIKED_FAMILIES) as ScentFamily[];
      }
    }

    if (Object.keys(updates).length === 0) return {};

    await db
      .insert(userSettingsTable)
      .values({ tenantId: tenantId ?? null, userId, ...updates })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { ...updates, updatedAt: new Date() },
      });
    return updates;
  } catch (err) {
    if (
      isTableMissingError(err, "beam_answer_feedback") ||
      isTableMissingError(err, "user_settings")
    ) {
      return {};
    }
    // Undefined-column (pre-migration user_settings) and any other fault are
    // non-fatal — learning is best-effort.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[beamAnswerLog] failed to fold feedback into scent preferences",
    );
    return {};
  }
}
