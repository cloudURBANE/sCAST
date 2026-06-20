/**
 * Tests for captured-constraint enforcement (audit A2/A3): dislikes are captured
 * into the `avoid` slot and surfaced as a hard exclusion, and budget capture is
 * broadened (ranges, ceilings, qualitative words) and surfaced as a ceiling.
 *
 *   node --experimental-strip-types --test src/beam-agent/beamConstraints.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { beamSessionStatePrompt, deriveBeamSessionState } from "./missionState.ts";

test("captures hard dislikes into the avoid slot without polluting direction", () => {
  const state = deriveBeamSessionState(undefined, "I want something woody but no oud and nothing sweet");
  assert.match(state.slots.avoid ?? "", /oud/);
  assert.match(state.slots.avoid ?? "", /sweet/);
  // The positive direction still captures the wanted family, not the avoided ones.
  assert.match(state.slots.direction ?? "", /woody/);
  assert.doesNotMatch(state.slots.direction ?? "", /oud|sweet/);
});

test("a soft refinement ('less sweet') is NOT a hard dislike", () => {
  const state = deriveBeamSessionState(undefined, "make it a little less sweet please");
  assert.equal(state.slots.avoid, undefined);
});

test("avoid accumulates across turns", () => {
  const first = deriveBeamSessionState(undefined, "no oud please");
  const second = deriveBeamSessionState(first, "and avoid leather too");
  assert.match(second.slots.avoid ?? "", /oud/);
  assert.match(second.slots.avoid ?? "", /leather/);
});

test("surfaces avoid + budget as hard constraints in the session prompt", () => {
  const state = deriveBeamSessionState(undefined, "recommend something under $80, no oud");
  const prompt = beamSessionStatePrompt(state);
  assert.match(prompt, /Hard exclusion/i);
  assert.match(prompt, /oud/i);
  assert.match(prompt, /Budget constraint/i);
  assert.match(prompt, /\$80/);
});

test("broadened budget capture handles ranges, ceilings and qualitative words", () => {
  assert.equal(deriveBeamSessionState(undefined, "budget is $50-100").slots.budget, "$50-100");
  assert.equal(deriveBeamSessionState(undefined, "no more than 120 dollars").slots.budget, "$120");
  assert.equal(deriveBeamSessionState(undefined, "something affordable for daily wear").slots.budget, "Budget-friendly");
  assert.equal(deriveBeamSessionState(undefined, "happy to splurge on this one").slots.budget, "Premium");
  // "not cheap" must not register a budget-friendly constraint.
  assert.equal(deriveBeamSessionState(undefined, "not cheap, I want quality").slots.budget, undefined);
});
