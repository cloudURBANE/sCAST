import assert from "node:assert/strict";
import test from "node:test";

import { mapOpenMeteoWeather, openMeteoWeatherCode } from "./weatherService.ts";

test("maps WMO weather codes into the dashboard icon contract", () => {
  assert.deepEqual(openMeteoWeatherCode(0), { condition: "clear sky", icon: "01d" });
  assert.deepEqual(openMeteoWeatherCode(63), { condition: "rain", icon: "10d" });
  assert.deepEqual(openMeteoWeatherCode(96), { condition: "thunderstorms", icon: "11d" });
});

test("normalizes Open-Meteo current conditions and seven-day columns", () => {
  const weather = mapOpenMeteoWeather({
    timezone: "America/Chicago",
    current: {
      temperature_2m: 58.1,
      relative_humidity_2m: 80,
      weather_code: 0,
    },
    hourly: { uv_index: [0] },
    daily: {
      time: ["2026-06-19"],
      weather_code: [63],
      temperature_2m_max: [73.2],
      temperature_2m_min: [55.6],
      temperature_2m_mean: [64.4],
      relative_humidity_2m_mean: [66],
      uv_index_max: [7.65],
    },
  });

  assert.deepEqual(weather, {
    temp: 58.1,
    humidity: 80,
    condition: "clear sky",
    icon: "01d",
    uv_index: 0,
    location: "Chicago",
    forecast: [{
      date: "2026-06-19T12:00:00",
      high: 73.2,
      low: 55.6,
      temp: 64.4,
      humidity: 66,
      condition: "rain",
      icon: "10d",
      uv_index: 7.65,
    }],
    isLive: true,
  });
});

test("rejects incomplete current conditions", () => {
  assert.equal(mapOpenMeteoWeather({ current: { temperature_2m: 70 } }), null);
});
