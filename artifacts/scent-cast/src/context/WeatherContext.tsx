import React, { createContext, useCallback, useContext, useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from './AuthContext';

export interface WeatherData {
  temp?: number;
  temperature?: number;
  temperature_f?: number;
  humidity?: number;
  humidity_percent?: number;
  condition?: string;
  description?: string;
  icon?: string;
  windSpeed?: number;
  wind_speed_mph?: number;
  location?: string;
  isLive?: boolean;
  error?: string;
}

type LocationStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported';
type LocationSource = 'fallback' | 'preferred' | 'browser';

interface StoredWeatherLocation {
  lat: number;
  lon: number;
  label?: string | null;
  updatedAt: number;
}

interface WeatherContextType {
  weather: WeatherData | null;
  weatherLoading: boolean;
  locationStatus: LocationStatus;
  locationSource: LocationSource;
  fetchWeather: (lat?: number, lon?: number, signal?: AbortSignal) => Promise<void>;
  requestLocation: () => Promise<void>;
}

const WeatherContext = createContext<WeatherContextType | undefined>(undefined);
const WEATHER_LOCATION_STORAGE_KEY = 'scent_weather_location';

function finiteCoordinate(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function readStoredWeatherLocation(): StoredWeatherLocation | null {
  try {
    const raw = localStorage.getItem(WEATHER_LOCATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredWeatherLocation>;
    const lat = finiteCoordinate(parsed.lat, -90, 90);
    const lon = finiteCoordinate(parsed.lon, -180, 180);
    if (lat === null || lon === null) return null;
    const updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
      ? parsed.updatedAt
      : 0;
    return {
      lat,
      lon,
      updatedAt,
      label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : null,
    };
  } catch {
    return null;
  }
}

function writeStoredWeatherLocation(location: StoredWeatherLocation): void {
  try {
    localStorage.setItem(WEATHER_LOCATION_STORAGE_KEY, JSON.stringify(location));
  } catch {
    /* storage unavailable - keep in-memory weather only */
  }
}

function serverLocationToStored(value: unknown): StoredWeatherLocation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { lat?: unknown; lon?: unknown; label?: unknown; updatedAt?: unknown };
  const lat = finiteCoordinate(record.lat, -90, 90);
  const lon = finiteCoordinate(record.lon, -180, 180);
  if (lat === null || lon === null) return null;
  const updatedAtMs = typeof record.updatedAt === 'string'
    ? Date.parse(record.updatedAt)
    : typeof record.updatedAt === 'number'
      ? record.updatedAt
      : Date.now();
  return {
    lat,
    lon,
    updatedAt: Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now(),
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : null,
  };
}

function getBrowserPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15_000,
    });
  });
}

async function syncWeatherLocation(authToken: string | null, location: StoredWeatherLocation): Promise<void> {
  if (!authToken) return;
  await fetch('/api/me/weather-location', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      lat: location.lat,
      lon: location.lon,
      label: location.label ?? undefined,
    }),
  }).catch(() => {
    /* best-effort preference sync */
  });
}

export const WeatherProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle');
  const [locationSource, setLocationSource] = useState<LocationSource>('fallback');
  const fetchSeqRef = useRef(0);
  const { authToken } = useAuth();
  const { toast } = useToast();

  const fetchWeather = useCallback(async (lat?: number, lon?: number, signal?: AbortSignal) => {
    const seq = fetchSeqRef.current + 1;
    fetchSeqRef.current = seq;
    setWeatherLoading(true);

    try {
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
      const url = hasCoords ? `/api/weather?lat=${lat}&lon=${lon}` : '/api/weather';
      const response = await axios.get(url, { signal });
      if (fetchSeqRef.current !== seq) return;
      setLocationSource(hasCoords ? 'preferred' : 'fallback');
      setWeather(response.data);
    } catch (err) {
      if (!axios.isCancel(err) && fetchSeqRef.current === seq) {
        console.error("Failed to fetch weather", err);
        toast({
          title: "Weather Unreachable",
          description: "Failed to load current weather conditions. Using default fallback profiles.",
          variant: "destructive",
        });
      }
    } finally {
      if (fetchSeqRef.current === seq) setWeatherLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    const abortController = new AbortController();
    const cached = readStoredWeatherLocation();
    if (cached) {
      setLocationStatus('granted');
      void fetchWeather(cached.lat, cached.lon, abortController.signal);
    } else {
      void fetchWeather(undefined, undefined, abortController.signal);
    }

    return () => abortController.abort();
  }, [fetchWeather]);

  useEffect(() => {
    if (!authToken) return;
    const abortController = new AbortController();
    const localPreference = readStoredWeatherLocation();

    if (localPreference) {
      void syncWeatherLocation(authToken, localPreference);
    }

    fetch('/api/me/weather-location', {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: abortController.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const serverPreference = serverLocationToStored(data?.location);
        if (!serverPreference) return;
        const shouldAdoptServerPreference =
          !localPreference || serverPreference.updatedAt > localPreference.updatedAt + 1000;
        if (!shouldAdoptServerPreference) return;
        writeStoredWeatherLocation(serverPreference);
        setLocationStatus('granted');
        void fetchWeather(serverPreference.lat, serverPreference.lon);
      })
      .catch(() => {
        /* aborted/offline/migration-lag - local preference or fallback stays active */
      });

    return () => abortController.abort();
  }, [authToken, fetchWeather]);

  const requestLocation = useCallback(async () => {
    if (!navigator.geolocation) {
      setLocationStatus('unsupported');
      toast({
        title: "Location Unavailable",
        description: "This browser does not support location access.",
        variant: "destructive",
      });
      return;
    }

    setLocationStatus('requesting');
    try {
      const position = await getBrowserPosition();
      const nextLocation: StoredWeatherLocation = {
        lat: roundCoordinate(position.coords.latitude),
        lon: roundCoordinate(position.coords.longitude),
        updatedAt: Date.now(),
      };
      writeStoredWeatherLocation(nextLocation);
      setLocationStatus('granted');
      setLocationSource('browser');
      void syncWeatherLocation(authToken, nextLocation);
      await fetchWeather(nextLocation.lat, nextLocation.lon);
    } catch (err) {
      console.error("Location request failed", err);
      setLocationStatus('denied');
      toast({
        title: "Location Not Updated",
        description: "We could not access your current location. Existing weather settings were kept.",
        variant: "destructive",
      });
      if (!weather) {
        await fetchWeather(undefined, undefined);
      }
    }
  }, [authToken, fetchWeather, toast, weather]);

  const contextValue = useMemo<WeatherContextType>(() => ({
    weather,
    weatherLoading,
    locationStatus,
    locationSource,
    fetchWeather,
    requestLocation,
  }), [weather, weatherLoading, locationStatus, locationSource, fetchWeather, requestLocation]);

  return (
    <WeatherContext.Provider value={contextValue}>
      {children}
    </WeatherContext.Provider>
  );
};

export const useWeather = () => {
  const context = useContext(WeatherContext);
  if (!context) {
    throw new Error('useWeather must be used within a WeatherProvider');
  }
  return context;
};
