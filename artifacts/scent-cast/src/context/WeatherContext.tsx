import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { useToast } from '@/hooks/use-toast';

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

interface WeatherContextType {
  weather: WeatherData | null;
  weatherLoading: boolean;
  locationStatus: 'idle' | 'requesting' | 'granted' | 'denied';
  fetchWeather: (lat?: number, lon?: number, signal?: AbortSignal) => Promise<void>;
  requestLocation: () => void;
}

const WeatherContext = createContext<WeatherContextType | undefined>(undefined);

export const WeatherProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'requesting' | 'granted' | 'denied'>('idle');
  const { toast } = useToast();

  const fetchWeather = useCallback(async (lat?: number, lon?: number, signal?: AbortSignal) => {
    try {
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
      const url = hasCoords ? `/api/weather?lat=${lat}&lon=${lon}` : '/api/weather';
      const response = await axios.get(url, { signal });
      setWeather(response.data);
    } catch (err) {
      if (!axios.isCancel(err)) {
        console.error("Failed to fetch weather", err);
        toast({
          title: "Weather Unreachable",
          description: "Failed to load current weather conditions. Using default fallback profiles.",
          variant: "destructive"
        });
      }
    } finally {
      setWeatherLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    const abortController = new AbortController();

    if (!navigator.geolocation) {
      fetchWeather(undefined, undefined, abortController.signal);
      return () => abortController.abort();
    }
    
    setLocationStatus('requesting');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationStatus('granted');
        fetchWeather(pos.coords.latitude, pos.coords.longitude, abortController.signal);
      },
      () => {
        setLocationStatus('denied');
        fetchWeather(undefined, undefined, abortController.signal);
      },
      { timeout: 10000, enableHighAccuracy: false }
    );

    return () => abortController.abort();
  }, [fetchWeather]);

  const requestLocation = () => {
    if (!navigator.geolocation) return;
    setLocationStatus('requesting');
    setWeatherLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationStatus('granted');
        fetchWeather(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        setLocationStatus('denied');
        fetchWeather(undefined, undefined);
      },
      { timeout: 12000, enableHighAccuracy: false }
    );
  };

  return (
    <WeatherContext.Provider
      value={{
        weather,
        weatherLoading,
        locationStatus,
        fetchWeather,
        requestLocation,
      }}
    >
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
