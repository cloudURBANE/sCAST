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
 * it unit-tests without a DB. Only the reason codes that map cleanly to an engine
 * preference axis are acted on; the rest are left for richer future signals (they
 * lack the family context needed to safely adjust liked/disliked families here).
 *
 *   not_bold_enough → the user wants more presence → projectionPreference
 *     "noticeable", plus a "long" skin-longevity lean so the spray-count math
 *     reaches for more.
 *
 * Conservative: a signal must clear `minSignals` down-votes of a kind before it
 * changes anything, so a single grumpy tap can't reshape someone's profile.
 */
export type FeedbackPreferenceSignals = {
  projectionPreference?: "noticeable";
  scentLastsOnMe?: "long";
};

export function aggregateFeedbackPreferenceSignals(
  rows: ReadonlyArray<{ rating?: string | null; reasonCode?: string | null }>,
  minSignals = 2,
): FeedbackPreferenceSignals {
  let notBoldEnough = 0;
  for (const row of rows) {
    if (row.rating !== "down") continue;
    if (row.reasonCode === "not_bold_enough") notBoldEnough += 1;
  }

  const signals: FeedbackPreferenceSignals = {};
  if (notBoldEnough >= minSignals) {
    signals.projectionPreference = "noticeable";
    signals.scentLastsOnMe = "long";
  }
  return signals;
}
