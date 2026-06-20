import assert from "node:assert/strict";
import test from "node:test";
import {
  applyScentMissionUpdates,
  completeScentMissionNode,
  createScentMissionState,
} from "@workspace/scent-weather-engine";
import {
  activeMissionNode,
  buildAgentReveal,
  buildMissionWardrobe,
  buildMissionWeather,
  FAST_FLEXIBLE_DESTINATION,
  FAST_FLEXIBLE_ENERGY,
  findWardrobeMatch,
  missionProgress,
  missionWithDefaultsForFast,
  proposalItemToFragrance,
  suggestedMissionChips,
} from "./scentMissionClient.ts";

test("buildMissionWardrobe projects local vault items into the bounded mission shape", () => {
  const items = buildMissionWardrobe([
    {
      id: "frag-1",
      _dbId: "row-1",
      name: "Oud Wood",
      brand: "Tom Ford",
      family: "Woody",
      concentration: "EDP",
      notes: ["rosewood", "cardamom"],
      pyramid: { top: ["cardamom"], heart: ["oud"], base: ["amber"] },
      performance: { sillage: 9, longevity: 8 },
    },
    // Legacy row: only product.name/brand.
    { id: "frag-2", product: { name: "Legacy Scent", brand: "Old House" } },
    // Nameless rows are dropped.
    { id: "frag-3" },
  ]);

  assert.equal(items.length, 2);
  const first = items[0]!;
  assert.equal(first.id, "frag-1");
  assert.equal(first.dbId, "row-1");
  assert.equal(first.brand, "Tom Ford");
  assert.deepEqual(first.families, ["Woody"]);
  assert.deepEqual(first.accords, ["rosewood", "cardamom", "oud", "amber"]);
  assert.equal(first.sillage, "strong");
  assert.equal(first.longevity, 8);

  assert.equal(items[1]!.name, "Legacy Scent");
  assert.equal(items[1]!.brand, "Old House");
});

test("buildMissionWeather maps WeatherContext aliases and keeps UV honest", () => {
  const weather = buildMissionWeather({
    temp: 81,
    humidity: 64,
    windSpeed: 9,
    description: "broken clouds",
    location: "Miami",
  });
  assert.equal(weather.temperature_f, 81);
  assert.equal(weather.humidity_percent, 64);
  assert.equal(weather.wind_speed_mph, 9);
  assert.equal(weather.condition, "broken clouds");
  assert.equal(weather.uv_index, null);

  assert.equal(buildMissionWeather({ uv_index: 6.5 }).uv_index, 6.5);
  assert.deepEqual(buildMissionWeather(null), {});
});

test("findWardrobeMatch prefers dbId, then client id, then brand+name", () => {
  const items = [
    { id: "a", _dbId: "row-a", name: "Aventus", brand: "Creed" },
    { id: "b", name: "Sauvage", brand: "Dior" },
    { id: "c", product: { name: "Layton", brand: "Parfums de Marly" } },
  ];

  assert.equal(
    findWardrobeMatch(items, { fragranceId: "zzz", dbId: "row-a", name: "Aventus" })?.id,
    "a",
  );
  assert.equal(findWardrobeMatch(items, { fragranceId: "b", name: "Wrong Name" })?.id, "b");
  assert.equal(
    findWardrobeMatch(items, { fragranceId: "zzz", name: "  LAYTON ", brand: "parfums de marly" })?.id,
    "c",
  );
  assert.equal(findWardrobeMatch(items, { fragranceId: "zzz", name: "Unknown" }), null);
});

