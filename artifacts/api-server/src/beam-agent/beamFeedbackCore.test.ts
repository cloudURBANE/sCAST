/**
 * Tests for the feedback payload validator (the report-this-answer loop).
 *
 *   node --experimental-strip-types --test src/beam-agent/beamFeedbackCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_REASON_CODES,
  validateBeamFeedbackInput,
  aggregateFeedbackPreferenceSignals,
} from "./beamFeedbackCore.ts";

test("accepts a valid downvote with a known reason code", () => {
  const result = validateBeamFeedbackInput({
    answerLogId: "run_abc",
    rating: "down",
    reasonCode: "ignored_budget",
    detail: "  asked for under $80  ",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.answerLogId, "run_abc");
  assert.equal(result.value.rating, "down");
  assert.equal(result.value.reasonCode, "ignored_budget");
  assert.equal(result.value.detail, "asked for under $80");
});

test("defaults rating to down and allows an omitted reason code", () => {
  const result = validateBeamFeedbackInput({ answerLogId: "run_x" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.rating, "down");
  assert.equal(result.value.reasonCode, null);
  assert.equal(result.value.detail, null);
});

test("rejects a missing answerLogId", () => {
  const missing = validateBeamFeedbackInput({ reasonCode: "too_generic" });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.status, 400);
  assert.equal(missing.code, "missing_answer_log_id");

  // Whitespace-only id is treated as missing too.
  const blank = validateBeamFeedbackInput({ answerLogId: "   " });
  assert.equal(blank.ok, false);
});

test("rejects an unknown reason code", () => {
  const result = validateBeamFeedbackInput({ answerLogId: "run_x", reasonCode: "totally_made_up" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.equal(result.code, "invalid_reason_code");
});

test("the reason-code vocabulary covers the documented buckets", () => {
  for (const code of ["wrong_vibe", "ignored_budget", "ignored_dislike", "already_owned", "other"]) {
    assert.ok(FEEDBACK_REASON_CODES.has(code), `missing reason code ${code}`);
  }
});

// --- A5-GAP3: feedback → preference fold -------------------------------------

test("aggregateFeedbackPreferenceSignals: repeated 'not bold enough' asks for more projection", () => {
  const signals = aggregateFeedbackPreferenceSignals([
    { rating: "down", reasonCode: "not_bold_enough" },
    { rating: "down", reasonCode: "not_bold_enough" },
  ]);
  assert.equal(signals.projectionPreference, "noticeable");
  assert.equal(signals.scentLastsOnMe, "long");
});

test("aggregateFeedbackPreferenceSignals: a single signal is below the floor (no change)", () => {
  assert.deepEqual(
    aggregateFeedbackPreferenceSignals([{ rating: "down", reasonCode: "not_bold_enough" }]),
    {},
  );
});

test("aggregateFeedbackPreferenceSignals: up-votes and other reasons do not move preferences", () => {
  assert.deepEqual(
    aggregateFeedbackPreferenceSignals([
      { rating: "up", reasonCode: "not_bold_enough" },
      { rating: "down", reasonCode: "too_generic" },
      { rating: "down", reasonCode: "wrong_vibe" },
    ]),
    {},
  );
});

test("aggregateFeedbackPreferenceSignals: a family ignored-disliked twice becomes a dislike signal", () => {
  const signals = aggregateFeedbackPreferenceSignals([
    { rating: "down", reasonCode: "ignored_dislike", avoidFamilies: ["oud"] },
    { rating: "down", reasonCode: "ignored_dislike", avoidFamilies: ["Oud", "woody"] },
  ]);
  // 'oud' appears across two distinct down-votes → above the floor; 'woody' only
  // once → below it. Casing is normalized.
  assert.deepEqual(signals.dislikedFamilies, ["oud"]);
});

test("aggregateFeedbackPreferenceSignals: a single ignored-dislike is below the family floor", () => {
  assert.deepEqual(
    aggregateFeedbackPreferenceSignals([
      { rating: "down", reasonCode: "ignored_dislike", avoidFamilies: ["oud"] },
    ]),
    {},
  );
});

test("aggregateFeedbackPreferenceSignals: family context only counts for dislike-shaped reasons", () => {
  // Same family surfaced twice but under generic reasons → no blacklist.
  assert.deepEqual(
    aggregateFeedbackPreferenceSignals([
      { rating: "down", reasonCode: "wrong_vibe", avoidFamilies: ["oud"] },
      { rating: "down", reasonCode: "too_generic", avoidFamilies: ["oud"] },
    ]),
    {},
  );
});

test("aggregateFeedbackPreferenceSignals: a single answer listing a family twice counts once", () => {
  assert.deepEqual(
    aggregateFeedbackPreferenceSignals([
      { rating: "down", reasonCode: "ignored_dislike", avoidFamilies: ["oud", "oud"] },
    ]),
    {},
  );
});
