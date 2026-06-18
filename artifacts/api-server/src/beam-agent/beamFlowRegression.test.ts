/**
 * Beam Agent — concierge-flow regression harness.
 *
 * This is the cheap, deterministic gate that must stay green before any Beam
 * change reaches prod. It replays the exact "Tokyo / August / citrusy" travel-kit
 * transcript that shipped feeling like an over-eager questionnaire, and asserts
 * the deterministic brain now (a) captures everything the user said, (b) reaches
 * a ready-to-recommend state, and (c) trips the answer-quality gates the moment
 * the agent tries to keep interrogating instead of committing.
 *
 * It exercises ONLY pure functions (slot extraction + quality gates), so it runs
 * in milliseconds with no model call, no network, and no cost — runnable on every
 * commit and in CI. The model-in-the-loop behaviour is covered separately by
 * beamAgentLoop.test.ts.
 *
 *   node --experimental-strip-types --test src/beam-agent/beamFlowRegression.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBeamSessionState, isDelegationPhrase, pendingSlotSatisfiedBy } from "./missionState.ts";
import { buildSafeClarification, runAnswerQualityGates } from "./answerQualityGates.ts";
import type { BeamGroundedFragrance, BeamSessionState } from "./types.ts";

const noEvidence = { hadExternalEvidence: false } as const;

/** Replay the user side of the audited transcript, turn by turn. */
function tokyoAugustState() {
  const t1 = deriveBeamSessionState(
    undefined,
    "I'm planning a trip to Tokyo — two from my vault and two new ones, daytime exploring.",
  );
  const t2 = deriveBeamSessionState(t1, "August");
  const t3 = deriveBeamSessionState(t2, "citrusy");
  return { t1, t2, t3 };
}

test("captures destination + 2-owned/2-new kit from the opening message", () => {
  const { t1 } = tokyoAugustState();
  assert.equal(t1.slots.destination, "Tokyo");
  assert.equal(t1.mission?.intent, "travel_kit");
  assert.equal(t1.mission?.ownedCount, 2);
  assert.equal(t1.mission?.newCount, 2);
});

test("'citrusy' sets the scent-direction slot (the bug that kept the agent asking)", () => {
  // Regression: `\\bcitrus\\b` never matched "citrusy" (the trailing letter breaks
  // the word boundary), so direction stayed empty and the agent felt free to ask a
  // "fresh-green vs warm-spicy" follow-up that no gate caught.
  const { t3 } = tokyoAugustState();
  assert.match(t3.slots.direction ?? "", /citrus/i);
  assert.equal(t3.slots.month, "August");
  assert.equal(t3.mission?.intent, "travel_kit");
});

test("the over-asking citrus sub-style question is flagged once direction is known", () => {
  const { t3 } = tokyoAugustState();
  const substyleQuestion =
    "Do you prefer your citrus scents to lean more fresh and green, or warm and spicy?";
  const gate = runAnswerQualityGates(substyleQuestion, { ...noEvidence, sessionState: t3, groundedFragrances: [] });
  assert.equal(gate.passed, false);
  // Re-asking a known scent direction is the precise "over-questioning" signal.
  assert.ok(gate.violations.includes("redundant_clarification"), gate.violations.join(","));
  // A ready travel kit that names no bottles is also unfulfilled.
  assert.ok(gate.violations.includes("mission_unfulfilled"), gate.violations.join(","));
});

test("'Recommend now with what you know. You decide.' is treated as delegation", () => {
  assert.equal(isDelegationPhrase("Recommend now with what you know. You decide."), true);
  assert.equal(isDelegationPhrase("recommend now"), true);
  assert.equal(isDelegationPhrase("go ahead and pick"), true);
  assert.equal(isDelegationPhrase("up to you"), true);
  // Still not a delegation — a real answer.
  assert.equal(isDelegationPhrase("Green and aromatic"), false);
});