test("proposalItemToFragrance projects a Beam pick into the Fragrance overlay shape", () => {
  const frag = proposalItemToFragrance({
    name: "Layton",
    brand: "Parfums de Marly",
    family: "Amber",
    notes: ["apple", "vanilla", "lavender"],
    accords: ["sweet", "vanilla", "spicy"],
    pyramid: { top: ["apple"], heart: ["lavender"], base: ["vanilla"] },
    scentVector: { freshness: 3, sweetness: 8, woodiness: 4, spice: 5, warmth: 7, musk: 4 },
    concentration: "EDP",
    imageUrl: "https://example.test/layton.webp",
  });

  assert.equal(frag.name, "Layton");
  assert.equal(frag.brand, "Parfums de Marly");
  assert.equal(frag.concentration, "EDP");
  assert.equal(frag.imageUrl, "https://example.test/layton.webp");
  assert.equal(frag.family, "Amber");
  assert.deepEqual(frag.scent_vector, {
    freshness: 3,
    sweetness: 8,
    woodiness: 4,
    spice: 5,
    warmth: 7,
    musk: 4,
  });
  assert.deepEqual(frag.pyramid, { top: ["apple"], heart: ["lavender"], base: ["vanilla"] });
  // A client id is always present so the overlay can key the (vault-less) pick.
  assert.ok(frag.id.startsWith("beam-"));
  // Image-less proposals still yield a renderable (empty-string) Fragrance.
  assert.equal(proposalItemToFragrance({ name: "X", brand: "Y", notes: [], accords: [] }).imageUrl, "");
});

test("buildAgentReveal scores a Beam pick client-side and carries a reason", () => {
  const item = {
    name: "Spicebomb Extreme",
    brand: "Viktor & Rolf",
    family: "Amber",
    notes: ["tobacco", "vanilla", "cinnamon"],
    accords: ["warm spicy", "sweet", "tobacco"],
    scentVector: { freshness: 1, sweetness: 7, woodiness: 5, spice: 9, warmth: 9, musk: 3 },
    performance: { sillage: 9, longevity: 9 },
    concentration: "EDP",
    description: "A warm, spicy tobacco signature for cold-weather nights.",
  };
  const calibration = { destination: "Night Out" as const, energy: "Confident" as const };

  const reveal = buildAgentReveal(item, calibration, {
    temperature_f: 41,
    humidity_percent: 55,
    wind_speed_mph: 6,
    condition: "clear",
  });

  // Fragrance projection survives the round-trip.
  assert.equal(reveal.fragrance.name, "Spicebomb Extreme");
  assert.equal(reveal.fragrance.brand, "Viktor & Rolf");
  // The weather engine produced a real recommendation (not a stub).
  assert.ok(Array.isArray(reveal.engine.best_scent_families));
  assert.ok(["low", "medium", "high", "overpowering_risk"].includes(reveal.engine.projection_risk));
  assert.ok(reveal.engine.spray_count.recommended >= reveal.engine.spray_count.min);
  // Reason prefers the proposal's own description when present.
  assert.equal(reveal.reason, "A warm, spicy tobacco signature for cold-weather nights.");

  // With no description, it falls back to the engine's explanation.
  const noDesc = buildAgentReveal({ ...item, description: undefined }, calibration, {
    temperature_f: 41,
  });
  assert.equal(noDesc.reason, noDesc.engine.explanation);
  assert.ok(noDesc.reason.length > 0);
});

test("activeMissionNode and missionProgress track node progression", () => {
  let state = createScentMissionState();
  assert.equal(activeMissionNode(state), "onboarding");
  assert.equal(missionProgress(state), 0);

  state = completeScentMissionNode(state, "onboarding");
  state = completeScentMissionNode(state, "wardrobe-sync");
  assert.equal(activeMissionNode(state), "environment-scan");
  assert.equal(missionProgress(state), 2 / 5);

  state = completeScentMissionNode(state, "environment-scan");
  state = completeScentMissionNode(state, "resolution-standard");
  // Premium is blocked, not active — nothing left to act on.
  assert.equal(activeMissionNode(state), null);
  assert.equal(missionProgress(state), 4 / 5);
});

