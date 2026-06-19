import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beamSessionStatePrompt,
  deriveBeamSessionState,
  inferPendingSlotFromAssistant,
  isDelegationPhrase,
  sanitizeBeamSessionState,
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

test("parses a new-only Tokyo request and preserves Fresh as the scoring direction", () => {
  const first = deriveBeamSessionState(undefined, "I want two new fragrances for a trip to Tokyo in August");
  const state = deriveBeamSessionState(first, "Fresh");

  assert.equal(state.mission?.intent, "travel_kit");
  assert.equal(state.mission?.ownedCount, undefined);
  assert.equal(state.mission?.newCount, 2);
  assert.equal(state.slots.destination, "Tokyo");
  assert.equal(state.slots.month, "August");
  assert.equal(state.slots.direction, "lighter/fresh");
  const prompt = beamSessionStatePrompt(state);
  assert.match(prompt, /NEW-ONLY discovery mission/i);
  assert.match(prompt, /exactly 2 new unowned recommendation/i);
  assert.match(prompt, /Preserve destination=Tokyo and month=August/i);
});

test("parses 'a couple new fragrances' as a two-pick new-only travel mission", () => {
  const state = deriveBeamSessionState(
    undefined,
    "help me find a couple new fragrances for my august trip to tokyo.",
  );

  assert.equal(state.slots.destination, "tokyo");
  assert.equal(state.slots.month, "August");
  assert.equal(state.mission?.intent, "travel_kit");
  assert.equal(state.mission?.newCount, 2);
  assert.equal(state.mission?.destination, "tokyo");
  assert.equal(state.mission?.month, "August");
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

test("recognizes a direct 'what direction' prompt as a direction question", () => {
  assert.equal(
    inferPendingSlotFromAssistant("What direction are you leaning for the new picks?"),
    "direction",
  );
});

test("resolves the active slot only with an answer from the expected category", () => {
  const state = deriveBeamSessionState(undefined, "Green and aromatic", "direction");

  assert.equal(state.slots.direction, "green, aromatic");
  assert.equal(state.pendingSlot, undefined);
  assert.equal(state.pendingSlotUnanswered, undefined);
});

test("preserves multi-turn green, tea, warm, and aromatic direction refinements", () => {
  const first = deriveBeamSessionState(
    undefined,
    "help me find a couple new fragrances for my august trip to tokyo.",
  );
  const second = deriveBeamSessionState(
    first,
    "Green & tea",
    inferPendingSlotFromAssistant("What direction are you leaning for the new picks?"),
  );
  const third = deriveBeamSessionState(
    second,
    "warm and aromatic",
    inferPendingSlotFromAssistant("Do you prefer your green and tea fragrances to lean more fresh and crisp or warm and aromatic?"),
  );

  assert.equal(third.mission?.newCount, 2);
  assert.equal(third.slots.direction, "green, tea, aromatic, warm");
  assert.equal(third.pendingSlot, undefined);
  assert.equal(third.pendingSlotUnanswered, undefined);
  assert.match(beamSessionStatePrompt(third), /exactly 2 new unowned recommendation/i);
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

test("trip modifiers do not become destinations while explicit and prepositive places still parse", () => {
  assert.equal(deriveBeamSessionState(undefined, "I'm planning a business trip to Tokyo in August").slots.destination, "Tokyo");
  assert.equal(deriveBeamSessionState(undefined, "I'm planning a family trip to Tokyo in August").slots.destination, "Tokyo");
  assert.equal(deriveBeamSessionState(undefined, "I'm planning a Tokyo trip in August").slots.destination, "Tokyo");
  assert.equal(deriveBeamSessionState(undefined, "I'm planning a weekend trip").slots.destination, undefined);
  assert.equal(deriveBeamSessionState(undefined, "I'm taking a road trip").slots.destination, undefined);
  assert.equal(deriveBeamSessionState(undefined, "I have a meeting in the morning").slots.destination, undefined);
  assert.equal(deriveBeamSessionState(undefined, "I have a date in two weeks").slots.destination, undefined);
});

test("an explicit new mission does not inherit stale slots or delegation", () => {
  const first = deriveBeamSessionState(
    undefined,
    "Trip to Tokyo: 2 from my wardrobe and 2 new in August, artsy. You decide.",
  );
  const second = deriveBeamSessionState(
    first,
    "Now I need one new fragrance for a trip to Paris in September.",
  );

  assert.deepEqual(second.slots, { destination: "Paris", month: "September" });
  assert.equal(second.mission?.ownedCount, undefined);
  assert.equal(second.mission?.newCount, 1);
  assert.equal(second.userDelegatedChoice, undefined);
  assert.equal(second.mission?.userDelegatedChoice, undefined);
});

test("a new recommendation does not inherit delegation from a prior travel mission", () => {
  const first = deriveBeamSessionState(undefined, "Trip to Tokyo in August. You decide.");
  const second = deriveBeamSessionState(first, "What should I wear to work?");

  assert.equal(second.mission?.intent, "recommendation");
  assert.deepEqual(second.slots, { occasion: "work" });
  assert.equal(second.userDelegatedChoice, undefined);
});

test("a refinement of an already-presented kit preserves the mission, not a new recommendation", () => {
  const first = deriveBeamSessionState(undefined, "Trip to Tokyo: 2 from my wardrobe and 2 new in August, artsy.");
  // Simulate the loop marking the kit as delivered (the route persists this).
  const presented = { ...first, mission: { ...first.mission, kitPresented: true } };
  const refine = deriveBeamSessionState(presented, "Swap the Aventus pick for something cleaner.");

  // The generic verb "pick" must NOT downgrade the mission to a recommendation or
  // wipe the kit's destination/timing/counts.
  assert.equal(refine.mission?.intent, "travel_kit");
  assert.equal(refine.mission?.ownedCount, 2);
  assert.equal(refine.mission?.newCount, 2);
  assert.equal(refine.mission?.destination, "Tokyo");
  assert.equal(refine.mission?.kitPresented, true);
});

test("an explicit boundary after a presented kit still starts a fresh mission", () => {
  const first = deriveBeamSessionState(undefined, "Trip to Tokyo: 2 from my wardrobe and 2 new in August, artsy.");
  const presented = { ...first, mission: { ...first.mission, kitPresented: true } };
  const next = deriveBeamSessionState(presented, "Now what should I wear to work today?");

  assert.equal(next.mission?.intent, "recommendation");
  assert.equal(next.mission?.kitPresented, undefined);
  assert.equal(next.mission?.destination, undefined);
  assert.deepEqual(next.slots, { occasion: "work" });
});

test("sanitize preserves the kitPresented mission flag", () => {
  const sanitized = sanitizeBeamSessionState({
    slots: { destination: "Tokyo" },
    mission: { intent: "travel_kit", ownedCount: 2, newCount: 2, kitPresented: true },
  });
  assert.equal(sanitized.mission?.kitPresented, true);

  const noFlag = sanitizeBeamSessionState({
    slots: {},
    mission: { intent: "travel_kit", ownedCount: 2, newCount: 2 },
  });
  assert.equal(noFlag.mission?.kitPresented, undefined);
});

test("month corrections reject the negated month regardless of calendar order", () => {
  assert.equal(deriveBeamSessionState(undefined, "September, not August").slots.month, "September");
  assert.equal(deriveBeamSessionState(undefined, "Not August — September instead").slots.month, "September");
});

test("an unresolved choice between two months is not stored as authoritative state", () => {
  assert.equal(deriveBeamSessionState(undefined, "August or September").slots.month, undefined);
});

test("deterministic clarification chips resolve the slot that produced them", () => {
  const paris = deriveBeamSessionState(undefined, "Paris", "destination");
  assert.equal(paris.slots.destination, "Paris");
  assert.equal(paris.pendingSlotUnanswered, undefined);

  const warmPlace = deriveBeamSessionState(undefined, "Somewhere warm", "destination");
  assert.equal(warmPlace.slots.destination, "Somewhere warm");
  assert.equal(warmPlace.slots.direction, undefined);
  assert.equal(warmPlace.pendingSlotUnanswered, undefined);

  const summer = deriveBeamSessionState(undefined, "This summer", "month");
  assert.equal(summer.slots.month, "Summer");
  assert.equal(summer.pendingSlotUnanswered, undefined);

  const budget = deriveBeamSessionState(undefined, "Mid-range", "budget");
  assert.equal(budget.slots.budget, "Mid-range");
  assert.equal(budget.pendingSlotUnanswered, undefined);
});

test("stops the destination at a sentence boundary (the reported over-capture bug)", () => {
  const state = deriveBeamSessionState(
    undefined,
    "Recommend a couple new fragrances for my august trip to tokyo. You pick the direction — surprise me, and tell me why.",
  );

  assert.equal(state.slots.destination, "tokyo");
  assert.equal(state.mission?.destination, "tokyo");
});

test("preserves a 'St.' abbreviation in a multi-word place name", () => {
  const state = deriveBeamSessionState(undefined, "trip to St. Louis next month");

  assert.equal(state.slots.destination, "St. Louis");
});

test("captures a two-word destination and stops at the connector", () => {
  const state = deriveBeamSessionState(undefined, "trip to New York in spring");

  assert.equal(state.slots.destination, "New York");
});

test("locks in the comma-bounded 'Tokyo, Japan' capture", () => {
  const state = deriveBeamSessionState(undefined, "trip to Tokyo, Japan");

  assert.equal(state.slots.destination, "Tokyo");
});

test("does not truncate 'Washington D.C.' at the abbreviation dot", () => {
  const state = deriveBeamSessionState(undefined, "trip to Washington D.C.");

  // The reported failure mode is cutting at the first dot to "Washington D"; the
  // ≤2-letter rule preserves the abbreviation. (The pre-existing trailing-punct
  // strip drops the final period, which is unrelated to this fix.)
  assert.notEqual(state.slots.destination, "Washington D");
  assert.equal(state.slots.destination, "Washington D.C");
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
  assert.match(prompt, /beam_present_travel_kit/i);
});

test("captures common occasions the parser previously missed (the over-asking gap)", () => {
  // Each of these is an occasion users state plainly; before the fix none were
  // captured, so the agent re-asked "what's the occasion?" they had just answered.
  const cases: Array<[string, string]> = [
    ["Something for a party this weekend", "party"],
    ["I need a scent for a dinner tonight", "dinner"],
    ["What should I wear to a job interview?", "interview"],
    ["Heading to brunch with friends", "brunch"],
    ["A fragrance for a funeral", "funeral"],
    ["Picking something for my graduation", "graduation"],
    ["It's a first date, help me pick", "first date"],
  ];
  for (const [message, expected] of cases) {
    const state = deriveBeamSessionState(undefined, message);
    assert.equal(state.slots.occasion, expected, `"${message}" should capture occasion=${expected}`);
  }
});

test("classifies an occasion-worded assistant question as the occasion slot", () => {
  assert.equal(inferPendingSlotFromAssistant("Is this for work, a party, or a night out?"), "occasion");
  assert.equal(inferPendingSlotFromAssistant("Is it a wedding or a funeral?"), "occasion");
});

test("a known occasion captured this turn is not re-marked pending after an occasion question", () => {
  const pending = inferPendingSlotFromAssistant("What's the occasion — work, a party, or dinner?");
  assert.equal(pending, "occasion");
  const state = deriveBeamSessionState(undefined, "It's a dinner party", pending);
  assert.equal(state.slots.occasion, "dinner");
  assert.notEqual(state.pendingSlotUnanswered, true);
});
