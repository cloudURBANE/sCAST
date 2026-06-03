import axios from "axios";

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const DEFAULT_LAT = 41.8781;
const DEFAULT_LON = -87.6298;
const DEFAULT_LOCATION = "Chicago";

type OpenMeteoCurrent = {
  temperature_2m?: number;
  relative_humidity_2m?: number;
  apparent_temperature?: number;
  is_day?: number;
  precipitation?: number;
  rain?: number;
  showers?: number;
  snowfall?: number;
  weather_code?: number;
  cloud_cover?: number;
  wind_speed_10m?: number;
  wind_direction_10m?: number;
  wind_gusts_10m?: number;
};

type OpenMeteoResponse = {
  timezone?: string;
  current?: OpenMeteoCurrent;
};

type WeatherCodeMeta = {
  condition: string;
  icon: string;
};

const WEATHER_CODE_META: Record<number, WeatherCodeMeta> = {
  0: { condition: "Clear sky", icon: "01" },
  1: { condition: "Mainly clear", icon: "02" },
  2: { condition: "Partly cloudy", icon: "02" },
  3: { condition: "Overcast", icon: "04" },
  45: { condition: "Fog", icon: "50" },
  48: { condition: "Depositing rime fog", icon: "50" },
  51: { condition: "Light drizzle", icon: "09" },
  53: { condition: "Moderate drizzle", icon: "09" },
  55: { condition: "Dense drizzle", icon: "09" },
  56: { condition: "Light freezing drizzle", icon: "09" },
  57: { condition: "Dense freezing drizzle", icon: "09" },
  61: { condition: "Slight rain", icon: "10" },
  63: { condition: "Moderate rain", icon: "10" },
  65: { condition: "Heavy rain", icon: "10" },
  66: { condition: "Light freezing rain", icon: "13" },
  67: { condition: "Heavy freezing rain", icon: "13" },
  71: { condition: "Slight snow", icon: "13" },
  73: { condition: "Moderate snow", icon: "13" },
  75: { condition: "Heavy snow", icon: "13" },
  77: { condition: "Snow grains", icon: "13" },
  80: { condition: "Slight rain showers", icon: "09" },
  81: { condition: "Moderate rain showers", icon: "09" },
  82: { condition: "Violent rain showers", icon: "09" },
  85: { condition: "Slight snow showers", icon: "13" },
  86: { condition: "Heavy snow showers", icon: "13" },
  95: { condition: "Thunderstorm", icon: "11" },
  96: { condition: "Thunderstorm with slight hail", icon: "11" },
  99: { condition: "Thunderstorm with heavy hail", icon: "11" },
};

const RAIN_OR_SNOW_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
]);

function finiteNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function coordinateFromInput(value: unknown, fallback: number): number {
  return finiteNumber(value) ?? fallback;
}

function envCoordinate(name: string, fallback: number): number {
  return coordinateFromInput(process.env[name], fallback);
}

function locationFromTimezone(timezone?: string): string {
  if (!timezone) return process.env.DEFAULT_WEATHER_LOCATION || DEFAULT_LOCATION;
  const parts = timezone.split("/");
  const city = parts[parts.length - 1]?.replace(/_/g, " ");
  return city || process.env.DEFAULT_WEATHER_LOCATION || DEFAULT_LOCATION;
}

function iconForWeatherCode(code: number | undefined, isDay: boolean): string {
  const icon = code != null ? WEATHER_CODE_META[code]?.icon : undefined;
  return `${icon ?? "02"}${isDay ? "d" : "n"}`;
}

function conditionForWeatherCode(code: number | undefined): string {
  if (code == null) return "Current conditions";
  return WEATHER_CODE_META[code]?.condition ?? "Current conditions";
}

function hasPrecipitation(current: OpenMeteoCurrent): boolean {
  return [current.precipitation, current.rain, current.showers, current.snowfall].some((value) => {
    const amount = finiteNumber(value);
    return amount != null && amount > 0;
  });
}

export function normalizeOpenMeteoWeather(data: OpenMeteoResponse) {
  const current = data.current;
  if (!current) {
    throw new Error("Open-Meteo response did not include current weather");
  }

  const temperature = finiteNumber(current.temperature_2m);
  const humidity = finiteNumber(current.relative_humidity_2m);
  const windSpeed = finiteNumber(current.wind_speed_10m);
  const weatherCode = finiteNumber(current.weather_code);
  const isDay = current.is_day !== 0;
  const isRaining = hasPrecipitation(current) || (weatherCode != null && RAIN_OR_SNOW_CODES.has(weatherCode));

  return {
    temp: temperature,
    temperature,
    temperature_f: temperature,
    humidity,
    humidity_percent: humidity,
    condition: conditionForWeatherCode(weatherCode),
    description: conditionForWeatherCode(weatherCode),
    icon: iconForWeatherCode(weatherCode, isDay),
    windSpeed,
    wind_speed_mph: windSpeed,
    apparent_temperature_f: finiteNumber(current.apparent_temperature),
    precipitation_in: finiteNumber(current.precipitation),
    cloud_cover_percent: finiteNumber(current.cloud_cover),
    wind_direction_degrees: finiteNumber(current.wind_direction_10m),
    wind_gusts_mph: finiteNumber(current.wind_gusts_10m),
    is_day: isDay,
    is_raining: isRaining,
    location: locationFromTimezone(data.timezone),
    source: "open-meteo",
    isLive: true,
  };
}

export async function getWeather(params?: { lat?: number | string; lon?: number | string }) {
  const lat = coordinateFromInput(params?.lat, envCoordinate("DEFAULT_WEATHER_LAT", DEFAULT_LAT));
  const lon = coordinateFromInput(params?.lon, envCoordinate("DEFAULT_WEATHER_LON", DEFAULT_LON));

  try {
    const response = await axios.get<OpenMeteoResponse>(OPEN_METEO_FORECAST_URL, {
      params: {
        latitude: lat,
        longitude: lon,
        current: [
          "temperature_2m",
          "relative_humidity_2m",
          "apparent_temperature",
          "is_day",
          "precipitation",
          "rain",
          "showers",
          "snowfall",
          "weather_code",
          "cloud_cover",
          "wind_speed_10m",
          "wind_direction_10m",
          "wind_gusts_10m",
        ].join(","),
        temperature_unit: "fahrenheit",
        wind_speed_unit: "mph",
        precipitation_unit: "inch",
        timezone: "auto",
        forecast_days: 1,
      },
      timeout: 8000,
    });

    return normalizeOpenMeteoWeather(response.data);
  } catch (err: any) {
    const status = err.response?.status;
    let errorDisplay = "Weather Service Interrupted";
    if (status === 429) errorDisplay = "API Quota Exceeded";
    else if (status) errorDisplay = `Weather Service Error ${status}`;

    return {
      temp: 65,
      temperature: 65,
      temperature_f: 65,
      humidity: 50,
      humidity_percent: 50,
      condition: "Partly cloudy (Simulated)",
      description: "Partly cloudy (Simulated)",
      icon: "02d",
      windSpeed: 4,
      wind_speed_mph: 4,
      location: process.env.DEFAULT_WEATHER_LOCATION || DEFAULT_LOCATION,
      source: "fallback",
      isLive: false,
      error: errorDisplay,
    };
  }
}
