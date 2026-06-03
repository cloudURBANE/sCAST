import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenMeteoWeather } from "./weatherService.ts";

test("normalizeOpenMeteoWeather maps current Open-Meteo conditions to the app weather contract", () => {
  const weather = normalizeOpenMeteoWeather({
    timezone: "America/Chicago",
    current: {
      temperature_2m: 78.4,
      relative_humidity_2m: 62,
      apparent_temperature: 80.1,
      is_day: 1,
      precipitation: 0,
      weather_code: 2,
      cloud_cover: 40,
      wind_speed_10m: 9.2,
      wind_direction_10m: 180,
      wind_gusts_10m: 14.5,
    },
  });

  assert.equal(weather.source, "open-meteo");
  assert.equal(weather.isLive, true);
  assert.equal(weather.temp, 78.4);
  assert.equal(weather.temperature_f, 78.4);
  assert.equal(weather.humidity, 62);
  assert.equal(weather.humidity_percent, 62);
  assert.equal(weather.condition, "Partly cloudy");
  assert.equal(weather.icon, "02d");
  assert.equal(weather.wind_speed_mph, 9.2);
  assert.equal(weather.location, "Chicago");
  assert.equal(weather.is_raining, false);
});

test("normalizeOpenMeteoWeather marks wet weather from WMO weather code and precipitation", () => {
  const weather = normalizeOpenMeteoWeather({
    timezone: "America/New_York",
    current: {
      temperature_2m: 48,
      relative_humidity_2m: 91,
      is_day: 0,
      precipitation: 0.04,
      weather_code: 61,
      wind_speed_10m: 5,
    },
  });

  assert.equal(weather.condition, "Slight rain");
  assert.equal(weather.icon, "10n");
  assert.equal(weather.location, "New York");
  assert.equal(weather.is_raining, true);
});

test("normalizeOpenMeteoWeather rejects responses without current conditions", () => {
  assert.throws(() => normalizeOpenMeteoWeather({ timezone: "America/Chicago" }), /current weather/);
});
