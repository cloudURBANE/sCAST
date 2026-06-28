import assert from "node:assert/strict";
import test from "node:test";
import {
  applyScentMissionUpdates,
  buildScentMissionEngineInput,
  completeScentMissionNode,
  createScentMissionState,
  diffScentMissionNodes,
  sanitizeScentMissionState,
  sanitizeScentMissionWardrobe,
  sanitizeScentMissionWeather,
  selectScentMissionRecommendation,
  rankScentMissionRecommendations,
  SCENT_MISSION_NODE_ORDER,
} from "./scentMission.ts";
import { deriveOutlookCandidate, idealWarmth } from "./weeklyOutlook.ts";
import { familyAlignmentScore, recommendationDisplayScore } from "./recommendationScore.ts";
import type { ScentWeatherRecommendation } from "./scentWeatherEngine.ts";

// --- A6-GAP2: shared scoring source of truth ---------------------------------

test("idealWarmth: monotonic, bounded, and gives genuinely cold days a gradient", () => {
  // Non-increasing and within [0,1] across the whole range.
  const temps = [0, 10, 20, 28, 40, 55, 70, 85, 95, 110];
  let prev = Infinity;
  for (const temperature_f of temps) {
    const w = idealWarmth({ temperature_f, humidity: 50, is_raining: false });
    assert.ok(w >= 0 && w <= 1, `idealWarmth(${temperature_f}) out of range: ${w}`);
    assert.ok(w <= prev + 1e-9, `idealWarmth must not increase with temperature (${temperature_f})`);
    prev = w;
  }

  // Before widening the cold floor, every sub-30°F day clamped to 30 → identical
  // ideal warmth, so an arctic morning and a frost ranked the vault the same.
  const arctic = idealWarmth({ temperature_f: 12, humidity: 50, is_raining: false });
  const frost = idealWarmth({ temperature_f: 28, humidity: 50, is_raining: false });
  assert.ok(arctic > frost, `colder day should want more warmth: ${arctic} vs ${frost}`);
  assert.ok(arctic - frost > 0.02, "cold days must separate by a usable margin");

  // Humidity and rain both nudge ideal warmth lower (toward fresh).
  const dry = idealWarmth({ temperature_f: 70, humidity: 30, is_raining: false });
  const muggy = idealWarmth({ temperature_f: 70, humidity: 90, is_raining: false });
  assert.ok(muggy < dry, "muggy air should lower ideal warmth");
  const clear = idealWarmth({ temperature_f: 55, humidity: 50, is_raining: false });
  const rainy = idealWarmth({ temperature_f: 55, humidity: 50, is_raining: true });
  assert.ok(rainy < clear, "rain should lower ideal warmth");
});

test("deriveOutlookCandidate places warm vs fresh traits on the thermal axis", () => {
  const warm = deriveOutlookCandidate({ id: "a", traits: ["amber", "oud", "vanilla"] });
  assert.ok(warm.warmth > warm.freshness, "amber/oud/vanilla → warm-leaning");

  const fresh = deriveOutlookCandidate({ id: "b", traits: ["citrus", "aquatic", "bergamot"] });
  assert.ok(fresh.freshness > fresh.warmth, "citrus/aquatic → fresh-leaning");

  // No resolvable tokens → neutral 0.5/0.5 (rank-safe).
  const neutral = deriveOutlookCandidate({ id: "c", traits: ["zorblax"] });
  assert.equal(neutral.warmth, 0.5);
  assert.equal(neutral.freshness, 0.5);
});

test("deriveOutlookCandidate: strong sillage + extrait lifts projection", () => {
  const c = deriveOutlookCandidate({ id: "a", traits: ["amber"], sillage: "strong", concentration: "Extrait" });
  assert.ok(c.projection > 0.8);
  const light = deriveOutlookCandidate({ id: "b", traits: ["citrus"], sillage: "light", concentration: "Eau de Cologne" });
  assert.ok(light.projection < 0.3);
});

