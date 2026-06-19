import type { ScentMissionWeather } from '@workspace/scent-weather-engine';

/**
 * Client helpers for the weekly Scent Forecast dashboard. Pure-ish: the fetch and
 * localStorage reads are isolated here so the dashboard component stays declarative
 * and the per-day → engine-weather mapping can be unit-tested without React/DOM.
 */

/** One representative day, mirrored from the API `ForecastDay` shape. Temps are °F. */
export interface ForecastDay {
  dt: number;
  temp_high: number;
  temp_low: number;
  temp_day: number;
  humidity: number;
  wind_speed_mph: number;
  condition: string;
  main: string;
  icon: string;
  uv_index: number | null;
  pop: number;
}

export interface WeatherForecast {
  location: string;
  isLive: boolean;
  days: ForecastDay[];
  error?: string;
}

const WEATHER_LOCATION_STORAGE_KEY = 'scent_weather_location';
const RAIN_SIGNALS = ['rain', 'drizzle', 'storm', 'thunderstorm', 'snow', 'sleet'];

/** Read the same persisted coordinates the WeatherContext uses, so the forecast
 *  tracks the current-weather location without a second permission prompt. */
export function readStoredForecastCoords(): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(WEATHER_LOCATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lat?: unknown; lon?: unknown };
    const lat = typeof parsed.lat === 'number' ? parsed.lat : Number(parsed.lat);
    const lon = typeof parsed.lon === 'number' ? parsed.lon : Number(parsed.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

export async function fetchWeatherForecast(
  coords?: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<WeatherForecast> {
  const url = coords
    ? `/api/weather/forecast?lat=${encodeURIComponent(String(coords.lat))}&lon=${encodeURIComponent(String(coords.lon))}`
    : '/api/weather/forecast';
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Forecast request failed with ${response.status}`);
  }
  return (await response.json()) as WeatherForecast;
}

export function dayIsRaining(day: Pick<ForecastDay, 'main' | 'condition' | 'pop'>): boolean {
  const haystack = `${day.main} ${day.condition}`.toLowerCase();
  if (RAIN_SIGNALS.some((signal) => haystack.includes(signal))) return true;
  return day.pop >= 0.5;
}

/** Project a forecast day into the bounded weather shape the scent engine scores. */
export function forecastDayToMissionWeather(day: ForecastDay, location: string, isLive: boolean): ScentMissionWeather {
  return {
    temperature_f: day.temp_day,
    humidity_percent: day.humidity,
    wind_speed_mph: day.wind_speed_mph,
    is_raining: dayIsRaining(day),
    condition: day.condition,
    uv_index: day.uv_index,
    location,
    isLive,
  };
}

/** Short weekday label for the day rail; "Today"/"Tomorrow" for the first two. */
export function dayLabel(dt: number, index: number): string {
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  return new Date(dt * 1000).toLocaleDateString(undefined, { weekday: 'short' });
}

/** Tiny weekday glyph (Mon/Tue…) for the compact rail pills. */
export function dayShort(dt: number, index: number): string {
  if (index === 0) return 'Today';
  return new Date(dt * 1000).toLocaleDateString(undefined, { weekday: 'short' });
}
