import assert from "node:assert/strict";
import test from "node:test";

import {
  composeCityLabel,
  mapOpenMeteoWeather,
  mapOwmDailyForecast,
  openMeteoWeatherCode,
} from "./weatherServiceCore.ts";

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
    provider: "open-meteo",
  });
});

test("rejects incomplete current conditions", () => {
  assert.equal(mapOpenMeteoWeather({ current: { temperature_2m: 70 } }), null);
});

test("resolves a precise US locality instead of the timezone city", () => {
  // The bug: Open-Meteo reports timezone "America/Chicago" for Forney, TX, so the
  // dashboard showed "Chicago". The Geo lookup yields the real locality label.
  assert.equal(composeCityLabel("Forney", "Texas", "US"), "Forney, Texas");
  assert.equal(composeCityLabel("London", "England", "GB"), "London");
  assert.equal(composeCityLabel("", "Texas", "US"), null);
  assert.equal(composeCityLabel(null, null, null), null);
});

test("maps OpenWeatherMap daily forecast into the SPA shape", () => {
  const forecast = mapOwmDailyForecast([
    {
      dt: 1_750_000_000,
      temp: { max: 88.2, min: 70.1, day: 80.4 },
      humidity: 55,
      uvi: 8.1,
      weather: [{ description: "scattered clouds", icon: "03d" }],
    },
  ]);
  assert.equal(forecast.length, 1);
  assert.equal(forecast[0].high, 88.2);
  assert.equal(forecast[0].low, 70.1);
  assert.equal(forecast[0].condition, "scattered clouds");
  assert.equal(forecast[0].icon, "03d");
  assert.equal(forecast[0].uv_index, 8.1);
  assert.match(forecast[0].date, /T12:00:00$/);
});