test("familyAlignmentScore: display score + best/avoid/intent/energy weights", () => {
  const rec = {
    confidence: "high",
    projection_risk: "low",
    wear_window: "best_now",
    best_scent_families: [],
    avoid_scent_families: [],
  } as unknown as ScentWeatherRecommendation;
  // No hits → equals the display score (92 for high/low/best_now).
  assert.equal(recommendationDisplayScore(rec), 92);
  assert.equal(familyAlignmentScore({ recommendation: rec, traits: [] }), 92);
  // Intent + energy tag bonuses add 4 + 3.
  assert.equal(
    familyAlignmentScore({ recommendation: rec, traits: [], intentMatch: true, energyMatch: true }),
    99,
  );
});

test("familyAlignmentScore: liked families lift, disliked families sink (A5-GAP2)", () => {
  const rec = {
    confidence: "high",
    projection_risk: "low",
    wear_window: "best_now",
    best_scent_families: [],
    avoid_scent_families: [],
  } as unknown as ScentWeatherRecommendation;
  const woodyTraits = ["woody", "cedar", "sandalwood"];

  // A liked "woody" adds +10 over the 92 base.
  assert.equal(
    familyAlignmentScore({ recommendation: rec, traits: woodyTraits, preferredFamilies: ["woody"] }),
    102,
  );
  // A disliked "woody" subtracts 18 from the 92 base.
  assert.equal(
    familyAlignmentScore({ recommendation: rec, traits: woodyTraits, dislikedFamilies: ["woody"] }),
    74,
  );
  // A family the fragrance does not have moves nothing.
  assert.equal(
    familyAlignmentScore({ recommendation: rec, traits: woodyTraits, preferredFamilies: ["aquatic"] }),
    92,
  );
});

test("familyAlignmentScore: no taste profile == baseline (A5-GAP2 default-safe)", () => {
  // Default-safety contract: a user with no taste profile MUST score identically
  // to one with an empty/omitted profile, across a representative recommendation.
  const rec = {
    confidence: "medium",
    projection_risk: "medium",
    wear_window: "daytime_safe",
    best_scent_families: ["woody"],
    avoid_scent_families: ["aquatic"],
  } as unknown as ScentWeatherRecommendation;
  const traits = ["woody", "cedar", "spicy"];

  const baseline = familyAlignmentScore({ recommendation: rec, traits, intentMatch: true });
  // Omitting the fields entirely, passing empty arrays, and explicit empties all
  // reproduce the exact baseline — the modifier is purely additive.
  assert.equal(
    familyAlignmentScore({ recommendation: rec, traits, intentMatch: true, preferredFamilies: [], dislikedFamilies: [] }),
    baseline,
  );
  assert.equal(
    familyAlignmentScore({ recommendation: rec, traits, intentMatch: true, preferredFamilies: undefined, dislikedFamilies: undefined }),
    baseline,
  );
});

test("createScentMissionState starts with onboarding active and the rest locked", () => {
  const state = createScentMissionState();
  assert.equal(state.nodes.onboarding, "active");
  assert.equal(state.nodes["wardrobe-sync"], "locked");
  assert.equal(state.nodes["environment-scan"], "locked");
  assert.equal(state.nodes["resolution-standard"], "locked");
  assert.equal(state.nodes["resolution-premium"], "locked");
  assert.equal(state.premiumUnlocked, false);
});

test("completing nodes walks the graph in order", () => {
  let state = createScentMissionState();
  state = completeScentMissionNode(state, "onboarding");
  assert.equal(state.nodes.onboarding, "complete");
  assert.equal(state.nodes["wardrobe-sync"], "active");

  state = completeScentMissionNode(state, "wardrobe-sync");
  assert.equal(state.nodes["environment-scan"], "active");

  state = completeScentMissionNode(state, "environment-scan");
  assert.equal(state.nodes["resolution-standard"], "active");
});

test("premium resolution stays blocked (not active) when standard completes", () => {
  let state = createScentMissionState();
  for (const nodeId of ["onboarding", "wardrobe-sync", "environment-scan", "resolution-standard"] as const) {
    state = completeScentMissionNode(state, nodeId);
  }
  assert.equal(state.nodes["resolution-standard"], "complete");
  assert.equal(state.nodes["resolution-premium"], "blocked");
});

test("completing a locked or already-complete node is a no-op", () => {
  const state = createScentMissionState();
  assert.equal(completeScentMissionNode(state, "environment-scan"), state);

  const completed = completeScentMissionNode(state, "onboarding");
  assert.equal(completeScentMissionNode(completed, "onboarding"), completed);
});

