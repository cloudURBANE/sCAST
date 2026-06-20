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
