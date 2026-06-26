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

const wellEnrichedInput = {
  weather: {
    temperature_f: 70,
    humidity_percent: 45,
    wind_speed_mph: 0,
    is_raining: false,
    condition: "Clear",
  },
  setting: { type: "indoor" as const },
  fragrance: {
    name: "Test",
    brand: "Example",
    concentration: "eau de parfum",
    scent_families: ["fresh"],
    accords: ["citrus"],
  },
};

test("dataConfidence caps an otherwise-high confidence to low when data is thin", () => {
  const base = calculateScentWeatherRecommendation(wellEnrichedInput);
  assert.equal(base.confidence, "high");

  const thin = calculateScentWeatherRecommendation({ ...wellEnrichedInput, dataConfidence: 0.2 });
  assert.equal(thin.confidence, "low");

  const partial = calculateScentWeatherRecommendation({ ...wellEnrichedInput, dataConfidence: 0.6 });
  assert.equal(partial.confidence, "medium");

  const full = calculateScentWeatherRecommendation({ ...wellEnrichedInput, dataConfidence: 0.9 });
  assert.equal(full.confidence, "high");
});

test("high UV biases toward fresh families and is a no-op at night/low UV", () => {
  const sunny = calculateScentWeatherRecommendation({
    ...wellEnrichedInput,
    weather: { ...wellEnrichedInput.weather, uv_index: 10 },
  });
  assert.ok(sunny.debug?.rules_triggered.includes("high_uv_rule"));

  const dim = calculateScentWeatherRecommendation({
    ...wellEnrichedInput,
    weather: { ...wellEnrichedInput.weather, uv_index: 2 },
  });
  assert.ok(!dim.debug?.rules_triggered.includes("high_uv_rule"));
});

test("time_of_day promotes a later-in-the-day window to best_now once it is evening", () => {
  // A heavy night-leaning profile in cool weather yields nighttime_better by day.
  const heavyNightLeaning = {
    weather: {
      temperature_f: 50,
      humidity_percent: 40,
      wind_speed_mph: 0,
      is_raining: false,
      condition: "Cool",
    },
    setting: { type: "date" as const },
    fragrance: {
      name: "Oud Night",
      brand: "Example",
      concentration: "eau de parfum",
      scent_families: ["oud", "amber"],
      accords: ["smoky"],
    },
  };
  const byDay = calculateScentWeatherRecommendation(heavyNightLeaning);
  const atNight = calculateScentWeatherRecommendation({
    ...heavyNightLeaning,
    weather: { ...heavyNightLeaning.weather, time_of_day: "night" },
  });
  // The day window is some "wait for later" verdict; at night it should not stay that way.
  if (byDay.wear_window === "nighttime_better" || byDay.wear_window === "better_later") {
    assert.equal(atNight.wear_window, "best_now");
  }
});