test("activeMissionNode lets retryable blocked standard nodes run again", () => {
  let state = createScentMissionState();
  state = completeScentMissionNode(state, "onboarding");
  state = { ...state, nodes: { ...state.nodes, "wardrobe-sync": "blocked" } };

  assert.equal(activeMissionNode(state), "wardrobe-sync");

  state = {
    ...state,
    nodes: {
      ...state.nodes,
      "wardrobe-sync": "complete",
      "environment-scan": "complete",
      "resolution-standard": "complete",
      "resolution-premium": "blocked",
    },
  };
  assert.equal(activeMissionNode(state), null);
});

test("server node updates round-trip through applyScentMissionUpdates into UI state", () => {
  let state = createScentMissionState();
  state = applyScentMissionUpdates(
    state,
    [
      { nodeId: "onboarding", status: "complete" },
      { nodeId: "wardrobe-sync", status: "active" },
    ],
    { calibration: { destination: "Night Out", energy: "Social" } },
  );
  assert.equal(activeMissionNode(state), "wardrobe-sync");
  assert.equal(state.calibration.destination, "Night Out");
  assert.equal(state.premiumUnlocked, false);
});

test("suggestedMissionChips follow the active node and the resolved end state", () => {
  let state = createScentMissionState();
  assert.ok(suggestedMissionChips(state).length >= 2);

  for (const nodeId of ["onboarding", "wardrobe-sync", "environment-scan", "resolution-standard"] as const) {
    state = completeScentMissionNode(state, nodeId);
  }
  const chips = suggestedMissionChips(state);
  assert.ok(chips.some((chip) => /why this match/i.test(chip)));
});

/* ----------------------- Fast "just go" defaults ----------------------- */

test("Fast run with no occasion/mood fills flexible defaults and flags them as system-supplied", () => {
  const mission = createScentMissionState();
  assert.equal(mission.calibration.destination, undefined);
  assert.equal(mission.calibration.energy, undefined);

  const result = missionWithDefaultsForFast(mission);
  // It still produces a runnable calibration (the "just go" affordance survives)...
  assert.equal(result.mission.calibration.destination, FAST_FLEXIBLE_DESTINATION);
  assert.equal(result.mission.calibration.energy, FAST_FLEXIBLE_ENERGY);
  // ...but never claims the old misleading "Confident" mood as user intent...
  assert.notEqual(result.mission.calibration.energy, "Confident");
  // ...and reports that these were system defaults, not the user's choice.
  assert.equal(result.usedDefaults, true);
});

test("Fast run preserves a calibration the user actually set and does not flag defaults", () => {
  const mission = createScentMissionState();
  mission.calibration = { destination: "Work", energy: "Focused" };

  const result = missionWithDefaultsForFast(mission);
  assert.equal(result.usedDefaults, false);
  assert.deepEqual(result.mission.calibration, { destination: "Work", energy: "Focused" });
  // No false intent introduced.
  assert.notEqual(result.mission.calibration.destination, "Going Out");
  assert.notEqual(result.mission.calibration.energy, "Confident");
});

test("Fast run keeps a partially-set cue and only fills the missing half as a system default", () => {
  const mission = createScentMissionState();
  mission.calibration = { destination: "Date" };

  const result = missionWithDefaultsForFast(mission);
  assert.equal(result.usedDefaults, true);
  // The user's real cue is preserved verbatim...
  assert.equal(result.mission.calibration.destination, "Date");
  // ...the missing mood is filled with the flexible default, not "Confident".
  assert.equal(result.mission.calibration.energy, FAST_FLEXIBLE_ENERGY);
  assert.notEqual(result.mission.calibration.energy, "Confident");
});

test("Fast run keeps a mood the user set and only fills the missing occasion as a system default", () => {
  const mission = createScentMissionState();
  mission.calibration = { energy: "Confident" };

  const result = missionWithDefaultsForFast(mission);
  assert.equal(result.usedDefaults, true);
  // The user's real mood is preserved verbatim (the symmetric mirror of the
  // occasion-only case) — filling the missing half must never overwrite it...
  assert.equal(result.mission.calibration.energy, "Confident");
  // ...and the missing occasion is filled with the flexible default.
  assert.equal(result.mission.calibration.destination, FAST_FLEXIBLE_DESTINATION);
});
