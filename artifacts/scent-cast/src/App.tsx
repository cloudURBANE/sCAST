import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { FragranceCapture } from './components/FragranceCapture';
import { Wardrobe, Fragrance, DestinationType, EnergyState } from './components/Wardrobe';
import { Wind, Play, X, LogOut, Share2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScentIntentModal } from './components/ScentIntentModal';
import { LavaBackground } from './components/LavaBackground';
import { AuthModal } from './components/AuthModal';
import { SharePage } from './components/SharePage';
import { ShareModal } from './components/ShareModal';

interface WeatherData {
  temp: number;
  humidity: number;
  condition: string;
  icon: string;
  location?: string;
  isLive?: boolean;
  error?: string;
}

const STORAGE_KEYS = {
  TOKEN: 'scent_token',
  EMAIL: 'scent_email',
} as const;

/** Match Wardrobe grid visibility — legacy rows may lack flat name/brand until rebuilt */
function wardrobeEntryName(item: Fragrance): string {
  return item?.name || item?.product?.name || '';
}
function wardrobeEntryBrand(item: Fragrance): string {
  return item?.brand || item?.product?.brand || '';
}
function wardrobeNeedsLegacyRebuild(items: Fragrance[]): boolean {
  return items.some((item) => !wardrobeEntryName(item) || !wardrobeEntryBrand(item));
}

// --- Pure Functions ---

