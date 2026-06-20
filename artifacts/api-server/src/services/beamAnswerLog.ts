import { db } from "@workspace/db";
import { beamAnswerFeedbackTable, beamAnswerLogTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

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
