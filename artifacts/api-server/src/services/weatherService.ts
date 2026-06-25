import axios from "axios";
import { logger } from "../lib/logger";
import { keepAliveHttpAgent, keepAliveHttpsAgent } from "../lib/keepAliveAgent";
import {
  type Coordinates,
  type WeatherForecastDay,
  type WeatherResponse,
  type OpenMeteoResponse,
  FORECAST_DAYS,
  composeCityLabel,
  fallbackWeather,
  finite,
  mapOpenMeteoWeather,
  mapOwmDailyForecast,
  resolveCoordinates,
  timezoneCity,
} from "./weatherServiceCore";

// Re-export the pure surface so existing importers (route, tests) keep one path.
export {
  type WeatherForecastDay,
  type WeatherResponse,
  mapOpenMeteoWeather,
  openMeteoWeatherCode,
} from "./weatherServiceCore";

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
// OpenWeatherMap is the keyed redundancy provider + the source of a precise city
// name. Open-Meteo's forecast endpoint only returns an IANA timezone (e.g.
// "America/Chicago"), so a user in Forney, TX renders as "Chicago" unless we
// resolve the real locality from coordinates. OWM's Geo API does that for free
// on the same key, so we reuse it both for the label and as a current-conditions
// fallback when Open-Meteo is unreachable.
const OWM_ONECALL_URL = "https://api.openweathermap.org/data/3.0/onecall";
const OWM_CURRENT_URL = "https://api.openweathermap.org/data/2.5/weather";
const OWM_REVERSE_GEO_URL = "https://api.openweathermap.org/geo/1.0/reverse";

/** Primary provider: current conditions plus the seven-day outlook from keyless Open-Meteo. */
async function getOpenMeteoWeather(coords: Coordinates): Promise<WeatherResponse | null> {
  const apiParams: Record<string, unknown> = {
    latitude: coords.lat,
    longitude: coords.lon,
    current: "temperature_2m,relative_humidity_2m,weather_code",
    hourly: "uv_index",
    forecast_hours: 1,
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "relative_humidity_2m_mean",
      "uv_index_max",
    ].join(","),
    temperature_unit: "fahrenheit",
    timezone: "auto",
    forecast_days: FORECAST_DAYS,
  };

  try {
    const response = await axios.get<OpenMeteoResponse>(OPEN_METEO_FORECAST_URL, {
      params: apiParams,
      timeout: 8000,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent,
    });
    return mapOpenMeteoWeather(response.data);
  } catch (err: any) {
    logger.warn({ status: err?.response?.status }, "[weather] Open-Meteo request failed; trying redundancy provider");
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenWeatherMap — keyed redundancy provider and precise-city-name resolver.
// ---------------------------------------------------------------------------

function owmApiKey(): string | null {
  const key = process.env.WEATHER_API_KEY?.trim();
  return key ? key : null;
}

/** Round to ~1km so nearby requests share one cached city label. */
function geoCacheKey(coords: Coordinates): string {
  return `${coords.lat.toFixed(2)}:${coords.lon.toFixed(2)}`;
}

// City names are effectively immutable, so a process-lifetime memo avoids a Geo
// lookup on every weather poll. Bounded so a busy multi-tenant server can't grow
// the map without limit.
const cityLabelCache = new Map<string, string | null>();
const CITY_LABEL_CACHE_LIMIT = 500;

function writeCityLabelCache(key: string, label: string | null): void {
  if (cityLabelCache.size >= CITY_LABEL_CACHE_LIMIT) {
    const oldest = cityLabelCache.keys().next().value;
    if (oldest !== undefined) cityLabelCache.delete(oldest);
  }
  cityLabelCache.set(key, label);
}

/**
 * Resolve the real locality for coordinates via OpenWeatherMap's free Geo API.
 * Returns null when no key is configured or the lookup fails — callers then keep
 * the timezone-derived label rather than blocking the weather response.
 */
async function resolveCityLabel(coords: Coordinates): Promise<string | null> {
  const apiKey = owmApiKey();
  if (!apiKey) return null;

  const cacheKey = geoCacheKey(coords);
  const cached = cityLabelCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const response = await axios.get(OWM_REVERSE_GEO_URL, {
      params: { lat: coords.lat, lon: coords.lon, limit: 1, appid: apiKey },
      timeout: 4000,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent,
    });
    const first = Array.isArray(response.data) ? response.data[0] : null;
    const label = first ? composeCityLabel(first.name, first.state, first.country) : null;
    writeCityLabelCache(cacheKey, label);
    return label;
  } catch (err: any) {
    logger.warn({ status: err?.response?.status }, "[weather] OpenWeatherMap reverse-geocode failed; keeping timezone label");
    // Don't cache transient failures, so a later poll retries the lookup.
    return null;
  }
}

/**
 * Redundancy provider: OpenWeatherMap current conditions (+ 7-day outlook when the
 * key has One Call 3.0). Mirrors the previous One Call → 2.5 fallback chain so a
 * free key still returns live current conditions when Open-Meteo is unreachable.
 */