test("after delegation, another preference question is gated", () => {
  const { t3 } = tokyoAugustState();
  const delegated = deriveBeamSessionState(t3, "Recommend now with what you know. You decide.");
  assert.equal(delegated.userDelegatedChoice, true);

  const stillAsking = "What kind of nightlife are you thinking for the evenings?";
  const gate = runAnswerQualityGates(stillAsking, { ...noEvidence, sessionState: delegated, groundedFragrances: [] });
  assert.equal(gate.passed, false);
  assert.ok(gate.violations.includes("delegated_but_questioned"), gate.violations.join(","));
});

test("a fulfilled 2-owned + 2-new kit answer passes every gate", () => {
  const { t3 } = tokyoAugustState();
  const delegated = deriveBeamSessionState(t3, "Recommend now with what you know. You decide.");
  const grounded: BeamGroundedFragrance[] = [
    { canonicalName: "L'Eau d'Issey Pour Homme", brand: "Issey Miyake", owned: true },
    { canonicalName: "Acqua di Gio Profumo", brand: "Giorgio Armani", owned: true },
    { canonicalName: "Au The Vert", brand: "Bulgari", owned: false },
    { canonicalName: "Neroli Portofino", brand: "Tom Ford", owned: false },
  ];
  const answer =
    "From your vault, pack L'Eau d'Issey Pour Homme and Acqua di Gio Profumo for the Tokyo heat. " +
    "New to try: Au The Vert and Neroli Portofino — airy citrus that won't crowd a packed train. " +
    "They save only when you tap Add to vault.";
  const gate = runAnswerQualityGates(answer, { ...noEvidence, sessionState: delegated, groundedFragrances: grounded });
  assert.deepEqual(gate.violations, []);
  assert.equal(gate.passed, true);
});

test("a kit answer naming only one owned pick is unfulfilled", () => {
  const { t3 } = tokyoAugustState();
  const grounded: BeamGroundedFragrance[] = [
    { canonicalName: "L'Eau d'Issey Pour Homme", brand: "Issey Miyake", owned: true },
    { canonicalName: "Au The Vert", brand: "Bulgari", owned: false },
    { canonicalName: "Neroli Portofino", brand: "Tom Ford", owned: false },
  ];
  const answer = "Pack L'Eau d'Issey Pour Homme; new: Au The Vert and Neroli Portofino.";
  const gate = runAnswerQualityGates(answer, { ...noEvidence, sessionState: t3, groundedFragrances: grounded });
  assert.equal(gate.passed, false);
  assert.ok(gate.violations.includes("mission_unfulfilled"), gate.violations.join(","));
});

test("a vibe pending slot is satisfied by a direction answer (it does not stay pending)", () => {
  // Agent asked for 'vibe'; the user replied with a scent direction ('citrusy').
  // They are the same calibration dimension, so the pending question is answered.
  assert.equal(pendingSlotSatisfiedBy("vibe", { direction: "citrus" }), true);
  assert.equal(pendingSlotSatisfiedBy("direction", { vibe: "artsy" }), true);
  // A genuinely unrelated answer leaves it pending.
  assert.equal(pendingSlotSatisfiedBy("vibe", { month: "August" }), false);

  const state = deriveBeamSessionState({ slots: { destination: "Tokyo" } }, "citrusy", "vibe");
  assert.match(state.slots.direction ?? "", /citrus/i);
  assert.notEqual(state.pendingSlotUnanswered, true);
});

test("a direction-worded re-ask of a vibe question is not scored as abandonment", () => {
  const state: BeamSessionState = {
    slots: { destination: "Tokyo" },
    pendingSlot: "vibe",
    pendingSlotUnanswered: true,
  };
  const reask = "Want it to lean fresh and citrusy, or warm and woody?";
  const gate = runAnswerQualityGates(reask, { ...noEvidence, sessionState: state, groundedFragrances: [] });
  assert.ok(
    !gate.violations.includes("pending_slot_abandoned"),
    `unexpected abandonment: ${gate.violations.join(",")}`,
  );
});

