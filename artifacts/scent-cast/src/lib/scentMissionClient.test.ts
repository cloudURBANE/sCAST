import assert from "node:assert/strict";
import test from "node:test";
import {
  applyScentMissionUpdates,
  completeScentMissionNode,
  createScentMissionState,
} from "@workspace/scent-weather-engine";
import {
  activeMissionNode,
  buildMissionWardrobe,
  buildMissionWeather,
  findWardrobeMatch,
  missionProgress,
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
