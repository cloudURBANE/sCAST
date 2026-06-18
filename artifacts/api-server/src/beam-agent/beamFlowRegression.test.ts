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
import { deriveBeamSessionState, isDelegationPhrase } from "./missionState.ts";
import { runAnswerQualityGates } from "./answerQualityGates.ts";
import type { BeamGroundedFragrance } from "./types.ts";

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