test("a blocked standard node can be retried when the blocking condition clears", () => {
  let state = createScentMissionState();
  state = completeScentMissionNode(state, "onboarding");
  state = { ...state, nodes: { ...state.nodes, "wardrobe-sync": "blocked" } };

  const retried = completeScentMissionNode(state, "wardrobe-sync");
  assert.equal(retried.nodes["wardrobe-sync"], "complete");
  assert.equal(retried.nodes["environment-scan"], "active");
});

test("diffScentMissionNodes reports only changed nodes in graph order", () => {
  const prev = createScentMissionState();
  const next = completeScentMissionNode(prev, "onboarding");
  assert.deepEqual(diffScentMissionNodes(prev, next), [
    { nodeId: "onboarding", status: "complete" },
    { nodeId: "wardrobe-sync", status: "active" },
  ]);
  assert.deepEqual(diffScentMissionNodes(prev, prev), []);
});

test("applyScentMissionUpdates applies node updates and calibration patches but never unlocks premium", () => {
  const state = createScentMissionState();
  const next = applyScentMissionUpdates(
    state,
    [{ nodeId: "onboarding", status: "complete" }],
    { calibration: { destination: "Work" }, premiumUnlocked: true },
  );
  assert.equal(next.nodes.onboarding, "complete");
  assert.equal(next.calibration.destination, "Work");
  assert.equal(next.premiumUnlocked, false);
});

test("sanitizeScentMissionState rejects garbage and clamps invalid values", () => {
  assert.deepEqual(sanitizeScentMissionState(null), createScentMissionState());
  assert.deepEqual(sanitizeScentMissionState("nope"), createScentMissionState());

  const sanitized = sanitizeScentMissionState({
    nodes: {
      onboarding: "complete",
      "wardrobe-sync": "exploded",
      bogus: "active",
    },
    calibration: { destination: "Space", energy: "Confident" },
    premiumUnlocked: true,
  });
  assert.equal(sanitized.nodes.onboarding, "complete");
  assert.equal(sanitized.nodes["wardrobe-sync"], "active");
  assert.equal(sanitized.calibration.destination, undefined);
  assert.equal(sanitized.calibration.energy, "Confident");
  assert.equal(sanitized.premiumUnlocked, false);
});

test("sanitizeScentMissionState repairs impossible downstream active nodes", () => {
  const sanitized = sanitizeScentMissionState({
    nodes: {
      onboarding: "active",
      "wardrobe-sync": "complete",
      "environment-scan": "complete",
      "resolution-standard": "active",
      "resolution-premium": "active",
    },
  });

  assert.equal(sanitized.nodes.onboarding, "active");
  assert.equal(sanitized.nodes["wardrobe-sync"], "locked");
  assert.equal(sanitized.nodes["environment-scan"], "locked");
  assert.equal(sanitized.nodes["resolution-standard"], "locked");
  assert.equal(sanitized.nodes["resolution-premium"], "locked");
});

test("sanitizeScentMissionWardrobe drops invalid rows, dedupes traits, and bounds sizes", () => {
  const items = sanitizeScentMissionWardrobe([
    null,
    { id: "", name: "No Id" },
    { id: "a", name: "" },
    {
      id: "frag-1",
      dbId: "row-1",
      name: `  Oud Wood ${"x".repeat(300)}`,
      brand: "Tom Ford",
      concentration: "EDP",
      families: ["Woody", "woody", 42, "  "],
      accords: ["oud", "amber"],
      sillage: "strong",
      longevity: 8,
    },
  ]);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.id, "frag-1");
  assert.equal(item.dbId, "row-1");
  assert.ok(item.name.length <= 120);
  assert.deepEqual(item.families, ["Woody"]);
  assert.deepEqual(item.accords, ["oud", "amber"]);
  assert.equal(item.longevity, 8);

  const flood = sanitizeScentMissionWardrobe(
    Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, name: `Frag ${i}` })),
  );
  assert.equal(flood.length, 60);
});

