// Pure, dependency-free weather mapping logic. Kept separate from
// `weatherService.ts` (which pulls in axios + the logger) so it stays unit
// testable under `node --test` — mirroring the repo's `*Core.ts` convention.

export const FORECAST_DAYS = 7;

// London — the historical neutral default when a caller supplies no coordinates.
export const DEFAULT_LAT = 51.5074;
export const DEFAULT_LON = -0.1278;

type OpenMeteoCurrent = {
  temperature_2m?: unknown;
  relative_humidity_2m?: unknown;
  weather_code?: unknown;
  wind_speed_10m?: unknown;
};

type OpenMeteoHourly = {
  uv_index?: unknown;
};

type OpenMeteoDaily = {
  time?: unknown;
  weather_code?: unknown;
  temperature_2m_max?: unknown;
  temperature_2m_min?: unknown;
  temperature_2m_mean?: unknown;
  relative_humidity_2m_mean?: unknown;
  uv_index_max?: unknown;
  wind_speed_10m_max?: unknown;
};

export type OpenMeteoResponse = {
  timezone?: unknown;
  current?: OpenMeteoCurrent;
  hourly?: OpenMeteoHourly;
  daily?: OpenMeteoDaily;
};

type WeatherCodeDetails = {
  condition: string;
  icon: string;
};

export type WeatherForecastDay = {
  date: string;
  high: number | null;
  low: number | null;
  temp: number | null;
  humidity: number | null;
  condition: string;
  icon: string;
  uv_index: number | null;
  wind_speed_mph: number | null;
};

export type WeatherResponse = {
  temp: number;
  humidity: number;
  condition: string;
  icon: string;
  uv_index: number | null;
  wind_speed_mph: number | null;
  location?: string;
  forecast: WeatherForecastDay[];
  isLive: boolean;
  /** Which upstream produced the live reading: Open-Meteo, OpenWeatherMap, or none. */
  provider?: "open-meteo" | "openweathermap";
  error?: string;
};

export type Coordinates = { lat: number; lon: number };

export function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteAt(value: unknown, index: number): number | null {
  return finite(entries(value)[index]);
}

function textAt(value: unknown, index: number): string | null {
  const entry = entries(value)[index];
  return typeof entry === "string" && entry.trim() ? entry.trim() : null;
}