async function getOpenWeatherMapWeather(coords: Coordinates, label: string | null): Promise<WeatherResponse | null> {
  const apiKey = owmApiKey();
  if (!apiKey) return null;

  const baseParams = { appid: apiKey, units: "imperial", lat: coords.lat, lon: coords.lon };

  try {
    const response = await axios.get(OWM_ONECALL_URL, {
      params: baseParams,
      timeout: 8000,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent,
    });
    const current = response.data?.current;
    const weather = Array.isArray(current?.weather) ? current.weather[0] : null;
    const temp = finite(current?.temp);
    const humidity = finite(current?.humidity);
    if (temp === null || humidity === null || !weather) throw new Error("incomplete one-call payload");
    return {
      temp,
      humidity,
      condition: typeof weather.description === "string" ? weather.description : "partly cloudy",
      icon: typeof weather.icon === "string" ? weather.icon : "02d",
      uv_index: finite(current?.uvi),
      location: label || timezoneCity(response.data?.timezone),
      forecast: mapOwmDailyForecast(response.data?.daily),
      isLive: true,
      provider: "openweathermap",
    };
  } catch (oneCallErr: any) {
    const status = oneCallErr?.response?.status;
    // 401/404 means the key lacks One Call 3.0 — drop to the always-free 2.5 endpoint.
    if (status && status !== 401 && status !== 404) {
      logger.warn({ status }, "[weather] OpenWeatherMap One Call failed");
      return null;
    }
    try {
      const res = await axios.get(OWM_CURRENT_URL, {
        params: baseParams,
        timeout: 8000,
        httpAgent: keepAliveHttpAgent,
        httpsAgent: keepAliveHttpsAgent,
      });
      const weather = Array.isArray(res.data?.weather) ? res.data.weather[0] : null;
      const temp = finite(res.data?.main?.temp);
      const humidity = finite(res.data?.main?.humidity);
      if (temp === null || humidity === null || !weather) return null;
      return {
        temp,
        humidity,
        condition: typeof weather.description === "string" ? weather.description : "partly cloudy",
        icon: typeof weather.icon === "string" ? weather.icon : "02d",
        uv_index: null,
        location: label || (typeof res.data?.name === "string" ? res.data.name : "Current Location"),
        forecast: [] as WeatherForecastDay[],
        isLive: true,
        provider: "openweathermap",
      };
    } catch (currentErr: any) {
      logger.warn({ status: currentErr?.response?.status }, "[weather] OpenWeatherMap current-conditions fallback failed");
      return null;
    }
  }
}

// Weather barely moves minute-to-minute, but the SPA polls on a timer, so every
// poll previously triggered a live 8s upstream round-trip. Cache the assembled
// payload per ~1km geo bucket for a few minutes so repeated polls (and multiple
// users in the same area) are served from memory. Only live results are cached —
// the simulated fallback must keep retrying the real providers. Bounded so a
// busy multi-tenant server can't grow the map without limit.
const WEATHER_PAYLOAD_TTL_MS = 5 * 60 * 1000;
const WEATHER_PAYLOAD_CACHE_LIMIT = 500;
const weatherPayloadCache = new Map<string, { value: WeatherResponse; expiresAt: number }>();

function readWeatherCache(key: string): WeatherResponse | null {
  const hit = weatherPayloadCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    weatherPayloadCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeWeatherCache(key: string, value: WeatherResponse): void {
  if (weatherPayloadCache.size >= WEATHER_PAYLOAD_CACHE_LIMIT) {
    const oldest = weatherPayloadCache.keys().next().value;
    if (oldest !== undefined) weatherPayloadCache.delete(oldest);
  }
  weatherPayloadCache.set(key, { value, expiresAt: Date.now() + WEATHER_PAYLOAD_TTL_MS });
}

/**
 * Current conditions plus the seven-day outlook with full provider redundancy.
 *
 * Primary: keyless Open-Meteo (drives the weekly outlook). The city label is
 * resolved from coordinates via OpenWeatherMap's Geo API in parallel so the
 * dashboard shows the real locality (e.g. "Forney, Texas") instead of the IANA
 * timezone city ("Chicago"). If Open-Meteo is unreachable we fall back to
 * OpenWeatherMap's own current conditions; if both fail, a simulated reading.
 */
export async function getWeather(params?: { lat?: number | string; lon?: number | string }): Promise<WeatherResponse> {
  const coords = resolveCoordinates(params?.lat, params?.lon);
  const cacheKey = geoCacheKey(coords);

  const cached = readWeatherCache(cacheKey);
  if (cached) return cached;

  const [primary, label] = await Promise.all([
    getOpenMeteoWeather(coords),
    resolveCityLabel(coords),
  ]);

  if (primary) {
    if (label) primary.location = label;
    writeWeatherCache(cacheKey, primary);
    return primary;
  }

  // Open-Meteo failed — use the redundant OpenWeatherMap provider.
  const fallback = await getOpenWeatherMapWeather(coords, label);
  if (fallback) {
    writeWeatherCache(cacheKey, fallback);
    return fallback;
  }

  return fallbackWeather("Weather Service Interrupted");
}
