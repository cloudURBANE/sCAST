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
import { beamSessionStatePrompt, deriveBeamSessionState, isDelegationPhrase, pendingSlotSatisfiedBy } from "./missionState.ts";
import { buildSafeClarification, runAnswerQualityGates } from "./answerQualityGates.ts";
import type { BeamGroundedFragrance, BeamSessionState } from "./types.ts";
import { catalogProfileSearchTerms, scoreCatalogProfileForQuery } from "../services/catalogProfileSearch.ts";
import type { ScentProfile } from "../services/scentEngineCore.ts";

const noEvidence = { hadExternalEvidence: false } as const;

function profile(overrides: Partial<ScentProfile>): ScentProfile {
  return {
    product: { name: "Test scent", brand: "Test house" },
    scent_vector: { freshness: 5, sweetness: 5, woodiness: 5, spice: 5, warmth: 5, musk: 5 },
    performance: { sillage: 5, longevity: 5 },
    context: { weather: [], occasion: [] },
    notes: [],
    family: "",
    concentration: "EDP",
    accords: [],
    ...overrides,
  };
}

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

test("a non-travel fallback does not invent a destination question", () => {
  const state: BeamSessionState = { slots: {}, mission: { intent: "recommendation" } };
  const safe = buildSafeClarification(state);
  assert.ok(safe);
  assert.doesNotMatch(safe ?? "", /where are you headed/i);
  assert.match(safe ?? "", /what you're after/i);
});

test("a travel fallback asks only for the next field required for readiness", () => {
  const state: BeamSessionState = {
    slots: { destination: "Tokyo", month: "August" },
    mission: { intent: "travel_kit", destination: "Tokyo", month: "August", ownedCount: 2, newCount: 2 },
  };
  const safe = buildSafeClarification(state);
  assert.ok(safe);
  assert.match(safe ?? "", /scent direction/i);
  assert.doesNotMatch(safe ?? "", /occasion|setting/i);
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

test("backtest: a plainly-stated occasion is captured and never re-asked", () => {
  // The non-travel analogue of the Tokyo over-asking regression: the user states a
  // common occasion the parser previously ignored ("dinner party"), so the agent
  // used to re-ask it. Assert (a) the slot is captured from free text, and (b) a
  // re-ask of that known occasion now trips the redundant-clarification gate.
  const state = deriveBeamSessionState(undefined, "What should I wear to a dinner party on Friday?");
  assert.equal(state.slots.occasion, "dinner");
  assert.equal(state.mission?.intent, "recommendation");

  const reAsk = "Happy to help — what's the occasion you're getting ready for?";
  const gate = runAnswerQualityGates(reAsk, { ...noEvidence, sessionState: state, groundedFragrances: [] });
  assert.equal(gate.passed, false);
  assert.ok(gate.violations.includes("redundant_clarification"), gate.violations.join(","));
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

test("backtest: hot humid Dallas rooftop request preserves all actionable facts", () => {
  const message = "I'm going to a rooftop party in Dallas tonight. It's hot and humid. I want something clean, attractive, and not too loud. I already own Dior Homme Sport Very Cool and Creed Himalaya. Pick one from my collection and one new fragrance to try.";
  const state = deriveBeamSessionState(undefined, message);
  assert.equal(state.slots.destination, "Dallas");
  assert.equal(state.slots.occasion, "party");
  assert.match(state.slots.direction ?? "", /lighter\/fresh/i);
  assert.equal(state.slots.projection, "moderate");
  assert.equal(state.slots.impression, "attractive");
  assert.equal(state.mission?.ownedCount, 1);
  assert.equal(state.mission?.newCount, 1);
  assert.equal(buildSafeClarification(state), null, "the complete request must not collapse into fixed clarification chips");
});

test("backtest: Tokyo August humidity request preserves place, timing, counts, and compound direction", () => {
  const message = "I'm planning a Tokyo trip in August. I need two fragrances to take with me and two new ones not in my collection. I want clean, modern, airy, slightly woody scents that work in humidity.";
  const state = deriveBeamSessionState(undefined, message);
  assert.equal(state.slots.destination, "Tokyo");
  assert.equal(state.slots.month, "August");
  assert.equal(state.slots.vibe, "modern");
  assert.match(state.slots.direction ?? "", /lighter\/fresh/i);
  assert.match(state.slots.direction ?? "", /woody/i);
  assert.equal(state.mission?.ownedCount, 2);
  assert.equal(state.mission?.newCount, 2);
  assert.equal(buildSafeClarification(state), null, "free text already supplied every readiness field");
});

test("catalog profile ranking understands vibe, weather, accords, family, and scent vectors", () => {
  const airyWoody = profile({
    scent_vector: { freshness: 9, sweetness: 2, woodiness: 7, spice: 2, warmth: 3, musk: 4 },
    family: "woody aromatic",
    notes: ["bergamot", "vetiver", "cedar"],
    accords: ["fresh", "green", "woody"],
    context: { weather: ["summer", "humid"], occasion: ["travel", "day"] },
    description: "A clean modern airy composition",
  });
  const denseGourmand = profile({
    scent_vector: { freshness: 1, sweetness: 10, woodiness: 1, spice: 5, warmth: 9, musk: 2 },
    family: "amber gourmand",
    notes: ["vanilla", "caramel"],
    accords: ["sweet", "warm"],
    context: { weather: ["winter"], occasion: ["evening"] },
  });
  const query = "clean modern airy slightly woody for hot humidity";
  assert.ok(scoreCatalogProfileForQuery(query, airyWoody) > scoreCatalogProfileForQuery(query, denseGourmand));
  assert.ok(scoreCatalogProfileForQuery(query, airyWoody) >= 0.7);
});

test("catalog profile ranking covers parser-supported families and freeform note terms", () => {
  const floralLeather = profile({ family: "floral leather", notes: ["rose", "patchouli", "suede"], accords: ["smoky", "mossy"] });
  const citrusTea = profile({ family: "citrus aromatic", notes: ["bergamot", "green tea"], accords: ["fresh", "ozonic"] });

  assert.ok(scoreCatalogProfileForQuery("floral leather rose patchouli", floralLeather) > 0.7);
  assert.ok(scoreCatalogProfileForQuery("citrus tea aquatic", citrusTea) > 0.7);
  assert.ok(catalogProfileSearchTerms("rose patchouli").includes("rose"));
  assert.ok(catalogProfileSearchTerms("rose patchouli").includes("patchouli"));
});

test("mixed brand and profile language retains the identity signal", () => {
  const vector = { freshness: 9, sweetness: 2, woodiness: 6, spice: 2, warmth: 3, musk: 4 };
  const creedFresh = profile({ product: { name: "Aventus Cologne", brand: "Creed" }, family: "fresh woody", accords: ["citrus", "green"], scent_vector: vector });
  const otherFresh = profile({ product: { name: "Fresh One", brand: "Other House" }, family: "fresh woody", accords: ["citrus", "green"], scent_vector: vector });

  assert.ok(scoreCatalogProfileForQuery("Creed fresh", creedFresh) > scoreCatalogProfileForQuery("Creed fresh", otherFresh));
});

test("acceptance: 'one new scent for Miami in July' captures the city without a trip verb", () => {
  // Regression: the destination parser only matched a place after a trip/travel
  // verb, so "for Miami in July" dropped the city and the agent re-asked "where
  // are you headed?" for a place the user already named. A proper-noun place named
  // right before a month/season is now captured.
  const state = deriveBeamSessionState(undefined, "I need one new scent for Miami in July, clean but sexy.");
  assert.equal(state.slots.destination, "Miami");
  assert.equal(state.slots.month, "July");
  assert.equal(state.mission?.newCount, 1);
  // Place + timing + direction are all present, so it must not collapse into a
  // fixed clarification asking for a city it already has.
  assert.equal(buildSafeClarification(state), null);
});

test("acceptance: an article/occasion is never mistaken for a city ('the office in July')", () => {
  // Proper-noun guard: lowercase candidates ("the office") must not become a
  // destination, or every "scent for the <thing> in <month>" would fabricate one.
  const state = deriveBeamSessionState(undefined, "I need a scent for the office in July.");
  assert.equal(state.slots.destination, undefined);
  assert.equal(state.slots.month, "July");
});

test("acceptance: 'three cold-weather date night scents' honors the requested quantity", () => {
  // Regression: plain (non-kit) recommendation requests dropped the count entirely,
  // so "give me three" could be answered with one. The recommendation mission now
  // carries the requested quantity.
  const state = deriveBeamSessionState(undefined, "Give me three cold-weather date night scents.");
  assert.equal(state.mission?.intent, "recommendation");
  assert.equal(state.mission?.count, 3);
  assert.equal(state.slots.occasion, "date night");
});

test("acceptance: a recommendation that returns one when three were asked is gated", () => {
  const state = deriveBeamSessionState(undefined, "Give me three cold-weather date night scents.");
  const grounded: BeamGroundedFragrance[] = [
    { canonicalName: "Tobacco Vanille", brand: "Tom Ford", owned: false },
    { canonicalName: "Pure Malt", brand: "Mugler", owned: false },
    { canonicalName: "Homme Intense", brand: "Dior", owned: false },
  ];
  const one = "For a cold-weather date night, reach for Tom Ford Tobacco Vanille.";
  const short = runAnswerQualityGates(one, { ...noEvidence, sessionState: state, groundedFragrances: grounded });
  assert.equal(short.passed, false);
  assert.ok(short.violations.includes("recommendation_count_short"), short.violations.join(","));

  const three = "Tom Ford Tobacco Vanille, Mugler Pure Malt, and Dior Homme Intense all hold up on a cold night.";
  const full = runAnswerQualityGates(three, { ...noEvidence, sessionState: state, groundedFragrances: grounded });
  assert.ok(!full.violations.includes("recommendation_count_short"), full.violations.join(","));
});

test("a 'two sprays' quantity is not mistaken for a requested pick count", () => {
  // The count parser is anchored on a fragrance noun, so an unrelated number
  // ("two sprays") must not set a recommendation quantity.
  const state = deriveBeamSessionState(undefined, "Should I do two sprays or three?");
  assert.equal(state.mission?.count, undefined);
});

/* ================================================================== */
/* Completion pass: the real ways users ask (deterministic matrix).    */
/* Each case asserts the parser/gate behaviour the live runtime relies */
/* on; the model never sees these, so they must be exact and cheap.    */
/* ================================================================== */

/** Simulate the loop having delivered a kit, the way the route persists it. */
function presentedTokyoKit(): BeamSessionState {
  const first = deriveBeamSessionState(
    undefined,
    "Plan a travel kit for Tokyo in August — two from my vault and two new ones, bold.",
  );
  return { ...first, mission: { ...first.mission, kitPresented: true } };
}

test("matrix/refinement: 'less sweet' does not invert into direction=sweet", () => {
  // A reduction cue ("less sweet", "no oud", "not too woody") is a constraint to
  // AVOID, so it must never be stored as the scent direction to chase — that pushed
  // the agent toward exactly the family the user wanted dialed back.
  const kit = presentedTokyoKit();
  const refined = deriveBeamSessionState(kit, "make it less sweet");
  assert.doesNotMatch(refined.slots.direction ?? "", /sweet/i);
  // The kit itself survives the refinement.
  assert.equal(refined.mission?.intent, "travel_kit");
  assert.equal(refined.mission?.newCount, 2);

  assert.equal(deriveBeamSessionState(undefined, "something less sweet").slots.direction, undefined);
  assert.match(
    deriveBeamSessionState(undefined, "I want it fresh but not too woody").slots.direction ?? "",
    /lighter\/fresh/i,
  );
  assert.doesNotMatch(
    deriveBeamSessionState(undefined, "I want it fresh but not too woody").slots.direction ?? "",
    /woody/i,
  );
  // A positive, un-negated family still parses normally.
  assert.match(deriveBeamSessionState(undefined, "warm and woody").slots.direction ?? "", /woody/i);
});

test("matrix/boundary: 'actually give me one date night scent' transitions off a presented kit", () => {
  // New occasion + explicit pick count is a NEW request, not a kit tweak — it must
  // not inherit the Tokyo trip's destination/timing/owned+new counts.
  const next = deriveBeamSessionState(presentedTokyoKit(), "actually give me one date night scent");
  assert.equal(next.mission?.intent, "recommendation");
  assert.equal(next.mission?.count, 1);
  assert.equal(next.slots.occasion, "date night");
  assert.equal(next.slots.destination, undefined);
  assert.equal(next.mission?.ownedCount, undefined);
  assert.equal(next.mission?.newCount, undefined);
});

test("matrix/boundary: 'forget that, pick a gym scent' resets the kit", () => {
  const next = deriveBeamSessionState(presentedTokyoKit(), "forget that, pick a gym scent");
  assert.equal(next.mission?.intent, "recommendation");
  assert.equal(next.slots.occasion, "gym");
  assert.equal(next.slots.destination, undefined);
});

test("matrix/boundary: a bare tweak still refines a presented kit (no false reset)", () => {
  // Guard the opposite failure: "make it lighter" / "swap the Aventus pick" carry NO
  // new occasion/destination/count, so they must stay refinements of the kit.
  for (const tweak of ["make it lighter", "swap the Aventus pick for something cleaner"]) {
    const refined = deriveBeamSessionState(presentedTokyoKit(), tweak);
    assert.equal(refined.mission?.intent, "travel_kit", tweak);
    assert.equal(refined.mission?.destination, "Tokyo", tweak);
    assert.equal(refined.mission?.newCount, 2, tweak);
  }
});

test("matrix/clarify: a bare count answer attaches to a recommendation mission", () => {
  // "How many?" → "two" / "make it three" / "give me exactly two": the terse reply
  // must set the recommendation count. A count with a noun-bearing tail ("two
  // sprays") is NOT a bare answer and must be ignored.
  const recBase = deriveBeamSessionState(undefined, "recommend some date night scents");
  assert.equal(recBase.mission?.intent, "recommendation");
  assert.equal(deriveBeamSessionState(recBase, "two").mission?.count, 2);
  assert.equal(deriveBeamSessionState(recBase, "make it three").mission?.count, 3);
  assert.equal(deriveBeamSessionState(recBase, "give me exactly two").mission?.count, 2);
  assert.equal(deriveBeamSessionState(recBase, "two sprays").mission?.count, undefined);
  // A travel kit is owned/new-ambiguous for a bare count, so it is left untouched.
  const kitBase = deriveBeamSessionState(undefined, "a travel kit for my trip to Tokyo");
  const kitTwo = deriveBeamSessionState(kitBase, "two");
  assert.equal(kitTwo.mission?.count, undefined);
});

test("matrix/destination: '<Place> trip' without a planning verb captures the city", () => {
  assert.equal(deriveBeamSessionState(undefined, "my Tokyo trip in August, two new").slots.destination, "Tokyo");
  assert.equal(deriveBeamSessionState(undefined, "a Berlin trip next month").slots.destination, "Berlin");
  // Trip-TYPE words are not places, even capitalized at a sentence start.
  assert.equal(deriveBeamSessionState(undefined, "I'm on a Business trip in March").slots.destination, undefined);
  assert.equal(deriveBeamSessionState(undefined, "planning a weekend trip").slots.destination, undefined);
});

test("matrix/destination: 'show me two scents for Tokyo in August' keeps count + city + month", () => {
  const state = deriveBeamSessionState(undefined, "show me two scents for Tokyo in August");
  assert.equal(state.mission?.intent, "recommendation");
  assert.equal(state.mission?.count, 2);
  assert.equal(state.slots.destination, "Tokyo");
  assert.equal(state.slots.month, "August");
});

test("matrix/delegation: terse delegation phrases all register", () => {
  for (const phrase of ["Pick for me.", "Surprise me.", "you decide", "recommend now"]) {
    assert.equal(isDelegationPhrase(phrase), true, phrase);
    assert.equal(deriveBeamSessionState(undefined, phrase).userDelegatedChoice, true, phrase);
  }
});

test("matrix/newness: 'two new ones not in my collection' forces a new-only kit", () => {
  // Whatever the surface verb, a new-count request must commit to NEW picks
  // (excludeOwned), never owned-wardrobe picks.
  const state = deriveBeamSessionState(undefined, "two new ones not in my collection");
  assert.equal(state.mission?.intent, "travel_kit");
  assert.equal(state.mission?.newCount, 2);
  assert.equal(state.mission?.ownedCount, undefined);
  const prompt = beamSessionStatePrompt(state);
  assert.match(prompt, /NEW-ONLY discovery mission/i);
  // Wardrobe-unavailable safety: the new-only contract must degrade gracefully
  // rather than block when the vault can't be read.
  assert.match(prompt, /assuming they are not already in their wardrobe/i);
});

// ---------------------------------------------------------------------------
// Matrix extension (this pass): season/climate timing, bare destination-before-
// time, conditional-purchase quantity guard, and the owned-vs-new recommendation
// lane. Each fix asserts both the trigger AND a non-trigger guard so a future
// change that over-reaches is caught.
// ---------------------------------------------------------------------------

test("matrix/season: a stated season is the timing fallback when no month is named", () => {
  assert.equal(deriveBeamSessionState(undefined, "a scent for this summer").slots.month, "Summer");
  assert.equal(deriveBeamSessionState(undefined, "something for the winter").slots.month, "Winter");
  assert.equal(deriveBeamSessionState(undefined, "a fragrance for spring").slots.month, "Spring");
  // Climate phrasing maps to the matching season.
  assert.equal(deriveBeamSessionState(undefined, "cold-weather fragrance").slots.month, "Winter");
  assert.equal(deriveBeamSessionState(undefined, "something for warm weather").slots.month, "Summer");
});

test("matrix/season: an explicit calendar month always wins over a climate word", () => {
  // "humid July" must resolve to July, not be overwritten by a Summer climate guess.
  assert.equal(deriveBeamSessionState(undefined, "something for humid July").slots.month, "July");
});

test("matrix/season GUARD: bare ambient temperature words are not a season", () => {
  // "warm"/"hot"/"cold" alone are scent directions/temperatures, not a stated season.
  assert.equal(deriveBeamSessionState(undefined, "I want something warm and cozy").slots.month, undefined);
  assert.equal(deriveBeamSessionState(undefined, "make it hotter and spicier").slots.month, undefined);
});

test("matrix/season GUARD: a negated season is not stored", () => {
  assert.equal(deriveBeamSessionState(undefined, "something fresh, not summer").slots.month, undefined);
});

test("matrix/destination: a bare city before a month/season is captured without a trip verb", () => {
  // "Tokyo August", "Miami this winter", "Paris in July" — no preposition or verb.
  const aug = deriveBeamSessionState(undefined, "Tokyo August");
  assert.equal(aug.slots.destination, "Tokyo");
  assert.equal(aug.slots.month, "August");

  const winter = deriveBeamSessionState(undefined, "Miami this winter");
  assert.equal(winter.slots.destination, "Miami");
  assert.equal(winter.slots.month, "Winter");

  const paris = deriveBeamSessionState(undefined, "Paris in July");
  assert.equal(paris.slots.destination, "Paris");
  assert.equal(paris.slots.month, "July");
});

test("matrix/destination GUARD: a sentence-initial command word is never a city", () => {
  // "Recommend August scents" must not store destination="Recommend".
  assert.equal(deriveBeamSessionState(undefined, "Recommend August scents").slots.destination, undefined);
  // "This summer" must not store destination="This".
  assert.equal(deriveBeamSessionState(undefined, "This summer please").slots.destination, undefined);
  // A lowercase generic noun before a month stays excluded.
  assert.equal(deriveBeamSessionState(undefined, "a scent for the office in July").slots.destination, undefined);
});

test("matrix/quantity GUARD: 'one bottle if I like it' is a purchase condition, not a pick count", () => {
  const state = deriveBeamSessionState(undefined, "one bottle if I like it");
  assert.equal(state.mission?.count, undefined);
  // A plain multi-pick count with no conditional still registers.
  assert.equal(deriveBeamSessionState(undefined, "give me two bottles").mission?.count, 2);
  // A multi-pick request keeps its count even with a trailing condition.
  assert.equal(deriveBeamSessionState(undefined, "three scents if I like the vibe").mission?.count, 3);
});

test("matrix/newness: 'avoid owned' / 'new to me' annotate a new-only recommendation", () => {
  for (const phrase of [
    "don't recommend anything I already own",
    "find me something new to me",
    "I don't own anything good, recommend one",
  ]) {
    const state = deriveBeamSessionState(undefined, phrase);
    assert.equal(state.mission?.intent, "recommendation", phrase);
    assert.equal(state.mission?.newness, "new", phrase);
    assert.match(beamSessionStatePrompt(state), /excludeOwned=true/i, phrase);
  }
});

test("matrix/newness: 'from my wardrobe' / 'one I already have' annotate an owned recommendation", () => {
  for (const phrase of ["pick from my wardrobe", "I want one I already have", "something from my collection"]) {
    const state = deriveBeamSessionState(undefined, phrase);
    assert.equal(state.mission?.intent, "recommendation", phrase);
    assert.equal(state.mission?.newness, "owned", phrase);
    assert.match(beamSessionStatePrompt(state), /ALREADY in the user's wardrobe/i, phrase);
  }
});

test("matrix/newness GUARD: a plain recommendation carries no newness annotation", () => {
  const state = deriveBeamSessionState(undefined, "recommend something for date night");
  assert.equal(state.mission?.intent, "recommendation");
  assert.equal(state.mission?.newness, undefined);
});

test("matrix/newness: an explicit new signal wins over an owned phrase in the same turn", () => {
  // A turn carrying both an owned cue ("one I already have") and a new cue ("new to
  // me") is contradictory; the new-only reading wins so the agent never recommends an
  // already-owned bottle by mistake. (A "collection/wardrobe + new" co-occurrence is a
  // separate path — it becomes a new-only travel kit, covered above.)
  const state = deriveBeamSessionState(undefined, "recommend something new to me, not one I already have");
  assert.equal(state.mission?.intent, "recommendation");
  assert.equal(state.mission?.newness, "new");
});

test("matrix/combined: city + season + newness resolve together", () => {
  const state = deriveBeamSessionState(undefined, "find me something new for Miami this winter");
  assert.equal(state.slots.destination, "Miami");
  assert.equal(state.slots.month, "Winter");
  assert.equal(state.mission?.intent, "recommendation");
  assert.equal(state.mission?.newness, "new");
});

// --- Exact reported failure: "Tokyo / August / bold" + "you decide" ----------
// The flow the Recommendation Commit Policy must make pass end-to-end at the
// deterministic layer: turn 1 states a bold two-new Tokyo-August trip; turn 2
// delegates ("Recommend now with what you know. You decide."). Beam must commit.

function tokyoBoldDecideState() {
  const t1 = deriveBeamSessionState(
    undefined,
    "Help me pick two new fragrances for a trip to Tokyo in August. I want smell bold.",
  );
  const t2 = deriveBeamSessionState(t1, "Recommend now with what you know. You decide.");
  return { t1, t2 };
}

const tokyoBoldGrounded: BeamGroundedFragrance[] = [
  { canonicalName: "Acqua di Giò Profumo", brand: "Giorgio Armani", owned: false },
  { canonicalName: "Mr Burberry", brand: "Burberry", owned: false },
];

test("tokyo-bold: opening message captures city, month, bold vibe, and a 2-new kit", () => {
  const { t1 } = tokyoBoldDecideState();
  assert.equal(t1.slots.destination, "Tokyo");
  assert.equal(t1.slots.month, "August");
  assert.equal(t1.slots.vibe, "bold");
  assert.equal(t1.mission?.intent, "travel_kit");
  assert.equal(t1.mission?.newCount, 2);
});

test("tokyo-bold: the follow-up is recognized as delegation and is preserved in state", () => {
  assert.equal(isDelegationPhrase("Recommend now with what you know. You decide."), true);
  const { t2 } = tokyoBoldDecideState();
  assert.equal(t2.userDelegatedChoice || t2.mission?.userDelegatedChoice, true);
  // The Tokyo/August/bold context survives the delegating turn (no state reset).
  assert.equal(t2.slots.destination, "Tokyo");
  assert.equal(t2.slots.month, "August");
});

test("tokyo-bold: a deferral after 'you decide' is rejected by the gates", () => {
  const { t2 } = tokyoBoldDecideState();
  for (const deferral of [
    "I'm not ready to commit yet — tell me more about your taste.",
    "I need more information before I can recommend two scents.",
    "I can't pick yet without knowing your budget.",
  ]) {
    const r = runAnswerQualityGates(deferral, { ...noEvidence, sessionState: t2, groundedFragrances: tokyoBoldGrounded });
    assert.equal(r.passed, false, deferral);
    assert.ok(
      r.violations.includes("commit_refusal") ||
        r.violations.includes("delegated_but_questioned") ||
        r.violations.includes("recommendation_without_grounded_pick") ||
        r.violations.includes("mission_unfulfilled"),
      `${deferral} -> ${JSON.stringify(r.violations)}`,
    );
  }
});

test("tokyo-bold: a confident two-pick answer that reasons about August humidity passes", () => {
  const { t2 } = tokyoBoldDecideState();
  const answer =
    "Based on what you gave me, I'm assuming hot, humid Tokyo days in August, so I went bold but " +
    "heat-safe. Pick 1: Acqua di Giò Profumo — a marine-woody projection that reads confident " +
    "without turning syrupy in humidity. Pick 2: Mr Burberry — a crisp woody contrast that still " +
    "carries. I steered clear of dense sweet ambers since heat amplifies them.";
  const r = runAnswerQualityGates(answer, { ...noEvidence, sessionState: t2, groundedFragrances: tokyoBoldGrounded });
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test("tokyo-bold: missing weather/wardrobe still produces a committable answer (no refusal needed)", () => {
  // Even with NO grounded vault picks and no weather echo, naming two new catalog
  // picks with stated assumptions satisfies every gate — assumptions, not refusal.
  const { t2 } = tokyoBoldDecideState();
  const answer =
    "Assuming a hot, humid August with no budget cap, I'd buy Acqua di Giò Profumo for a bold " +
    "marine projection and Mr Burberry for a crisp woody contrast.";
  const r = runAnswerQualityGates(answer, { ...noEvidence, sessionState: t2, groundedFragrances: tokyoBoldGrounded });
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

// --- Semantic delegation: many wordings, one typed signal -------------------
// The commit chain must NOT depend on a handful of exact phrases. Every wording
// below hands Beam the choice; each must (a) register as delegation, (b) carry
// the prior Tokyo/August/bold context forward unchanged (session memory), and
// (c) make a deferral answer fail the gates. These mirror the production
// phrasings users actually type to delegate.

const DELEGATION_WORDINGS = [
  "Recommend now with what you know. You decide.",
  "Surprise me.",
  "I trust you.",
  "Make the call.",
  "You choose.",
  "Pick for me.",
  "Just tell me what to wear.",
  "Use what you know about me.",
  "Don't ask me more questions.",
  "Choose the best option.",
  "Give me the answer.",
];

function tokyoBoldTurn1() {
  return deriveBeamSessionState(
    undefined,
    "Help me pick two new fragrances for a trip to Tokyo in August. I want smell bold.",
  );
}

test("semantic delegation: every wording registers AND preserves the trip context", () => {
  const t1 = tokyoBoldTurn1();
  for (const wording of DELEGATION_WORDINGS) {
    assert.equal(isDelegationPhrase(wording), true, `delegation: ${wording}`);
    const t2 = deriveBeamSessionState(t1, wording);
    assert.equal(t2.userDelegatedChoice || t2.mission?.userDelegatedChoice, true, `flag: ${wording}`);
    // Durable trip facts survive the delegating turn — no state reset, no re-gather.
    assert.equal(t2.slots.destination, "Tokyo", `dest: ${wording}`);
    assert.equal(t2.slots.month, "August", `month: ${wording}`);
    assert.equal(t2.slots.vibe, "bold", `vibe: ${wording}`);
  }
});

test("semantic delegation: a deferral after ANY delegating wording fails the gates", () => {
  const t1 = tokyoBoldTurn1();
  const deferral = "I'm not ready to commit yet — I need more info before I can recommend.";
  for (const wording of DELEGATION_WORDINGS) {
    const t2 = deriveBeamSessionState(t1, wording);
    const r = runAnswerQualityGates(deferral, { ...noEvidence, sessionState: t2, groundedFragrances: tokyoBoldGrounded });
    assert.equal(r.passed, false, `should reject deferral after: ${wording}`);
    assert.ok(
      r.violations.includes("commit_refusal") || r.violations.includes("recommendation_without_grounded_pick"),
      `${wording} -> ${JSON.stringify(r.violations)}`,
    );
  }
});

test("semantic delegation: a clarifying question after delegation is rejected (no re-interrogation)", () => {
  const t2 = deriveBeamSessionState(tokyoBoldTurn1(), "Don't ask me more questions.");
  const question = "Sure — do you prefer something fresher or warmer for the trip?";
  const r = runAnswerQualityGates(question, { ...noEvidence, sessionState: t2, groundedFragrances: tokyoBoldGrounded });
  assert.equal(r.passed, false);
  assert.ok(r.violations.includes("delegated_but_questioned"), JSON.stringify(r.violations));
});

test("memory: re-asking a remembered month after delegation is rejected", () => {
  const t2 = deriveBeamSessionState(tokyoBoldTurn1(), "You decide.");
  const reaskMonth = "Happy to help — which month are you traveling?";
  const r = runAnswerQualityGates(reaskMonth, { ...noEvidence, sessionState: t2, groundedFragrances: tokyoBoldGrounded });
  assert.equal(r.passed, false, JSON.stringify(r.violations));
  assert.ok(
    r.violations.includes("redundant_clarification") || r.violations.includes("delegated_but_questioned"),
    JSON.stringify(r.violations),
  );
});

test("memory: a delegated answer may commit to an OWNED wardrobe pick", () => {
  const t1 = deriveBeamSessionState(undefined, "What should I wear to work?");
  const t2 = deriveBeamSessionState(t1, "You decide.");
  const grounded: BeamGroundedFragrance[] = [{ canonicalName: "Sauvage", brand: "Dior", owned: true }];
  const answer =
    "From your vault, reach for Dior Sauvage today — its fresh-spicy ambroxan reads clean and confident at work.";
  const r = runAnswerQualityGates(answer, { ...noEvidence, sessionState: t2, groundedFragrances: grounded });
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});

test("non-Tokyo travel: a delegated Paris/September trip commits and rejects a deferral", () => {
  const t1 = deriveBeamSessionState(undefined, "I need two new fragrances for a trip to Paris in September. Something elegant.");
  const t2 = deriveBeamSessionState(t1, "You decide — surprise me.");
  assert.equal(t2.slots.destination, "Paris");
  assert.equal(t2.slots.month, "September");
  assert.equal(t2.userDelegatedChoice || t2.mission?.userDelegatedChoice, true);
  const grounded: BeamGroundedFragrance[] = [
    { canonicalName: "Dior Homme Intense", brand: "Dior", owned: false },
    { canonicalName: "Bleu de Chanel", brand: "Chanel", owned: false },
  ];
  const deferral = "I can't pick yet without a few more details about your taste.";
  const r = runAnswerQualityGates(deferral, { ...noEvidence, sessionState: t2, groundedFragrances: grounded });
  assert.equal(r.passed, false, JSON.stringify(r.violations));
  assert.ok(r.violations.includes("commit_refusal"), JSON.stringify(r.violations));
});

test("daily wear: 'what should I wear today' commits, and a zero-pick non-answer is rejected", () => {
  const state = deriveBeamSessionState(undefined, "What should I wear today?");
  assert.equal(state.mission?.intent, "recommendation");
  const grounded: BeamGroundedFragrance[] = [{ canonicalName: "Terre d'Hermès", brand: "Hermès", owned: true }];
  const committed =
    "Go with Terre d'Hermès today — its mineral-citrus woods suit a normal day and never overwhelm.";
  assert.equal(
    runAnswerQualityGates(committed, { ...noEvidence, sessionState: state, groundedFragrances: grounded }).passed,
    true,
  );
  const vague = "Honestly you can't go wrong with anything in your rotation.";
  const r = runAnswerQualityGates(vague, { ...noEvidence, sessionState: state, groundedFragrances: grounded });
  assert.equal(r.passed, false, JSON.stringify(r.violations));
  assert.ok(r.violations.includes("recommendation_without_grounded_pick"), JSON.stringify(r.violations));
});

test("education: a non-delegated 'how does X smell' question is NOT forced into a pick", () => {
  const question = "What does Aventus actually smell like?";
  assert.equal(isDelegationPhrase(question), false);
  const state = deriveBeamSessionState(undefined, question);
  assert.notEqual(state.mission?.intent, "travel_kit");
  // An educational answer that ends with a light, optional follow-up must NOT be
  // gate-failed: no delegation and no recommendation mission, so the commitment
  // gates stay silent. Education/comparison answers are explicitly allowed.
  const answer =
    "Aventus opens with a smoky pineapple over birch, then dries down to a dry, musky woods. " +
    "Want me to find one with a similar vibe?";
  const r = runAnswerQualityGates(answer, { ...noEvidence, sessionState: state, groundedFragrances: [] });
  assert.equal(r.passed, true, JSON.stringify(r.violations));
});