/** Coerce a caller-supplied coordinate into the requested range, or null. */
function coordinate(value: unknown, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** Resolve request coordinates, falling back to the neutral default location. */
export function resolveCoordinates(lat?: number | string, lon?: number | string): Coordinates {
  return {
    lat: coordinate(lat, -90, 90) ?? DEFAULT_LAT,
    lon: coordinate(lon, -180, 180) ?? DEFAULT_LON,
  };
}

/** Translate Open-Meteo WMO weather codes into the icon contract used by the SPA. */
export function openMeteoWeatherCode(code: number): WeatherCodeDetails {
  if (code === 0) return { condition: "clear sky", icon: "01d" };
  if (code === 1) return { condition: "mainly clear", icon: "02d" };
  if (code === 2) return { condition: "partly cloudy", icon: "02d" };
  if (code === 3) return { condition: "overcast", icon: "04d" };
  if (code === 45 || code === 48) return { condition: "fog", icon: "50d" };
  if (code >= 51 && code <= 57) return { condition: "drizzle", icon: "09d" };
  if (code >= 61 && code <= 67) return { condition: "rain", icon: "10d" };
  if (code >= 71 && code <= 77) return { condition: "snow", icon: "13d" };
  if (code >= 80 && code <= 82) return { condition: "rain showers", icon: "09d" };
  if (code === 85 || code === 86) return { condition: "snow showers", icon: "13d" };
  if (code >= 95) return { condition: "thunderstorms", icon: "11d" };
  return { condition: "partly cloudy", icon: "02d" };
}

/** Normalize Open-Meteo's column-oriented response into the existing SPA contract. */
export function mapOpenMeteoWeather(payload: OpenMeteoResponse): WeatherResponse | null {
  const currentTemp = finite(payload.current?.temperature_2m);
  const currentHumidity = finite(payload.current?.relative_humidity_2m);
  const currentCode = finite(payload.current?.weather_code);
  if (currentTemp === null || currentHumidity === null || currentCode === null) return null;

  const currentWeather = openMeteoWeatherCode(currentCode);
  const daily = payload.daily;
  const dates = entries(daily?.time);
  const forecast = daily
    ? dates.slice(0, FORECAST_DAYS).flatMap((_, index): WeatherForecastDay[] => {
        const date = textAt(dates, index);
        if (!date) return [];
        const weather = openMeteoWeatherCode(finiteAt(daily.weather_code, index) ?? 2);
        return [{
          // Local noon avoids a weekday shift when the browser parses a date-only value.
          date: date.includes("T") ? date : `${date}T12:00:00`,
          high: finiteAt(daily.temperature_2m_max, index),
          low: finiteAt(daily.temperature_2m_min, index),
          temp: finiteAt(daily.temperature_2m_mean, index),
          humidity: finiteAt(daily.relative_humidity_2m_mean, index),
          condition: weather.condition,
          icon: weather.icon,
          uv_index: finiteAt(daily.uv_index_max, index),
          wind_speed_mph: finiteAt(daily.wind_speed_10m_max, index),
        }];
      })
    : [];

  const timezone = typeof payload.timezone === "string" ? payload.timezone : "";
  const location = timezone.split("/").at(-1)?.replaceAll("_", " ") || "Current Location";

  return {
    temp: currentTemp,
    humidity: currentHumidity,
    condition: currentWeather.condition,
    icon: currentWeather.icon,
    uv_index: finiteAt(payload.hourly?.uv_index, 0),
    wind_speed_mph: finite(payload.current?.wind_speed_10m),
    location,
    forecast,
    isLive: true,
    provider: "open-meteo",
  };
}

/** A simulated reading used only when every live provider is unreachable. */
export function fallbackWeather(reason: string): WeatherResponse {
  return {
    temp: 65,
    humidity: 50,
    condition: "Partly Cloudy (Simulated)",
    icon: "02d",
    uv_index: null,
    wind_speed_mph: null,
    forecast: [],
    isLive: false,
    error: reason,
  };
}

/** Derive the timezone city Open-Meteo reports — the last-resort label. */
export function timezoneCity(timezone: unknown): string {
  const tz = typeof timezone === "string" ? timezone : "";
  return tz.split("/").at(-1)?.replaceAll("_", " ") || "Current Location";
}

// Full state/territory name → USPS two-letter code. Keyed lowercase so the lookup
// is case-insensitive regardless of how the geocoder cases the region. Used to keep
// the dashboard location chip short ("Forney, TX" not "Forney, Texas").
const US_STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "puerto rico": "PR", guam: "GU", "american samoa": "AS",
  "u.s. virgin islands": "VI", "us virgin islands": "VI",
  "northern mariana islands": "MP",
};

/**
 * Abbreviate a US state/territory to its USPS code ("Texas" → "TX"). Returns the
 * original region untouched when it is already a 2-letter code or not a known
 * US state, so non-US regions and pre-abbreviated payloads pass through cleanly.
 */
export function abbreviateUsRegion(region: string): string {
  const trimmed = region.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return US_STATE_ABBREVIATIONS[trimmed.toLowerCase()] ?? trimmed;
}

/** Compose a human label from an OWM Geo / current record: "Forney, TX". */
export function composeCityLabel(name: unknown, state: unknown, country: unknown): string | null {
  const city = typeof name === "string" && name.trim() ? name.trim() : null;
  if (!city) return null;
  const region = typeof state === "string" && state.trim() ? state.trim() : null;
  // Disambiguate US localities (there are several "Forney"/"Springfield"s) while
  // keeping the label short enough for the truncated dashboard chip — the state
  // is abbreviated to its two-letter USPS code so the weather chip stays compact.
  if (region && country === "US") return `${city}, ${abbreviateUsRegion(region)}`;
  return city;
}

/** Map an OpenWeatherMap One Call 3.0 `daily[]` entry into the SPA forecast shape. */
export function mapOwmDailyForecast(daily: unknown): WeatherForecastDay[] {
  return entries(daily).slice(0, FORECAST_DAYS).flatMap((raw): WeatherForecastDay[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const day = raw as Record<string, any>;
    const dt = finite(day.dt);
    if (dt === null) return [];
    const date = new Date(dt * 1000).toISOString().slice(0, 10);
    const weather = Array.isArray(day.weather) ? day.weather[0] : null;
    return [{
      date: `${date}T12:00:00`,
      high: finite(day.temp?.max),
      low: finite(day.temp?.min),
      temp: finite(day.temp?.day),
      humidity: finite(day.humidity),
      condition: typeof weather?.description === "string" ? weather.description : "partly cloudy",
      icon: typeof weather?.icon === "string" ? weather.icon : "02d",
      uv_index: finite(day.uvi),
      wind_speed_mph: finite(day.wind_speed),
    }];
  });
}
