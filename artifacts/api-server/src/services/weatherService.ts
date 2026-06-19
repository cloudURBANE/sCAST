import axios from "axios";

// One Call 3.0 `daily[]` entry → the compact per-day shape the SPA's weekly
// outlook dashboard consumes. Forwarding this costs nothing extra: the daily
// forecast already rides along in the same One Call response the current
// conditions come from, it was simply being discarded.
function mapDailyForecast(daily: unknown) {
  if (!Array.isArray(daily)) return [];
  return daily.slice(0, 7).map((day: any) => ({
    date: new Date((Number(day?.dt) || 0) * 1000).toISOString(),
    high: typeof day?.temp?.max === "number" ? day.temp.max : null,
    low: typeof day?.temp?.min === "number" ? day.temp.min : null,
    temp: typeof day?.temp?.day === "number" ? day.temp.day : null,
    humidity: typeof day?.humidity === "number" ? day.humidity : null,
    condition: day?.weather?.[0]?.description ?? null,
    icon: day?.weather?.[0]?.icon ?? null,
    uv_index: typeof day?.uvi === "number" ? day.uvi : null,
  }));
}

export async function getWeather(params?: { lat?: number | string; lon?: number | string }) {
  const apiKey = process.env.WEATHER_API_KEY;

  if (!apiKey) {
    return { temp: 72, humidity: 45, condition: "Clear Sky (Demo)", icon: "01d", uv_index: null, forecast: [] };
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
        // Up to 7 days of forecast for the weekly outlook dashboard.
        forecast: mapDailyForecast(response.data.daily),
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
          // The 2.5 current-weather endpoint carries no multi-day forecast.
          forecast: [],
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
    return { temp: 65, humidity: 50, condition: "Partly Cloudy (Simulated)", icon: "02d", uv_index: null, forecast: [], isLive: false, error: errorDisplay };
  }
}
