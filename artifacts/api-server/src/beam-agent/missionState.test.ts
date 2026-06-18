import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beamSessionStatePrompt,
  deriveBeamSessionState,
  inferPendingSlotFromAssistant,
  isDelegationPhrase,
} from "./missionState.ts";

test("parses a travel kit target with owned and new counts", () => {
  const state = deriveBeamSessionState(
    undefined,
    "I'm planning a trip to Tokyo and I need two fragrances to take with me and two new ones not in my collection yet",
  );

  assert.equal(state.slots.destination, "Tokyo");
  assert.equal(state.mission?.intent, "travel_kit");
  assert.equal(state.mission?.ownedCount, 2);
  assert.equal(state.mission?.newCount, 2);
});

test("parses the owned-lane count for 'to bring' phrasing without the noun 'fragrances'", () => {
  const state = deriveBeamSessionState(
    undefined,
    "Trip to Tokyo, two to bring with me and two new ones not in my collection",
  );

  assert.equal(state.slots.destination, "Tokyo");
  assert.equal(state.mission?.intent, "travel_kit");
  assert.equal(state.mission?.ownedCount, 2);
  assert.equal(state.mission?.newCount, 2);
});

test("keeps an active scent-direction question unresolved when the user gives an occasion", () => {
  const pending = inferPendingSlotFromAssistant("Should it feel citrusy, green, or aromatic?");
  const state = deriveBeamSessionState(undefined, "Work meeting", pending);

  assert.equal(pending, "direction");
  assert.equal(state.slots.occasion, "work");
  assert.equal(state.slots.direction, undefined);
  assert.equal(state.pendingSlot, "direction");
  assert.equal(state.pendingSlotUnanswered, true);
  assert.match(beamSessionStatePrompt(state), /active question is still unresolved: expected direction/i);
});

test("recognizes the reported fresh-versus-warm wording as a direction question", () => {
  assert.equal(
    inferPendingSlotFromAssistant("Would you prefer something fresh and subtle, or more presence and warmth?"),
    "direction",
  );
});

test("resolves the active slot only with an answer from the expected category", () => {
  const state = deriveBeamSessionState(undefined, "Green and aromatic", "direction");

  assert.equal(state.slots.direction, "green, aromatic");
  assert.equal(state.pendingSlot, undefined);
  assert.equal(state.pendingSlotUnanswered, undefined);
});

test("explicit delegation bypasses an unresolved preference slot", () => {
  const state = deriveBeamSessionState(undefined, "Recommend now with what you know. You decide.", "direction");

  assert.equal(state.userDelegatedChoice, true);
  assert.equal(state.pendingSlot, undefined);
  assert.equal(state.pendingSlotUnanswered, undefined);
});

test("does not double-count scent-family words as both vibe and direction", () => {
  const state = deriveBeamSessionState(undefined, "Clean, fresh, green citrus");

  assert.equal(state.slots.direction, "citrus, green");
  assert.equal(state.slots.vibe, undefined);
});

test("merges later month and vibe into an existing travel mission", () => {
  const first = deriveBeamSessionState(undefined, "Trip to Tokyo: 2 from my wardrobe and 2 new.");
  const second = deriveBeamSessionState(first, "August and artsy");

  assert.equal(second.slots.destination, "Tokyo");
  assert.equal(second.slots.month, "August");
  assert.equal(second.slots.vibe, "artsy");
  assert.equal(second.mission?.intent, "travel_kit");
  assert.equal(second.mission?.destination, "Tokyo");
  assert.equal(second.mission?.month, "August");
  assert.equal(second.mission?.ownedCount, 2);
  assert.equal(second.mission?.newCount, 2);
});

test("detects delegation phrases and preserves them in state", () => {
  assert.equal(isDelegationPhrase("idk you tell me"), true);
  const state = deriveBeamSessionState(undefined, "idk you tell me");
  assert.equal(state.userDelegatedChoice, true);
  assert.equal(state.mission?.userDelegatedChoice, true);
});

test("formats known slots and mission rules into a prompt clause", () => {
  const state = deriveBeamSessionState(undefined, "Trip to Tokyo: 2 from my wardrobe and 2 new in August, artsy");
  const prompt = beamSessionStatePrompt(state);
  assert.match(prompt, /Known so far: .*destination=Tokyo/i);
  assert.match(prompt, /month=August/i);
  assert.match(prompt, /ownedCount=2/i);
  assert.match(prompt, /beam_propose_collection/i);
});