test("sanitizeScentMissionWeather coerces aliases and treats missing UV as null", () => {
  const weather = sanitizeScentMissionWeather({
    temp: 88,
    humidity: 70,
    windSpeed: 4,
    description: "scattered clouds",
    uv_index: "9",
  });
  assert.equal(weather.temperature_f, 88);
  assert.equal(weather.humidity_percent, 70);
  assert.equal(weather.wind_speed_mph, 4);
  assert.equal(weather.condition, "scattered clouds");
  assert.equal(weather.uv_index, null);

  assert.equal(sanitizeScentMissionWeather({ uv_index: 7 }).uv_index, 7);
  assert.deepEqual(sanitizeScentMissionWeather(undefined), {});
});

test("buildScentMissionEngineInput maps destination to engine setting type", () => {
  const item = { id: "1", name: "Test" };
  assert.equal(buildScentMissionEngineInput(item, { destination: "Work" }, {}).setting.type, "work");
  assert.equal(buildScentMissionEngineInput(item, { destination: "Night Out" }, {}).setting.type, "night");
  assert.equal(buildScentMissionEngineInput(item, { destination: "Going Out" }, {}).setting.type, "mixed");
  assert.equal(buildScentMissionEngineInput(item, { destination: "Gym" }, {}).setting.type, "gym");
  assert.equal(buildScentMissionEngineInput(item, {}, {}).setting.type, "indoor");
});

test("selectScentMissionRecommendation prefers weather-aligned fragrances and is deterministic", () => {
  const hotHumid = { temperature_f: 92, humidity_percent: 80, wind_speed_mph: 2, is_raining: false };
  const wardrobe = [
    {
      id: "heavy",
      name: "Midnight Oud",
      brand: "Example",
      families: ["oud", "amber"],
      accords: ["oud", "tobacco", "vanilla"],
      sillage: "strong",
    },
    {
      id: "fresh",
      name: "Citrus Breeze",
      brand: "Example",
      families: ["citrus", "fresh"],
      accords: ["bergamot", "marine"],
      sillage: "light",
    },
  ];

  const winner = selectScentMissionRecommendation(wardrobe, { destination: "Going Out" }, hotHumid);
  assert.ok(winner);
  assert.equal(winner.fragranceId, "fresh");
  assert.equal(winner.name, "Citrus Breeze");
  assert.ok(winner.reason.length > 0);
  assert.equal(winner.engine.best_scent_families.length > 0, true);

  // Deterministic across calls.
  const again = selectScentMissionRecommendation(wardrobe, { destination: "Going Out" }, hotHumid);
  assert.deepEqual(again, winner);

  assert.equal(selectScentMissionRecommendation([], {}, hotHumid), null);
});

test("rankScentMissionRecommendations returns every bottle best-first and agrees with the single pick", () => {
  const hotHumid = sanitizeScentMissionWeather({ temperature_f: 92, humidity_percent: 80, condition: "Clear" });
  const wardrobe = sanitizeScentMissionWardrobe([
    { id: "heavy", name: "Midnight Oud", brand: "Example", families: ["oud", "amber"], accords: ["oud", "tobacco"], sillage: "strong" },
    { id: "fresh", name: "Citrus Breeze", brand: "Example", families: ["citrus", "fresh"], accords: ["bergamot", "marine"], sillage: "light" },
    { id: "mid", name: "Soft Linen", brand: "Example", families: ["aromatic"], accords: ["lavender"], sillage: "moderate" },
  ]);

  const ranked = rankScentMissionRecommendations(wardrobe, { destination: "Going Out" }, hotHumid);
  // One entry per bottle, sorted non-increasing by score.
  assert.equal(ranked.length, 3);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, "scores must be non-increasing");
  }
  // The fresh scent wins in hot/humid weather and the top of the ranking equals
  // the single-pick selector.
  assert.equal(ranked[0].fragranceId, "fresh");
  assert.deepEqual(
    selectScentMissionRecommendation(wardrobe, { destination: "Going Out" }, hotHumid),
    ranked[0],
  );

  assert.deepEqual(rankScentMissionRecommendations([], {}, hotHumid), []);
});

test("node order constant matches the documented graph", () => {
  assert.deepEqual(SCENT_MISSION_NODE_ORDER, [
    "onboarding",
    "wardrobe-sync",
    "environment-scan",
    "resolution-standard",
    "resolution-premium",
  ]);
});
