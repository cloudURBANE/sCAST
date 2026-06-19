import axios from "axios";

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const FORECAST_DAYS = 7;

type OpenMeteoCurrent = {
  temperature_2m?: unknown;
  relative_humidity_2m?: unknown;
  weather_code?: unknown;
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
};

type OpenMeteoResponse = {
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
};

export type WeatherResponse = {
  temp: number;
  humidity: number;
  condition: string;
  icon: string;
  uv_index: number | null;
  location?: string;
  forecast: WeatherForecastDay[];
  isLive: boolean;
  error?: string;
};

function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finite(value: unknown): number | null {
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
    location,
    forecast,
    isLive: true,
  };
}

function fallbackWeather(reason: string): WeatherResponse {
  return {
    temp: 65,
    humidity: 50,
    condition: "Partly Cloudy (Simulated)",
    icon: "02d",
    uv_index: null,
    forecast: [],
    isLive: false,
    error: reason,
  };
}

/** Current conditions plus the seven-day outlook, provided by keyless Open-Meteo. */
export async function getWeather(params?: { lat?: number | string; lon?: number | string }): Promise<WeatherResponse> {
  const { lat, lon } = params || {};
  const apiParams: Record<string, unknown> = {
    latitude: (lat != null && lat !== "" && Number.isFinite(Number(lat))) ? lat : 51.5074,
    longitude: (lon != null && lon !== "" && Number.isFinite(Number(lon))) ? lon : -0.1278,
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
    });
    return mapOpenMeteoWeather(response.data) ?? fallbackWeather("Incomplete weather response");
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 429) return fallbackWeather("Weather request limit reached");
    if (status === 400) return fallbackWeather("Invalid forecast location");
    return fallbackWeather("Weather Service Interrupted");
  }
}