const calculateOlfactoryAlignment = (
  items: Fragrance[],
  intent: { destination: DestinationType; energy: EnergyState },
  weather: WeatherData | null
) => {
  const hour = new Date().getHours();
  const isMorning = hour >= 6 && hour < 10;
  const isEvening = hour >= 17 && hour < 21;
  const isNight = hour >= 21 || hour < 6;

  const destinationOccasions: Record<DestinationType, string[]> = {
    'Staying In': ['Intimate', 'Date Night', 'Casual'],
    'Work': ['Professional', 'Executive', 'Daytime'],
    'Going Out': ['Social', 'Casual', 'Outdoor', 'Sport', 'Social Dominance'],
    'Night Out': ['Evening', 'Formal', 'Date Night', 'Social Dominance', 'Intimate'],
  };

  const scored = items.map(item => {
    const v = item.scent_vector || { freshness: 0, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0 };
    const { freshness, sweetness, woodiness, spice, warmth, musk } = v;
    const sillage = item.performance?.sillage ?? 5;
    const longevity = item.performance?.longevity ?? 5;
    const occasions = item.context?.occasion ?? [];

    let score = 0;
    const drivers: string[] = [];

    // Destination Match
    if (intent.destination === 'Staying In') {
      const sub = musk * 2.0 + sweetness * 1.5 + warmth * 1.0 + (10 - sillage) * 1.2;
      score += sub;
      if (sub > 20) drivers.push('intimate projection suits the setting');
    } else if (intent.destination === 'Work') {
      const sub = woodiness * 2.0 + freshness * 1.5 + (8 - Math.abs(sillage - 5)) * 1.5;
      score += sub;
      if (spice > 6 || sweetness > 7) score -= 12;
      if (sub > 20) drivers.push('clean, grounded character fits a professional space');
    } else if (intent.destination === 'Going Out') {
      const sub = freshness * 1.5 + woodiness * 1.2 + musk * 1.0 + sillage * 1.3;
      score += sub;
      if (sub > 20) drivers.push('versatile projection reads well in any setting');
    } else if (intent.destination === 'Night Out') {
      const sub = warmth * 2.0 + spice * 2.0 + woodiness * 1.2 + sillage * 2.5;
      score += sub;
      if (sub > 20) drivers.push('bold depth and projection command the room at night');
    }

    if (occasions.some(o => destinationOccasions[intent.destination].includes(o))) {
      score += 15;
      drivers.push(`its olfactory profile is calibrated for this context`);
    }

    // Energy Match
    if (intent.energy === 'Calm') {
      score += freshness * 1.2 + musk * 1.0 - spice * 0.6 - warmth * 0.4;
      if (freshness >= 6) drivers.push('cool freshness supports a calm presence');
    } else if (intent.energy === 'Focused') {
      score += woodiness * 2.0 + freshness * 1.2 - sweetness * 0.8;
      if (woodiness >= 6) drivers.push('grounded woodiness channels mental clarity');
    } else if (intent.energy === 'Confident') {
      score += spice * 2.0 + warmth * 1.5 + woodiness * 1.0 + sillage * 1.5;
      if (spice >= 5 || sillage >= 7) drivers.push('its assertive character projects authority');
    } else if (intent.energy === 'Social') {
      score += musk * 1.8 + freshness * 1.2 + sweetness * 0.8 + sillage * 1.0;
      if (musk >= 5) drivers.push('skin-close musk draws people in');
    } else if (intent.energy === 'Relaxed') {
      score += musk * 1.8 + warmth * 1.2 + sweetness * 0.8 + (10 - sillage) * 0.8;
      if (warmth >= 5) drivers.push('enveloping warmth suits an unhurried mood');
    }

    // Weather Match
    if (weather) {
      const temp = weather.temp;
      const cond = weather.condition.toLowerCase();
      const humidity = weather.humidity ?? 50;

      if (temp > 85) {
        score += freshness * 2.5 - warmth * 2.0 - spice * 1.2;
        if (freshness >= 6) drivers.push(`bright freshness suits ${Math.round(temp)}°F heat`);
      } else if (temp > 72) {
        score += freshness * 1.5 + musk * 0.8 - warmth * 0.6;
        if (freshness >= 5) drivers.push(`light character aligns with ${Math.round(temp)}°F warmth`);
      } else if (temp > 58) {
        score += woodiness * 1.5 + freshness * 0.6;
      } else if (temp > 44) {
        score += warmth * 2.0 + woodiness * 1.2 + spice * 0.8 - freshness * 0.6;
        if (warmth >= 5) drivers.push(`warmth cuts through the ${Math.round(temp)}°F chill`);
      } else {
        score += warmth * 2.5 + spice * 2.0 + woodiness * 1.0 - freshness * 1.5;
        if (warmth >= 5 || spice >= 5) drivers.push(`rich density suits the cold`);
      }

      if (cond.includes('rain') || cond.includes('drizzle')) {
        score += woodiness * 0.8 + warmth * 0.5;
        const earthy = item.notes?.some(n =>
          ['vetiver', 'patchouli', 'cedar', 'oakmoss'].some(k => n.toLowerCase().includes(k))
        );
        if (earthy) { score += 10; drivers.push('earthy base thrives in rain'); }
      }
      if (cond.includes('sun') || cond.includes('clear')) {
        score += freshness * 0.5 + musk * 0.3;
      }
      if (humidity > 75) {
        score += freshness * 0.8 - sweetness * 0.6 - warmth * 0.5;
      }
    }

    // Time Match
    if (isMorning) {
      score += freshness * 1.2 - warmth * 0.4;
      if (freshness >= 6) drivers.push('crisp freshness is made for mornings');
    } else if (isEvening) {
      score += warmth * 1.0 + spice * 0.6 + woodiness * 0.5;
    } else if (isNight) {
      score += warmth * 1.5 + spice * 1.0 + musk * 0.8;
      if ((warmth >= 5 || spice >= 5) && intent.destination === 'Night Out') {
        drivers.push('nocturnal richness reaches its peak after dark');
      }
    }

    // Longevity Bonus
    if (intent.destination === 'Work' || intent.destination === 'Going Out') {
      score += longevity * 0.8;
    }

    // Tie-breaker noise
    score += Math.random() * 4;

    return { item, score, drivers, sillage, woodiness, freshness, warmth, spice, musk };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
};

// --- Components ---

const LiveClock: React.FC = React.memo(() => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="font-mono tracking-widest text-2xl sm:text-4xl text-white tabular-nums" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </span>
  );
});

interface AtmosphereBarProps {
  weather: WeatherData | null;
  weatherLoading: boolean;
}

const ATMOSPHERE_COPIES = 6;

