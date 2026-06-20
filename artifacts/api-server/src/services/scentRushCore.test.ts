import assert from "node:assert/strict";
import test from "node:test";
import {
  RUSH_CLIENT_VERSION, applyBestProgress, assertRunRedeemable, calculateRushScore,
  buildRushProgressSummary, cappedTotalBeamPower, createScentRushManifest, deriveRushOutcomes,
  eventDigest, generateFreshStartPlan, validateCompletion, type RushAction, type RushEventOutcome,
} from "./scentRushCore.ts";

const manifest = createScentRushManifest({
  fragranceId: "catalog:chanel:bleu", displayName: "Bleu de Chanel", family: "Woody Aromatic",
  notes: ["Grapefruit", "Incense", "Ginger", "Cedar"],
});
const plan = generateFreshStartPlan(2849201, manifest);

const successfulActions: RushAction[] = plan.map((event) => ({ type: "lane", atMs: event.atMs - 1, lane: event.lane }));
function successfulOutcomes(): RushEventOutcome[] { return deriveRushOutcomes(plan, successfulActions); }

test("Fresh Start completion is server-calculated and capped at two", () => {
  const events = successfulOutcomes();
  const calculated = calculateRushScore(plan, events);
  const result = validateCompletion(plan, {
    durationMs: 30_000, score: calculated.score, collectedOrbIds: calculated.collectedOrbIds,
    hazardsHit: calculated.hazardsHit, events, actions: successfulActions,
    eventDigest: eventDigest(events), clientVersion: RUSH_CLIENT_VERSION,
  }, { serverElapsedMs: 30_000 });
  assert.equal(result.beamPowerEarned, 2);
});

test("server scoring awards exact zero, one, and two Beam Power thresholds", () => {
  const thresholdPlan = [
    { id: "a", atMs: 1_000, lane: 0 as const, kind: "orb" as const, correct: true, scenarioCompatible: false },
    { id: "b", atMs: 2_000, lane: 1 as const, kind: "orb" as const, correct: true, scenarioCompatible: false },
    { id: "c", atMs: 3_000, lane: 2 as const, kind: "orb" as const, correct: true, scenarioCompatible: false },
  ];
  const outcome = (collected: number): RushEventOutcome[] => thresholdPlan.map((event, index) => ({
    eventId: event.id, atMs: event.atMs, outcome: index < collected ? "collected" : "missed",
  }));
  assert.equal(calculateRushScore(thresholdPlan, outcome(0)).beamPowerEarned, 0);
  assert.equal(calculateRushScore(thresholdPlan, outcome(2)).beamPowerEarned, 1);
  assert.equal(calculateRushScore(thresholdPlan, outcome(3)).beamPowerEarned, 2);
});

test("best-score progression upgrades only and cannot farm replays", () => {
  const first = applyBestProgress(null, { score: 900, performance: 0.5, beamPowerEarned: 1 });
  assert.deepEqual(first, { bestScore: 900, bestPerformance: 0.5, beamPower: 1 });
  assert.deepEqual(applyBestProgress(first, { score: 700, performance: 0.4, beamPowerEarned: 0 }), first);
  const higher = applyBestProgress(first, { score: 1500, performance: 0.8, beamPowerEarned: 2 });
  assert.deepEqual(higher, { bestScore: 1500, bestPerformance: 0.8, beamPower: 2 });
  assert.equal(applyBestProgress(higher, { score: 9999, performance: 1, beamPowerEarned: 5 }).beamPower, 2);
  assert.equal(cappedTotalBeamPower([2, 3, 99]), 10);
});

test("duplicate completion returns the completed state", () => {
  assert.equal(assertRunRedeemable(
    { userId: "u1", fragranceId: "f1", expiresAt: new Date(Date.now() + 1000), completedAt: new Date() },
    { userId: "u1", fragranceId: "f1" },
  ), "completed");
});

test("progress response keeps supporters distinct from capped user and aggregate power", () => {
  assert.deepEqual(buildRushProgressSummary(
    { supporters: "4", totalBeamPower: "17" },
    [
      { level: 1, bestScore: 1200, bestPerformance: 0.6, beamPower: 2 },
      { level: 2, bestScore: 1800, bestPerformance: 0.8, beamPower: 3 },
      { level: 3, bestScore: 2200, bestPerformance: 0.9, beamPower: 5 },
    ],
  ), {
    beamSupporters: 4, totalBeamPower: 17,
    user: { freshStartBeamPower: 2, freshStartBestScore: 1200, freshStartBestPerformance: 0.6, totalBeamPower: 10, maximumBeamPower: 10 },
  });
});

test("expired, wrong-user, wrong-fragrance, and impossible runs are rejected", () => {
  const base = { userId: "u1", fragranceId: "f1", expiresAt: new Date(Date.now() + 1000), completedAt: null };
  assert.throws(() => assertRunRedeemable(base, { userId: "u2", fragranceId: "f1" }), /wrong_user/);
  assert.throws(() => assertRunRedeemable(base, { userId: "u1", fragranceId: "f2" }), /wrong_fragrance/);
  assert.throws(() => assertRunRedeemable({ ...base, expiresAt: new Date(0) }, { userId: "u1", fragranceId: "f1" }), /expired_run/);
  const events = successfulOutcomes();
  const calculated = calculateRushScore(plan, events);
  assert.throws(() => validateCompletion(plan, {
    durationMs: 30_000, score: calculated.score + 1, collectedOrbIds: calculated.collectedOrbIds,
    hazardsHit: calculated.hazardsHit, events, actions: successfulActions,
    eventDigest: eventDigest(events), clientVersion: RUSH_CLIENT_VERSION,
  }), /impossible_score/);
  assert.throws(() => validateCompletion(plan, {
    durationMs: 30_000, score: calculated.score, collectedOrbIds: calculated.collectedOrbIds,
    hazardsHit: calculated.hazardsHit, events, actions: successfulActions,
    eventDigest: "0".repeat(64), clientVersion: RUSH_CLIENT_VERSION,
  }), /invalid_event_digest/);
  assert.throws(() => validateCompletion(plan, {
    durationMs: 30_000, score: calculated.score, collectedOrbIds: calculated.collectedOrbIds,
    hazardsHit: calculated.hazardsHit, events, actions: successfulActions,
    eventDigest: eventDigest(events), clientVersion: RUSH_CLIENT_VERSION,
  }, { serverElapsedMs: 5_000 }), /implausible_server_duration/);
});
