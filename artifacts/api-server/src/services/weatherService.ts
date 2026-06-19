import axios from "axios";

/** One representative day in the weekly scent forecast. Temps are °F. */
export interface ForecastDay {
  /** Unix seconds for local noon of the day (provider `dt`). */
  dt: number;
  temp_high: number;
  temp_low: number;
  /** Daytime temperature — the value we wear-test against. */
  temp_day: number;
  humidity: number;
  wind_speed_mph: number;
  /** Human-readable condition, e.g. "light rain". */
  condition: string;
  /** Coarse group, e.g. "Rain" / "Clouds" / "Clear". */
  main: string;
  /** OpenWeather icon code, e.g. "10d". */
  icon: string;
  /** One Call `daily.uvi`; null when unavailable. */
  uv_index: number | null;
  /** Probability of precipitation, 0..1. */
  pop: number;
}

export interface WeatherForecast {
  location: string;
  isLive: boolean;
  days: ForecastDay[];
  error?: string;
}

const FORECAST_DAYS = 7;
const DAY_SECONDS = 86_400;

/** Deterministic, location-agnostic fallback so the dashboard always has a week. */
function buildFallbackForecast(reason?: string): WeatherForecast {
  const startOfTodayMs = new Date(new Date().setHours(12, 0, 0, 0)).getTime();
  const seedTemps = [72, 70, 74, 68, 71, 73, 69];
  const days: ForecastDay[] = Array.from({ length: FORECAST_DAYS }, (_, index) => {
    const day = seedTemps[index % seedTemps.length];
    return {
      dt: Math.floor(startOfTodayMs / 1000) + index * DAY_SECONDS,
      temp_high: day + 4,
      temp_low: day - 9,
      temp_day: day,
      humidity: 50,
      wind_speed_mph: 5,
      condition: "partly cloudy",
      main: "Clouds",
      icon: "02d",
      uv_index: null,
      pop: 0,
    };
  });
  return { location: "Sample Forecast", isLive: false, days, ...(reason ? { error: reason } : {}) };
}

/**
 * Weekly scent forecast (today + 6 days). Reuses the same OpenWeather One Call 3.0
 * source as {@link getWeather} but surfaces the `daily[]` array the current-weather
 * endpoint discards. The client scores each day's conditions against the user's
 * wardrobe with the shared scent-weather engine to pick a fragrance per day.
 * Always resolves to a 7-day shape — synthesizes a neutral week on any failure —
 * so the dashboard never has to handle a missing forecast.
 */
export async function getWeatherForecast(
  params?: { lat?: number | string; lon?: number | string },
): Promise<WeatherForecast> {
  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) return buildFallbackForecast();

  const { lat, lon } = params || {};
  const apiParams: Record<string, unknown> = {
    appid: apiKey,
    units: "imperial",
    exclude: "minutely,hourly,alerts",
    lat: (lat != null && lat !== "" && Number.isFinite(Number(lat))) ? lat : 51.5074,
    lon: (lon != null && lon !== "" && Number.isFinite(Number(lon))) ? lon : -0.1278,
  };

  try {
    const response = await axios.get(
      "https://api.openweathermap.org/data/3.0/onecall",
      { params: apiParams, timeout: 8000 },
    );
    const rawDays: any[] = Array.isArray(response.data?.daily) ? response.data.daily : [];
    if (rawDays.length === 0) return buildFallbackForecast("No daily forecast returned");

    const days: ForecastDay[] = rawDays.slice(0, FORECAST_DAYS).map((entry: any) => {
      const weather = Array.isArray(entry.weather) ? entry.weather[0] ?? {} : {};
      return {
        dt: typeof entry.dt === "number" ? entry.dt : Math.floor(Date.now() / 1000),
        temp_high: Number(entry.temp?.max ?? entry.temp?.day ?? 72),
        temp_low: Number(entry.temp?.min ?? entry.temp?.night ?? 60),
        temp_day: Number(entry.temp?.day ?? entry.temp?.max ?? 72),
        humidity: Number(entry.humidity ?? 50),
        wind_speed_mph: Number(entry.wind_speed ?? 0),
        condition: typeof weather.description === "string" ? weather.description : "clear sky",
        main: typeof weather.main === "string" ? weather.main : "Clear",
        icon: typeof weather.icon === "string" ? weather.icon : "01d",
        uv_index: typeof entry.uvi === "number" ? entry.uvi : null,
        pop: typeof entry.pop === "number" ? entry.pop : 0,
      };
    });

    const location = typeof response.data?.timezone === "string"
      ? response.data.timezone.split("/")[1]?.replace("_", " ") || "Current Location"
      : "Current Location";

    return { location, isLive: true, days };
  } catch (err: any) {
    const status = err.response?.status;
    let reason = "Weather Service Interrupted";
    if (status === 401) reason = "Invalid API Key";
    else if (status === 429) reason = "API Quota Exceeded";
    else if (status === 404) reason = "Forecast unavailable for this plan";
    return buildFallbackForecast(reason);
  }
}

export async function getWeather(params?: { lat?: number | string; lon?: number | string }) {
  const apiKey = process.env.WEATHER_API_KEY;

  if (!apiKey) {
    return { temp: 72, humidity: 45, condition: "Clear Sky (Demo)", icon: "01d", uv_index: null };
  }

  try {
    const { lat, lon } = params || {};
    const apiParams: Record<string, unknown> = {
      appid: apiKey,
      units: 'imperial',
      lat: (lat != null && lat !== '' && Number.isFinite(Number(lat))) ? lat : 51.5074,
      lon: (lon != null && lon !== '' && Number.isFinite(Number(lon))) ? lon : -0.1278,
    };

    try {
      const response = await axios.get("https://api.openweathermap.org/data/3.0/onecall", { params: apiParams, timeout: 8000 });
      return {
        temp: response.data.current.temp,
        humidity: response.data.current.humidity,
        condition: response.data.current.weather[0].description,
        icon: response.data.current.weather[0].icon,
        // One Call 3.0 carries live UV (`current.uvi`); null = no UV data, so
        // consumers must show "unavailable" rather than pretending UV is live.
        uv_index: typeof response.data.current.uvi === "number" ? response.data.current.uvi : null,
        location: response.data.timezone.split('/')[1]?.replace('_', ' ') || "Current Location",
        isLive: true
      };
    } catch (oneCallErr: any) {
      if (oneCallErr.response?.status === 401 || oneCallErr.response?.status === 404) {
        const fallbackRes = await axios.get("https://api.openweathermap.org/data/2.5/weather", { params: apiParams, timeout: 8000 });
        return {
          temp: fallbackRes.data.main.temp,
          humidity: fallbackRes.data.main.humidity,
          condition: fallbackRes.data.weather[0].description,
          icon: fallbackRes.data.weather[0].icon,
          // The 2.5 endpoint has no UV field — surfaced as unavailable.
          uv_index: null,
          location: fallbackRes.data.name,
          isLive: true
        };
      }
      throw oneCallErr;
    }
  } catch (err: any) {
    const status = err.response?.status;
    let errorDisplay = "Weather Service Interrupted";
    if (status === 401) errorDisplay = "Invalid API Key";
    else if (status === 429) errorDisplay = "API Quota Exceeded";
    return { temp: 65, humidity: 50, condition: "Partly Cloudy (Simulated)", icon: "02d", uv_index: null, isLive: false, error: errorDisplay };
  }
}
