import assert from "node:assert/strict";
import test from "node:test";
import { calculateScentWeatherRecommendation } from "./scentWeatherEngine.ts";

test("calculateScentWeatherRecommendation does not recommend zero sprays for wearable contexts", () => {
  const recommendation = calculateScentWeatherRecommendation({
    weather: {
      temperature_f: 92,
      humidity_percent: 88,
      wind_speed_mph: 0,
      is_raining: false,
      condition: "Hot and humid",
    },
    setting: { type: "work" },
    fragrance: {
      name: "Quiet Extrait",
      brand: "Example",
      concentration: "extrait de parfum",
      scent_families: ["fresh", "musky"],
      accords: ["clean musk"],
      sillage: "strong",
    },
    userPreference: {
      projectionPreference: "subtle",
    },
  });

  assert.notEqual(recommendation.wear_window, "avoid_today");
  assert.equal(recommendation.spray_count.recommended, 1);
  assert.equal(recommendation.spray_count.min, 1);
});

const richFragrance = {
  name: "Reference",
  brand: "Example",
  concentration: "eau de parfum",
  scent_families: ["woody", "amber"],
  accords: ["oud", "amber"],
} as const;

test("full real weather + recognized setting + families => high confidence", () => {
  const recommendation = calculateScentWeatherRecommendation({
    weather: {
      temperature_f: 68,
      humidity_percent: 45,
      wind_speed_mph: 3,
      is_raining: false,
      condition: "Clear",
      data_complete: true,
    },
    setting: { type: "work", recognized: true },
    fragrance: { ...richFragrance },
  });
  assert.equal(recommendation.confidence, "high");
});

test("data_complete:false demotes confidence even when numeric fields are finite", () => {
  // Simulates a failed weather fetch where the caller filled neutral defaults.
  const recommendation = calculateScentWeatherRecommendation({
    weather: {
      temperature_f: 72,
      humidity_percent: 50,
      wind_speed_mph: 0,
      is_raining: false,
      data_complete: false,
    },
    setting: { type: "work", recognized: true },
    fragrance: { ...richFragrance },
  });
  assert.notEqual(recommendation.confidence, "high");
});

test("recognized:false setting demotes confidence (unknown destination)", () => {
  const recommendation = calculateScentWeatherRecommendation({
    weather: {
      temperature_f: 68,
      humidity_percent: 45,
      wind_speed_mph: 3,
      is_raining: false,
      condition: "Clear",
      data_complete: true,
    },
    setting: { type: "mixed", recognized: false },
    fragrance: { ...richFragrance },
  });
  assert.notEqual(recommendation.confidence, "high");
});
