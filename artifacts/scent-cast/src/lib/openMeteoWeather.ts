import type { WeatherData, WeatherForecastDay } from '@/context/WeatherContext';

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_LAT = 51.5074;
const DEFAULT_LON = -0.1278;

type OpenMeteoPayload = {
  timezone?: unknown;
  current?: Record<string, unknown>;
  hourly?: Record<string, unknown>;
  daily?: Record<string, unknown>;
};

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function at(values: unknown, index: number): number | null {
  return Array.isArray(values) ? finite(values[index]) : null;
}

function weatherCode(code: number): Pick<WeatherData, 'condition' | 'icon'> {
  if (code === 0) return { condition: 'clear sky', icon: '01d' };
  if (code <= 2) return { condition: 'partly cloudy', icon: '02d' };
  if (code === 3) return { condition: 'overcast', icon: '04d' };
  if (code === 45 || code === 48) return { condition: 'fog', icon: '50d' };
  if (code <= 57) return { condition: 'drizzle', icon: '09d' };
  if (code <= 67) return { condition: 'rain', icon: '10d' };
  if (code <= 77) return { condition: 'snow', icon: '13d' };
  if (code <= 82) return { condition: 'rain showers', icon: '09d' };
  if (code <= 86) return { condition: 'snow showers', icon: '13d' };
  return { condition: 'thunderstorms', icon: '11d' };
}

function locationLabel(timezone: unknown): string {
  return typeof timezone === 'string'
    ? timezone.split('/').at(-1)?.replaceAll('_', ' ') || 'Current Location'
    : 'Current Location';
}

/** Browser-side emergency weather path that mirrors the API response shape. */
export async function fetchOpenMeteoWeather(lat?: number, lon?: number, signal?: AbortSignal): Promise<WeatherData> {
  const latitude = Number.isFinite(lat) ? lat as number : DEFAULT_LAT;
  const longitude = Number.isFinite(lon) ? lon as number : DEFAULT_LON;
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
    hourly: 'uv_index',
    forecast_hours: '1',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,temperature_2m_mean,relative_humidity_2m_mean,uv_index_max,wind_speed_10m_max',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: '7',
  });
  const response = await fetch(`${OPEN_METEO_FORECAST_URL}?${params}`, { signal });
  if (!response.ok) throw new Error(`Open-Meteo request failed with ${response.status}`);

  const payload = await response.json() as OpenMeteoPayload;
  const temp = finite(payload.current?.temperature_2m);
  const humidity = finite(payload.current?.relative_humidity_2m);
  const code = finite(payload.current?.weather_code);
  if (temp === null || humidity === null || code === null) throw new Error('Open-Meteo returned incomplete current conditions');

  const dates = Array.isArray(payload.daily?.time) ? payload.daily.time : [];
  const forecast: WeatherForecastDay[] = dates.slice(0, 7).flatMap((date, index) => {
    if (typeof date !== 'string' || !date) return [];
    const day = weatherCode(at(payload.daily?.weather_code, index) ?? 2);
    return [{
      date: date.includes('T') ? date : `${date}T12:00:00`,
      high: at(payload.daily?.temperature_2m_max, index),
      low: at(payload.daily?.temperature_2m_min, index),
      temp: at(payload.daily?.temperature_2m_mean, index),
      humidity: at(payload.daily?.relative_humidity_2m_mean, index),
      condition: day.condition ?? null,
      icon: day.icon ?? null,
      uv_index: at(payload.daily?.uv_index_max, index),
    }];
  });
  const current = weatherCode(code);
  return {
    temp,
    humidity,
    condition: current.condition,
    icon: current.icon,
    wind_speed_mph: finite(payload.current?.wind_speed_10m) ?? undefined,
    uv_index: at(payload.hourly?.uv_index, 0),
    location: locationLabel(payload.timezone),
    forecast,
    isLive: true,
  };
}
