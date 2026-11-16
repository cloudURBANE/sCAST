import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchOpenMeteoWeather } from './openMeteoWeather.ts';

test('maps the direct Open-Meteo fallback into the dashboard weather shape', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    timezone: 'America/Chicago',
    current: {
      temperature_2m: 72.4,
      relative_humidity_2m: 46,
      weather_code: 63,
      wind_speed_10m: 8.5,
    },
    hourly: { uv_index: [4.2] },
    daily: {
      time: ['2026-11-16'],
      weather_code: [63],
      temperature_2m_max: [75],
      temperature_2m_min: [55],
      temperature_2m_mean: [64],
      relative_humidity_2m_mean: [51],
      uv_index_max: [5],
      wind_speed_10m_max: [12],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  t.after(() => { globalThis.fetch = previousFetch; });

  const weather = await fetchOpenMeteoWeather(32.8, -96.5);
  assert.equal(weather.temp, 72.4);
  assert.equal(weather.condition, 'rain');
  assert.equal(weather.location, 'Chicago');
  assert.equal(weather.forecast?.[0]?.high, 75);
});