const AtmosphereBar: React.FC<AtmosphereBarProps> = React.memo(({ weather, weatherLoading }) => {
  const temp = weatherLoading ? '—' : weather?.temp != null ? `${Math.round(weather.temp)}°F` : '—';
  const condition = weatherLoading ? '—' : weather?.condition ?? '—';
  const humidity = weatherLoading ? '—' : weather?.humidity != null ? `${weather.humidity}%` : '—';
  const location = weather?.location ?? null;

  return (
    <div className="py-20 border-y border-white/5 bg-transparent overflow-hidden flex select-none relative">
      <div className="absolute inset-y-0 left-0 w-40 bg-gradient-to-r from-black via-black/40 to-transparent z-20 pointer-events-none" />
      <div className="absolute inset-y-0 right-0 w-40 bg-gradient-to-l from-black via-black/40 to-transparent z-20 pointer-events-none" />
      <div className="flex animate-infinite-scroll-slow gap-40 text-[18px] uppercase tracking-tighter text-white/40 font-serif italic whitespace-nowrap items-center">
        {[...Array(ATMOSPHERE_COPIES)].map((_, i) => (
          <React.Fragment key={i}>
            <div className="flex items-center gap-8">
              <div className="flex flex-col items-start gap-1">
                <span className="text-scent-accent/20 text-[9px] font-bold tracking-[0.4em] font-sans uppercase">Chronos:</span>
                <LiveClock />
              </div>
            </div>
            <span className="opacity-5 font-sans font-thin text-3xl select-none mx-4">/</span>
            <div className="flex items-center gap-8">
              <div className="flex flex-col items-start gap-1">
                <span className="text-scent-accent/20 text-[9px] font-bold tracking-[0.4em] font-sans uppercase">Atmosphere:</span>
                <span className="text-white text-3xl sm:text-5xl font-serif italic tracking-tighter">{temp}</span>
              </div>
            </div>
            <span className="opacity-5 font-sans font-thin text-3xl select-none mx-4">/</span>
            <div className="flex items-center gap-8">
              <div className="flex flex-col items-start gap-1">
                <span className="text-scent-accent/20 text-[9px] font-bold tracking-[0.4em] font-sans uppercase">Coordinate:</span>
                <span className="text-white text-3xl sm:text-5xl font-serif italic tracking-tighter">{location ?? '—'}</span>
              </div>
            </div>
            <span className="opacity-5 font-sans font-thin text-3xl select-none mx-4">/</span>
            <div className="flex items-center gap-8">
              <div className="flex flex-col items-start gap-1">
                <span className="text-scent-accent/20 text-[9px] font-bold tracking-[0.4em] font-sans uppercase">Matrix:</span>
                <span className="text-white text-3xl sm:text-5xl font-serif italic tracking-tighter">{condition}</span>
              </div>
            </div>
            <span className="opacity-5 font-sans font-thin text-3xl select-none mx-4">/</span>
            <div className="flex items-center gap-8">
              <div className="flex flex-col items-start gap-1">
                <span className="text-scent-accent/20 text-[9px] font-bold tracking-[0.4em] font-sans uppercase">Saturation:</span>
                <span className="text-white text-3xl sm:text-5xl font-serif italic tracking-tighter">{humidity}</span>
              </div>
            </div>
            <span className="opacity-5 font-sans font-thin text-3xl select-none mx-4">/</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
});

export default function App() {
  const [authToken, setAuthToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get('oauth_token');
    const oauthEmail = params.get('oauth_email');
    if (oauthToken && oauthEmail) {
      localStorage.setItem(STORAGE_KEYS.TOKEN, oauthToken);
      localStorage.setItem(STORAGE_KEYS.EMAIL, oauthEmail);
      window.history.replaceState({}, '', window.location.pathname);
      return oauthToken;
    }
    return localStorage.getItem(STORAGE_KEYS.TOKEN);
  });
  
  const [authEmail, setAuthEmail] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthEmail = params.get('oauth_email');
    return oauthEmail ?? localStorage.getItem(STORAGE_KEYS.EMAIL);
  });

  const [items, setItems] = useState<Fragrance[]>([]);
  const [wardrobeLoaded, setWardrobeLoaded] = useState(false);
  const [isIntentModalOpen, setIsIntentModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [activeRecommendation, setActiveRecommendation] = useState<Fragrance | null>(null);
  const [recommendationReason, setRecommendationReason] = useState<string>('');
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'requesting' | 'granted' | 'denied'>('idle');
  const [userId, setUserId] = useState<string | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [guestPromptDismissed, setGuestPromptDismissed] = useState(false);
  const autoWardrobeRebuildAttemptedRef = useRef(false);
  const [wardrobeRevertSnapshot, setWardrobeRevertSnapshot] = useState<Fragrance[] | null>(null);
  const [wardrobeFixBusy, setWardrobeFixBusy] = useState(false);
  const [wardrobeFixHint, setWardrobeFixHint] = useState<string | null>(null);

  useEffect(() => {
    autoWardrobeRebuildAttemptedRef.current = false;
  }, [authToken]);

  const fetchWeather = useCallback(async (lat?: number, lon?: number, signal?: AbortSignal) => {
    try {
      const url = lat && lon ? `/api/weather?lat=${lat}&lon=${lon}` : '/api/weather';
      const response = await axios.get(url, { signal });
      setWeather(response.data);
    } catch (err) {
      if (!axios.isCancel(err)) {
        console.error("Failed to fetch weather", err);
      }
    } finally {
      setWeatherLoading(false);
    }
  }, []);

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

  const loadWardrobe = useCallback(async (token: string, signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/wardrobe', {
        headers: { Authorization: `Bearer ${token}` },
        signal
      });
      if (!res.ok) return;
      const data: Fragrance[] = await res.json();
      setItems(data);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error("Failed to load wardrobe", err);
      }
    } finally {
      setWardrobeLoaded(true);
    }
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    if (authToken) {
      loadWardrobe(authToken, abortController.signal);
      fetch('/api/share-settings', { 
        headers: { Authorization: `Bearer ${authToken}` },
        signal: abortController.signal 
      })
        .then(r => r.json())
        .then(d => { if (d.userId) setUserId(d.userId); })
        .catch(() => {});
    } else {
      setWardrobeLoaded(true);
    }

    return () => abortController.abort();
  }, [authToken, loadWardrobe]);

  useEffect(() => {
    if (!authToken) return;
    const REFRESH_MS = 60_000;
    
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadWardrobe(authToken);
    };
    
    const id = window.setInterval(tick, REFRESH_MS);
    
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authToken, loadWardrobe]);

  const handleAuth = (token: string, email: string) => {
    localStorage.setItem(STORAGE_KEYS.TOKEN, token);
    localStorage.setItem(STORAGE_KEYS.EMAIL, email);
    setAuthToken(token);
    setAuthEmail(email);
    setIsAuthModalOpen(false);
    setGuestPromptDismissed(false);
  };

  const handleSignOut = () => {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.EMAIL);
    setAuthToken(null);
    setAuthEmail(null);
    setItems([]);
    setWardrobeLoaded(false);
    setWardrobeRevertSnapshot(null);
    setWardrobeFixHint(null);
  };

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
        setWeatherLoading(false);
      },
      { timeout: 12000, enableHighAccuracy: false }
    );
  };

  const handleAddItem = async (item: any) => {
    const newItem: Fragrance = {
      ...item,
      notes: item.notes || ['Bergamot', 'Ambroxan', 'Pink Pepper'],
      concentration: item.concentration || 'Eau de Parfum',
      intents: item.intents || item.context?.occasion || ['Going Out'],
      energies: item.energies || ['Calm'],
      performance: item.performance || { sillage: 6, longevity: 7 },
      pyramid: item.pyramid || { top: ['Bergamot', 'Pink Pepper'], heart: ['Lavender', 'Geranium'], base: ['Ambroxan', 'Patchouli'] },
      context: item.context || { weather: ['Universal'], time: ['Universal'], occasion: ['Daily Wear'] }
    };

    let nextCount = 0;
    setItems((prev) => {
      nextCount = prev.length + 1;
      return [newItem, ...prev];
    });

    if (authToken) {
      try {
        await fetch('/api/wardrobe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(newItem),
        });
      } catch {
        // ignore - item is still in local state
      }
    } else if (nextCount >= 2 && !guestPromptDismissed) {
      setIsAuthModalOpen(true);
    }
  };

  useEffect(() => {
    if (authToken) return;
    if (items.length >= 2 && !guestPromptDismissed) {
      setIsAuthModalOpen(true);
    }
  }, [authToken, items.length, guestPromptDismissed]);

  const handlePersistWardrobeImage = useCallback(async (target: Fragrance): Promise<Fragrance | null> => {
    if (!authToken) return null;
    const apiId = target._dbId ?? target.id;
    try {
      const res = await fetch(`/api/wardrobe/${apiId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ syncImageFromCatalog: true }),
      });
      const data = (await res.json()) as Partial<Fragrance> & { _dbId?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const next: Fragrance = {
        ...target,
        ...data,
        id: target.id,
        imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : target.imageUrl,
        _dbId: data._dbId ?? target._dbId,
      };
      setItems((prev) =>
        prev.map((item) =>
          target._dbId && item._dbId === target._dbId ? next : item.id === target.id ? next : item,
        ),
      );
      return next;
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [authToken]);

  const handleRevertWardrobe = useCallback(() => {
    if (!wardrobeRevertSnapshot) return;
    const snap = JSON.parse(JSON.stringify(wardrobeRevertSnapshot)) as Fragrance[];
    setItems(snap);
    setWardrobeFixHint('Reverted to the in-memory snapshot from before the last automatic rebuild. Server data may differ; refresh loads the API again.');
    setActiveRecommendation((prev) => {
      if (!prev) return null;
      const ok = snap.some(
        (i) => i.id === prev.id || (i._dbId && prev._dbId && i._dbId === prev._dbId),
      );
      return ok ? prev : null;
    });
  }, [wardrobeRevertSnapshot]);

  useEffect(() => {
    if (!authToken || !wardrobeLoaded) return;
    if (autoWardrobeRebuildAttemptedRef.current) return;
    if (!wardrobeNeedsLegacyRebuild(items)) return;

    autoWardrobeRebuildAttemptedRef.current = true;
    const snapshot = JSON.parse(JSON.stringify(items)) as Fragrance[];

    void (async () => {
      setWardrobeFixBusy(true);
      setWardrobeFixHint(null);
      setWardrobeRevertSnapshot(snapshot);
      try {
        const res = await fetch('/api/wardrobe/rebuild', {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { total: number; rebuilt: number; skipped: number };
        await loadWardrobe(authToken);
        setWardrobeFixHint(
          `Rebuild done: ${data.rebuilt} updated, ${data.skipped} skipped (${data.total} rows).`,
        );
      } catch (e) {
        console.error('Wardrobe rebuild failed', e);
        setWardrobeFixHint((e as Error).message || 'Rebuild failed');
      } finally {
        setWardrobeFixBusy(false);
      }
    })();
  }, [authToken, wardrobeLoaded, items, loadWardrobe]);

  const handleDeleteItem = async (target: Fragrance) => {
    const apiId = target._dbId ?? target.id;

    if (!authToken) {
      setItems((prev) =>
        prev.filter(item =>
          target._dbId ? item._dbId !== target._dbId : item.id !== target.id,
        ),
      );
      return;
    }

    try {
      const res = await fetch(`/api/wardrobe/${apiId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        console.error('Failed to delete wardrobe item', res.status);
        await loadWardrobe(authToken);
        return;
      }
    } catch (err) {
      console.error(err);
      await loadWardrobe(authToken);
      return;
    }

    setItems((prev) =>
      prev.filter(item =>
        target._dbId ? item._dbId !== target._dbId : item.id !== target.id,
      ),
    );
  };

  const handleIntentComplete = (intent: { destination: DestinationType; energy: EnergyState }) => {
    setIsIntentModalOpen(false);
    if (items.length === 0) return;

    const winner = calculateOlfactoryAlignment(items, intent, weather);

    const uniqueDrivers = Array.from(new Set(winner.drivers));
    const reason = uniqueDrivers.length > 0
      ? uniqueDrivers.slice(0, 2).join(', and ')
      : 'its olfactory profile best matches your intent and current conditions';

    setRecommendationReason(reason.charAt(0).toUpperCase() + reason.slice(1) + '.');
    setTimeout(() => setActiveRecommendation(winner.item), 800);
  };

  const tickerPhrases = useMemo(() => {
    if (!wardrobeLoaded || items.length === 0) {
      return [
        'Add scents to your vault to unlock discovery',
        'Analyze atmospheric nuance for the perfect wear',
        'Your signature scent is currently syncing with the environment',
      ];
    }

    const phrases: string[] = [];

    const families = items.map(i => i.family).filter(Boolean) as string[];
    if (families.length > 0) {
      const fc: Record<string, number> = {};
      families.forEach(f => { fc[f] = (fc[f] || 0) + 1; });
      const topFamily = Object.entries(fc).sort((a, b) => b[1] - a[1])[0][0];
      phrases.push(`Predominantly ${topFamily.toLowerCase()} olfactory signature`);
    }

    const allNotes = items.flatMap(i => i.notes || []);
    if (allNotes.length > 0) {
      const nc: Record<string, number> = {};
      allNotes.forEach(n => { const k = n.toLowerCase(); nc[k] = (nc[k] || 0) + 1; });
      const [topNote, topCount] = Object.entries(nc).sort((a, b) => b[1] - a[1])[0];
      if (topCount > 1) phrases.push(`Recurring molecule detected: ${topNote}`);
    }

    const vectors = items.map(i => i.scent_vector).filter(Boolean) as NonNullable<Fragrance['scent_vector']>[];
    if (vectors.length > 0) {
      const dims = ['freshness', 'sweetness', 'woodiness', 'spice', 'warmth', 'musk'] as const;
      const labels: Record<string, string> = {
        freshness: 'fresh and airy', sweetness: 'sweet and gourmand',
        woodiness: 'woody and grounded', spice: 'spiced and bold',
        warmth: 'warm and enveloping', musk: 'musky and skin-close',
      };
      const top = dims
        .map(d => ({ d, avg: vectors.reduce((s, v) => s + v[d], 0) / vectors.length }))
        .sort((a, b) => b.avg - a.avg)[0];
      if (top.avg >= 4.5) phrases.push(`Your vault reads ${labels[top.d]}`);
    }

    const seasons = items.map(i => i.season).filter(Boolean) as string[];
    if (seasons.length > 0) {
      const sc: Record<string, number> = {};
      seasons.forEach(s => { sc[s] = (sc[s] || 0) + 1; });
      const [topSeason, topSeasonCount] = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];
      if (topSeasonCount > 1) phrases.push(`Calibrated for ${topSeason.toLowerCase()} conditions`);
    }

    const brands = new Set(items.map(i => i.brand).filter(Boolean));
    if (brands.size > 1) phrases.push(`${brands.size} houses represented in your collection`);

    if (phrases.length < 3) phrases.push('Olfactory intelligence active', 'Atmospheric pairing in progress');

    return phrases;
  }, [items, wardrobeLoaded]);

  const sharePathMatch = window.location.pathname.match(/^\/share\/([^/?#]+)$/);
  if (sharePathMatch) {
    let shareRef = sharePathMatch[1];
    try {
      shareRef = decodeURIComponent(shareRef);
    } catch {
      // Keep raw segment if decode fails.
    }
    return <SharePage userId={shareRef} />;
  }

  return (
    <div className="min-h-[100svh] bg-black selection:bg-scent-accent selection:text-black text-white relative overflow-x-hidden">
      <LavaBackground />
      <nav className="fixed top-0 left-0 right-0 h-24 border-b border-white/5 bg-black/40 backdrop-blur-2xl z-50 px-8">
        <div className="max-w-[1400px] mx-auto h-full flex items-center relative">
          <div className="flex items-center gap-4">
            {authEmail ? (
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/30 font-bold hidden md:block">
                {authEmail}
              </span>
            ) : (
              <button
                onClick={() => setIsAuthModalOpen(true)}
                title="Sign In"
                className="h-8 px-3 rounded-full border border-white/10 hover:border-white/30 transition-all text-[9px] uppercase tracking-[0.2em] text-white/50 hover:text-white font-bold"
              >
                Sign In
              </button>
            )}
            <button
              onClick={requestLocation}
              disabled={locationStatus === 'requesting' || locationStatus === 'granted'}
              title={locationStatus === 'granted' ? 'Location Active' : locationStatus === 'denied' ? 'Location Denied' : 'Sync Location'}
              className="hidden md:flex items-center justify-center w-8 h-8 rounded-full border border-white/10 hover:border-white/30 transition-all disabled:cursor-default"
            >
              <span className={`w-2 h-2 rounded-full ${locationStatus === 'granted' ? 'bg-green-400' : locationStatus === 'requesting' ? 'bg-yellow-400 animate-pulse' : locationStatus === 'denied' ? 'bg-red-400' : 'bg-white/20'}`} />
            </button>
          </div>

          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
            <Wind size={24} strokeWidth={1} className="text-white" />
            <h1 className="font-serif text-2xl italic tracking-tighter uppercase">Scent Cast</h1>
          </div>

          <div className="ml-auto flex items-center gap-4">
            {authToken ? (
              <>
                <button
                  onClick={() => setIsShareModalOpen(true)}
                  title="Share Vault"
                  className="flex items-center justify-center w-8 h-8 rounded-full border border-white/10 hover:border-white/30 transition-all text-white/30 hover:text-white"
                >
                  <Share2 size={14} />
                </button>
                <button
                  onClick={handleSignOut}
                  title="Sign Out"
                  className="flex items-center justify-center w-8 h-8 rounded-full border border-white/10 hover:border-white/30 transition-all text-white/30 hover:text-white"
                >
                  <LogOut size={14} />
                </button>
              </>
            ) : null}
          </div>
        </div>
      </nav>

      <div className="pt-24" />

      <main className="pb-24 px-8 max-w-[1700px] mx-auto md:-mt-12 relative">
        <div className="space-y-40">
          <div className="w-full">
            <div className="flex flex-col items-center justify-center space-y-16 pt-32 text-center">
              <header className="space-y-10 flex flex-col items-center">
                <div className="w-full max-w-4xl overflow-hidden py-4 border-y border-white/5 flex select-none relative group">
                  <div className="flex animate-infinite-scroll gap-20 text-[11px] uppercase font-bold tracking-[0.5em] text-scent-muted font-sans whitespace-nowrap">
                    {[...Array(4)].map((_, i) => (
                      <span key={i} className="flex items-center gap-20">
                        {tickerPhrases.map((phrase, j) => (
                          <React.Fragment key={j}>
                            <span>{phrase}</span>
                            <span className="text-white/10">•</span>
                          </React.Fragment>
                        ))}
                      </span>
                    ))}
                  </div>
                  <div className="absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-black to-transparent z-10" />
                  <div className="absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-black to-transparent z-10" />
                </div>
                <h2 className="font-serif italic text-2xl sm:text-4xl lg:text-7xl leading-tight text-white max-w-4xl tracking-tighter">Find your signature for the current atmosphere.</h2>
              </header>

              <div className="flex flex-col items-center gap-8 w-full max-w-6xl mx-auto">
                <div className="w-full max-w-2xl">
                  <FragranceCapture onAdd={handleAddItem} />
                </div>
                <button
                  onClick={() => {
                    if (items.length === 0) { alert("Your vault is empty! Add at least one fragrance to discover your match."); return; }
                    setIsIntentModalOpen(true);
                  }}
                  className="w-full max-w-2xl h-14 bg-white text-black flex items-center justify-center gap-6 hover:bg-neutral-200 transition-all group rounded-[1.25rem] border border-white/10 shadow-[0_0_50px_rgba(255,255,255,0.1)]"
                >
                  <Play size={20} className="fill-current group-hover:scale-110 transition-transform" />
                  <span className="font-serif italic text-xl sm:text-2xl">Discover Your Signature Scent</span>
                </button>
              </div>
            </div>
          </div>

          <AtmosphereBar weather={weather} weatherLoading={weatherLoading} />

          <div className="pt-32 border-t border-white/5">
            <Wardrobe
              items={items}
              onDelete={handleDeleteItem}
              onPersistWardrobeImage={handlePersistWardrobeImage}
              featuredItem={activeRecommendation}
              onRevertWardrobe={handleRevertWardrobe}
              fixWardrobeBusy={wardrobeFixBusy}
              revertAvailable={!!wardrobeRevertSnapshot}
              wardrobeFixHint={wardrobeFixHint}
            />
          </div>
        </div>
      </main>

      <ScentIntentModal isOpen={isIntentModalOpen} onClose={() => setIsIntentModalOpen(false)} onComplete={handleIntentComplete} />

      {isAuthModalOpen ? (
        <AuthModal
          onAuth={handleAuth}
          onClose={() => {
            setIsAuthModalOpen(false);
            setGuestPromptDismissed(true);
          }}
          allowDismiss
          title={items.length >= 2 ? 'Save your wardrobe before you lose it' : undefined}
          subtitle={
            items.length >= 2
              ? 'You can keep exploring as a guest, but signing in will persist your fragrances to your account.'
              : undefined
          }
        />
      ) : null}

      <ShareModal
        isOpen={isShareModalOpen}
        onClose={() => setIsShareModalOpen(false)}
        userId={userId}
        authToken={authToken}
        items={items}
        onToggleVisibility={(id, hidden) => {
          setItems(prev => prev.map(item => item.id === id ? { ...item, shareHidden: hidden } : item));
        }}
      />

      <AnimatePresence mode="wait">
        {activeRecommendation && (
          <motion.div
            key="recommendation-overlay"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeInOut' }}
            className="fixed inset-0 z-[110] bg-black/95 backdrop-blur-3xl flex flex-col"
          >
            {/* Pinned top bar — X always visible */}
            <div
              className="flex items-center justify-between px-5 pb-4 shrink-0"
              style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}
            >
              <p className="text-[9px] uppercase tracking-[0.4em] text-scent-accent font-bold">Strategic Alignment Found</p>
              <button onClick={() => setActiveRecommendation(null)} className="p-2 text-white/40 hover:text-white hover:bg-white/10 transition-all active:scale-95">
                <X size={20} />
              </button>
            </div>

            {/* Scrollable middle */}
            <div
              className="flex-1 overflow-y-auto"
              style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
            >
              <div className="flex items-center justify-center min-h-full px-5 py-6 sm:px-16 sm:py-12">
                <div className="max-w-2xl w-full text-center space-y-6 sm:space-y-12">
                  <header>
                    <h2 className="font-serif italic text-2xl sm:text-6xl mb-4">You should wear</h2>
                    <div className="h-px w-16 bg-white/20 mx-auto" />
                  </header>
                  <div className="py-6 sm:py-16 border-y border-white/10 group cursor-pointer" onClick={() => setActiveRecommendation(null)}>
                    <p className="text-sm uppercase tracking-[0.2em] text-white/40 mb-2 font-serif">{activeRecommendation.brand}</p>
                    <h3 className="font-serif italic text-3xl sm:text-8xl text-white leading-tight transition-transform group-hover:scale-105">{activeRecommendation.name}</h3>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-12 text-left">
                    <div>
                      <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Olfactory Reason</p>
                      <p className="text-sm italic text-scent-muted leading-relaxed">{recommendationReason || 'Optimal olfactory alignment with your current atmospheric conditions.'}</p>
                    </div>
                    <div>
                      <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Concentration</p>
                      <p className="text-sm italic text-scent-muted leading-relaxed">{activeRecommendation.concentration || 'Eau de Parfum'}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Pinned bottom — Confirm always visible */}
            <div
              className="px-5 pt-3 shrink-0 border-t border-white/5"
              style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
            >
              <button onClick={() => setActiveRecommendation(null)} className="w-full py-4 bg-scent-accent text-black uppercase tracking-[0.3em] text-[10px] font-bold hover:opacity-90 transition-opacity active:scale-[0.98]">
                Confirm Alignment
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="border-t border-white/5 py-16 px-8 mt-24">
        <div className="max-w-[1400px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center gap-2 opacity-30">
            <Wind size={18} />
            <p className="font-serif font-bold italic tracking-tighter uppercase">Scent Cast</p>
          </div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-scent-muted">© 2026 Olfactory Intelligence Systems</p>
        </div>
      </footer>
    </div>
  );
}