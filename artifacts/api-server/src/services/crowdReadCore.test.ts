/**
 * Pure unit tests for the Crowd vs You scoring/eligibility core — no DB, no env.
 *   node --experimental-strip-types --test src/services/crowdReadCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CROWD_READ_MIN_VOTES,
  crowdReadAccuracy,
  crowdReadMinMargin,
  crowdReadOutcome,
  isCrowdReadEligible,
  isStreakContinuable,
  nextStreak,
  resolveCrowdLeader,
} from "./crowdReadCore.ts";

test("min margin floors at 2 and scales to 15% of total", () => {
  assert.equal(crowdReadMinMargin(0), 2);
  assert.equal(crowdReadMinMargin(8), 2); // ceil(1.2) = 2
  assert.equal(crowdReadMinMargin(20), 3); // ceil(3.0) = 3
  assert.equal(crowdReadMinMargin(100), 15);
});

test("eligibility requires both min votes and a stable lead", () => {
  // Under min votes — never eligible even with a wide gap.
  assert.equal(isCrowdReadEligible(CROWD_READ_MIN_VOTES - 1, 0), false);
  // Exactly min votes with a clear 2-gap (6 vs 2, margin 4 ≥ 2).
  assert.equal(isCrowdReadEligible(6, 2), true);
  // Enough votes but margin too thin (5 vs 4 at total 9, needs ≥2).
  assert.equal(isCrowdReadEligible(5, 4), false);
  // Tie is never eligible.
  assert.equal(isCrowdReadEligible(6, 6), false);
});

test("leader resolves only with a stable margin, else push (null)", () => {
  assert.equal(resolveCrowdLeader("a", 7, "b", 2), "a");
  assert.equal(resolveCrowdLeader("a", 2, "b", 7), "b");
  // Thin margin → push.
  assert.equal(resolveCrowdLeader("a", 5, "b", 4), null);
  // Tie → push.
  assert.equal(resolveCrowdLeader("a", 5, "b", 5), null);
  // No votes → push.
  assert.equal(resolveCrowdLeader("a", 0, "b", 0), null);
});

test("outcome: correct, wrong, push", () => {
  assert.equal(crowdReadOutcome("a", "a"), "correct");
  assert.equal(crowdReadOutcome("a", "b"), "wrong");
  assert.equal(crowdReadOutcome("a", null), "push");
});

test("streak: +1 correct, reset on wrong, unchanged on push", () => {
  assert.equal(nextStreak(3, "correct"), 4);
  assert.equal(nextStreak(3, "wrong"), 0);
  assert.equal(nextStreak(3, "push"), 3);
  assert.equal(nextStreak(0, "correct"), 1);
});

test("streak stays alive same-day and next-day, breaks on a skipped day", () => {
  assert.equal(isStreakContinuable(null, "2026-06-20"), true); // first ever
  assert.equal(isStreakContinuable("2026-06-20", "2026-06-20"), true); // same day
  assert.equal(isStreakContinuable("2026-06-19", "2026-06-20"), true); // yesterday
  assert.equal(isStreakContinuable("2026-06-18", "2026-06-20"), false); // skipped a day
  assert.equal(isStreakContinuable("2026-06-01", "2026-06-20"), false); // long gap
});

test("accuracy is an integer percent, 0 with no reads", () => {
  assert.equal(crowdReadAccuracy(0, 0), 0);
  assert.equal(crowdReadAccuracy(1, 2), 50);
  assert.equal(crowdReadAccuracy(2, 3), 67);
  assert.equal(crowdReadAccuracy(3, 3), 100);
});
