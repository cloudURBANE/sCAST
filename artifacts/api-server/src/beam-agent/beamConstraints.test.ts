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

/* ------------------------------------------------------------------ */
/* Stated-collection capture: "recommend only from what I told you I have" */
/* ------------------------------------------------------------------ */

// The live complaint, verbatim (voice-dictated, garbled names, run-on tail).
const STATED_LIST_MESSAGE =
  "I have Jean Lowe, casamorti mefisto, club de until intense and salvo and gentle fluidity slicer " +
  "and oud wonder and fucking fabulous by tom does compare to weather and understand best weather " +
  "for Chicago weather rn i have a fly ass black and whit fit on!!!!";

test("captures the fragrances the user LISTS as having, dictation and all", () => {
  const state = deriveBeamSessionState(undefined, STATED_LIST_MESSAGE);
  const stated = state.statedFragrances ?? [];
  assert.ok(stated.length >= 5, `expected a real list, got ${JSON.stringify(stated)}`);
  for (const expected of ["Jean Lowe", "casamorti mefisto", "gentle fluidity slicer", "oud wonder", "fucking fabulous by tom"]) {
    assert.ok(
      stated.some((item) => item.toLowerCase() === expected.toLowerCase()),
      `missing "${expected}" in ${JSON.stringify(stated)}`,
    );
  }
  // The outfit/weather tail must never be mistaken for fragrance names.
  for (const item of stated) {
    assert.doesNotMatch(item, /fit|whit|weather|black/i, `junk captured: "${item}"`);
  }
});

test("ownership figures of speech never register a stated list", () => {
  for (const message of [
    "I have a date tonight and I want something bold",
    "I have no idea, you tell me",
    "do I have anything that works for summer?",
    "I have work at 9 and dinner at 7",
    "I have oily skin and a sensitive nose",
  ]) {
    const state = deriveBeamSessionState(undefined, message);
    assert.equal(state.statedFragrances, undefined, message);
  }
});

test("the stated list is surfaced in the session prompt as the only candidate set", () => {
  const state = deriveBeamSessionState(undefined, STATED_LIST_MESSAGE);
  const prompt = beamSessionStatePrompt(state);
  assert.match(prompt, /ONLY from this stated list/);
  assert.match(prompt, /"casamorti mefisto"/);
  assert.match(prompt, /may be misspelled/i);
  assert.match(prompt, /exact flanker/i);
});

test("the correction turn sets statedOnly and keeps the prior list", () => {
  const first = deriveBeamSessionState(undefined, STATED_LIST_MESSAGE);
  const second = deriveBeamSessionState(first, "No focus on only the fragrances I told you I have rn");
  assert.equal(second.statedOnly, true);
  assert.ok((second.statedFragrances ?? []).some((item) => /casamorti mefisto/i.test(item)));
  const prompt = beamSessionStatePrompt(second);
  assert.match(prompt, /HARD CONSTRAINT/);
  assert.match(prompt, /focus only on the fragrances they said they have/i);
});

test("statedOnly registers even when no list was ever parsed", () => {
  const state = deriveBeamSessionState(undefined, "just the ones I mentioned please");
  assert.equal(state.statedOnly, true);
  assert.match(beamSessionStatePrompt(state), /HARD CONSTRAINT/);
});

test("the stated list survives unrelated follow-up turns", () => {
  const first = deriveBeamSessionState(undefined, STATED_LIST_MESSAGE);
  const second = deriveBeamSessionState(first, "make it something warm for tonight");
  assert.ok((second.statedFragrances ?? []).length >= 5);
});
