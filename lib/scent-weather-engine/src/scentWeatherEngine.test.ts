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
