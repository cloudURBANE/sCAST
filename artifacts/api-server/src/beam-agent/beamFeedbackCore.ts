/**
 * Beam Agent — feedback payload validation (pure, dependency-free).
 *
 * Split out of the route so the accept/reject rules are unit-testable without a
 * server or DB. The fixed reason-code vocabulary is the contract the SPA's reason
 * chips mirror (beamAgentClient.ts `BEAM_FEEDBACK_REASONS`); every verdict maps to
 * a triageable bucket that can seed a regression fixture (audit §3.2 step 5).
 */

export const FEEDBACK_REASON_CODES = new Set([
  "wrong_vibe",
  "ignored_budget",
  "ignored_dislike",
  "too_generic",
  "unsafe_concern",
  "already_owned",
  "not_bold_enough",
  "bad_for_context",
  "other",
]);

export const FEEDBACK_RATINGS = new Set(["down", "up"]);

export type ValidatedBeamFeedback = {
  answerLogId: string;
  rating: "down" | "up";
  reasonCode: string | null;
  detail: string | null;
};

export type BeamFeedbackValidation =
  | { ok: true; value: ValidatedBeamFeedback }
  | { ok: false; status: number; code: string; error: string };

/** Validate a raw feedback request body. Never throws. */
export function validateBeamFeedbackInput(body: unknown): BeamFeedbackValidation {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const answerLogId = typeof record.answerLogId === "string" ? record.answerLogId.trim() : "";
  if (!answerLogId) {
    return { ok: false, status: 400, code: "missing_answer_log_id", error: "answerLogId is required." };
  }
  const rating =
    typeof record.rating === "string" && FEEDBACK_RATINGS.has(record.rating)
      ? (record.rating as "down" | "up")
      : "down";
  const rawReason = typeof record.reasonCode === "string" ? record.reasonCode.trim() : "";
  if (rawReason && !FEEDBACK_REASON_CODES.has(rawReason)) {
    return { ok: false, status: 400, code: "invalid_reason_code", error: "Unknown reasonCode." };
  }
  const reasonCode = rawReason || null;
  const detail =
    typeof record.detail === "string" && record.detail.trim() ? record.detail.trim().slice(0, 1000) : null;
  return { ok: true, value: { answerLogId, rating, reasonCode, detail } };
}

/**
 * A5-GAP3: fold a user's accumulated thumbs-down reason codes back into their
 * scent-taste profile — the feedback loop was write-only. Pure + deterministic so
 * it unit-tests without a DB.
 *
 * Two signal classes, both evidence-gated (no guessing from absence):
 *
 *   not_bold_enough → the user wants more presence → projectionPreference
 *     "noticeable", plus a "long" skin-longevity lean so the spray-count math
 *     reaches for more.
 *
 *   ignored_dislike → the answer recommended a family the user had EXPLICITLY
 *     asked to avoid on that turn. The avoided families ride on the down-voted
 *     answer's `beam_answer_log.derivedState.slots.avoid` (the caller joins the
 *     log and passes them in as `avoidFamilies`). A family that is down-voted
 *     this way `minSignals` times becomes a `dislikedFamilies` signal — a real,
 *     persisted avoidance the recommender repeatedly stepped on, never a guess.
 *     Rows without family context (the common case) simply contribute nothing
 *     here, so this is fully backward compatible with feedback that predates the
 *     join.
 *
 * Conservative: a signal must clear `minSignals` down-votes of a kind before it
 * changes anything, so a single grumpy tap can't reshape someone's profile.
 */
export type FeedbackPreferenceSignals = {
  projectionPreference?: "noticeable";
  scentLastsOnMe?: "long";
  /** Canonical ScentFamily names the user repeatedly down-voted as ignored. */
  dislikedFamilies?: string[];
};

/** A down-vote feedback row, optionally enriched with the avoided families that
 * the joined answer log recorded for that turn. */
export type FeedbackRow = {
  rating?: string | null;
  reasonCode?: string | null;
  /** Families this answer was down-voted over, from the log's `avoid` slot. */
  avoidFamilies?: readonly string[] | null;
};

/** Reason codes that, together with a recorded avoid-family, signal a dislike of
 * that family. Kept narrow: only verdicts that explicitly mean "you gave me a
 * thing I said I didn't want" count, so a generic "wrong vibe" never silently
 * blacklists a family. */
const FAMILY_DISLIKE_REASONS = new Set(["ignored_dislike"]);

export function aggregateFeedbackPreferenceSignals(
  rows: ReadonlyArray<FeedbackRow>,
  minSignals = 2,
): FeedbackPreferenceSignals {
  let notBoldEnough = 0;
  // family → number of distinct down-votes that stepped on it.
  const familyDownvotes = new Map<string, number>();

  for (const row of rows) {
    if (row.rating !== "down") continue;
    if (row.reasonCode === "not_bold_enough") notBoldEnough += 1;
    if (row.reasonCode && FAMILY_DISLIKE_REASONS.has(row.reasonCode) && Array.isArray(row.avoidFamilies)) {
      // De-dupe within a single feedback row so one answer that listed a family
      // twice counts once toward the threshold.
      const seen = new Set<string>();
      for (const raw of row.avoidFamilies) {
        if (typeof raw !== "string") continue;
        const fam = raw.trim().toLowerCase();
        if (!fam || seen.has(fam)) continue;
        seen.add(fam);
        familyDownvotes.set(fam, (familyDownvotes.get(fam) ?? 0) + 1);
      }
    }
  }

  const signals: FeedbackPreferenceSignals = {};
  if (notBoldEnough >= minSignals) {
    signals.projectionPreference = "noticeable";
    signals.scentLastsOnMe = "long";
  }
  const disliked = [...familyDownvotes.entries()]
    .filter(([, count]) => count >= minSignals)
    .map(([family]) => family)
    .sort();
  if (disliked.length > 0) {
    signals.dislikedFamilies = disliked;
  }
  return signals;
}
