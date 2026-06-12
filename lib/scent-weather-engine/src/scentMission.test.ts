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
  SCENT_MISSION_NODE_ORDER,
} from "./scentMission.ts";

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
  assert.equal(sanitized.nodes["wardrobe-sync"], "locked");
  assert.equal(sanitized.calibration.destination, undefined);
  assert.equal(sanitized.calibration.energy, "Confident");
  assert.equal(sanitized.premiumUnlocked, false);
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

test("node order constant matches the documented graph", () => {
  assert.deepEqual(SCENT_MISSION_NODE_ORDER, [
    "onboarding",
    "wardrobe-sync",
    "environment-scan",
    "resolution-standard",
    "resolution-premium",
  ]);
});