test("an off-topic re-ask of a vibe question is still flagged as abandonment", () => {
  const state: BeamSessionState = {
    slots: { destination: "Tokyo" },
    pendingSlot: "vibe",
    pendingSlotUnanswered: true,
  };
  const offTopic = "What's your budget for this?";
  const gate = runAnswerQualityGates(offTopic, { ...noEvidence, sessionState: state, groundedFragrances: [] });
  assert.ok(gate.violations.includes("pending_slot_abandoned"), gate.violations.join(","));
});

test("buildSafeClarification produces a gate-safe re-ask for the pending slot", () => {
  const state: BeamSessionState = {
    slots: { destination: "Tokyo" },
    pendingSlot: "vibe",
    pendingSlotUnanswered: true,
  };
  const safe = buildSafeClarification(state);
  assert.ok(safe, "expected a fallback clarification");
  assert.match(safe ?? "", /```cues/);
  const gate = runAnswerQualityGates(safe ?? "", { ...noEvidence, sessionState: state, groundedFragrances: [] });
  assert.deepEqual(gate.violations, []);
});

test("buildSafeClarification refuses to ask once the user has delegated the choice", () => {
  const delegated: BeamSessionState = { slots: { destination: "Tokyo" }, userDelegatedChoice: true };
  assert.equal(buildSafeClarification(delegated), null);
});

test("a slot already known on a prior turn is never re-marked pending", () => {
  // direction captured earlier; the assistant's last question was classified 'vibe';
  // this turn answers neither — but direction already satisfies that calibration, so
  // the pending vibe must NOT reopen (it would make the agent re-ask a known value).
  const prev: BeamSessionState = { slots: { destination: "Paris", direction: "woody" } };
  const state = deriveBeamSessionState(prev, "it's for my partner", "vibe");
  assert.notEqual(state.pendingSlotUnanswered, true);
});

test("the safe net never re-asks a slot already captured (stale pending pointer)", () => {
  // Defense-in-depth: even a hand-built state with a stale pending pointer at an
  // already-known slot must not yield a redundant_clarification re-ask.
  const staleVibe: BeamSessionState = {
    slots: { destination: "Paris", direction: "woody" },
    pendingSlot: "vibe",
    pendingSlotUnanswered: true,
  };
  const safeVibe = buildSafeClarification(staleVibe);
  if (safeVibe) {
    const gate = runAnswerQualityGates(safeVibe, { ...noEvidence, sessionState: staleVibe, groundedFragrances: [] });
    assert.deepEqual(gate.violations, [], safeVibe);
  }

  const staleMonth: BeamSessionState = {
    slots: { month: "June", occasion: "work" },
    pendingSlot: "month",
    pendingSlotUnanswered: true,
  };
  const safeMonth = buildSafeClarification(staleMonth);
  if (safeMonth) {
    const gate = runAnswerQualityGates(safeMonth, { ...noEvidence, sessionState: staleMonth, groundedFragrances: [] });
    assert.deepEqual(gate.violations, [], safeMonth);
  }
});

test("every deterministic safe clarification passes its own gates for each pending slot", () => {
  // Guard against a template ever drifting into a gate violation. For each slot,
  // build the state where that slot is pending and assert the canonical re-ask is clean.
  const slots = ["destination", "month", "occasion", "vibe", "direction", "projection", "impression", "budget"] as const;
  for (const slot of slots) {
    const state: BeamSessionState = { slots: {}, pendingSlot: slot, pendingSlotUnanswered: true };
    const safe = buildSafeClarification(state);
    assert.ok(safe, `expected a clarification for ${slot}`);
    const gate = runAnswerQualityGates(safe ?? "", { ...noEvidence, sessionState: state, groundedFragrances: [] });
    assert.deepEqual(gate.violations, [], `${slot} clarification violated: ${gate.violations.join(",")}`);
  }
});
