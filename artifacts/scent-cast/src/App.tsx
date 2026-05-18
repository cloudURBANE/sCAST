import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import axios from 'axios';
import { FragranceCapture } from './components/FragranceCapture';
import { Wardrobe, Fragrance, DestinationType, EnergyState } from './components/Wardrobe';
import { Wind, Play, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScentIntentModal } from './components/ScentIntentModal';
import { ScentNotesInfographic } from './components/ScentNotesInfographic';
import { LavaBackground } from './components/LavaBackground';
import { AuthModal } from './components/AuthModal';
import { SharePage } from './components/SharePage';
import { ShareModal } from './components/ShareModal';
import type { BottleImageAdjustment } from './lib/bottleImageAdjustment';
import {
  calculateScentWeatherRecommendation,
  type ScentFamily,
  type ScentWeatherEngineInput,
  type ScentWeatherRecommendation,
} from './lib/scentWeatherEngine';
import { collectMainAccordDisplayRows } from './lib/fragranceApi';
import { APP_BRAND_MARK } from './lib/appBrand';

interface WeatherData {
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

const STORAGE_KEYS = {
  TOKEN: 'scent_token',
  EMAIL: 'scent_email',
} as const;

type LooseRecord = Record<string, unknown>;

const isLooseRecord = (value: unknown): value is LooseRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberFromValue = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const firstFiniteNumber = (fallback: number, ...values: unknown[]): number => {
  for (const value of values) {
    const numberValue = numberFromValue(value);
    if (numberValue !== undefined) return numberValue;
  }
  return fallback;
};

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const collectStrings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  return [];
};

const getWeatherNumber = (
  weather: WeatherData | null,
  keys: (keyof WeatherData)[],
  fallback: number,
): number => firstFiniteNumber(fallback, ...keys.map((key) => weather?.[key]));

const getWeatherString = (
  weather: WeatherData | null,
  keys: (keyof WeatherData)[],
  fallback = '',
): string => firstString(...keys.map((key) => weather?.[key])) ?? fallback;

const getFragranceRecord = (item: Fragrance): LooseRecord => item as unknown as LooseRecord;

/** Match Wardrobe grid visibility — legacy rows may lack flat name/brand until rebuilt */
function wardrobeEntryName(item: Fragrance): string {
  const record = getFragranceRecord(item);
  const product = isLooseRecord(record.product) ? record.product : null;
  return firstString(record.name, product?.name) ?? '';
}
function wardrobeEntryBrand(item: Fragrance): string {
  const record = getFragranceRecord(item);
  const product = isLooseRecord(record.product) ? record.product : null;
  return firstString(record.brand, product?.brand) ?? '';
}
function wardrobeNeedsLegacyRebuild(items: Fragrance[]): boolean {
  return items.some((item) => !wardrobeEntryName(item) || !wardrobeEntryBrand(item));
}
function sameWardrobeEntry(
  item: Pick<Fragrance, 'id' | '_dbId'>,
  target: Pick<Fragrance, 'id' | '_dbId'>,
): boolean {
  if (target._dbId) return item._dbId === target._dbId;
  if (item._dbId) return false;
  return item.id === target.id;
}

const RAIN_CONDITION_SIGNALS = ['rain', 'drizzle', 'storm'];

const FAMILY_TRAIT_SIGNALS: Record<ScentFamily, string[]> = {
  fresh: ['fresh', 'freshness', 'clean', 'mint'],
  citrus: ['citrus', 'bergamot', 'lemon', 'lime', 'orange', 'grapefruit', 'mandarin'],
  aquatic: ['aquatic', 'marine', 'ocean', 'sea', 'water'],
  green: ['green', 'grass', 'leaf', 'leafy', 'herbal', 'vetiver'],
  musky: ['musk', 'musky'],
  woody: ['wood', 'woody', 'woodiness', 'cedar', 'sandalwood', 'patchouli', 'vetiver'],
  amber: ['amber', 'resin', 'warmth', 'warm'],
  sweet: ['sweet', 'sweetness', 'vanilla', 'tonka', 'caramel', 'honey'],
  gourmand: ['gourmand', 'chocolate', 'coffee', 'praline', 'caramel'],
  oud: ['oud', 'agarwood'],
  smoky: ['smoke', 'smoky', 'incense'],
  leather: ['leather', 'leathery', 'suede'],
  tobacco: ['tobacco', 'cigar'],
  spicy: ['spicy', 'spice', 'pepper', 'cardamom', 'cinnamon', 'clove', 'saffron'],
  powdery: ['powder', 'powdery', 'iris', 'orris', 'violet'],
};

const mapDestinationToEngineType = (
  destination: DestinationType | string,
): ScentWeatherEngineInput['setting']['type'] => {
  const normalized = destination.trim().toLowerCase();
  if (normalized === 'work') return 'work';
  if (normalized === 'night out' || normalized === 'night') return 'night';
  if (normalized === 'going out') return 'mixed';
  if (normalized === 'date') return 'date';
  if (normalized === 'gym') return 'gym';
  return 'indoor';
};

const normalizeTrait = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const titleCaseToken = (value: string): string =>
  value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const getFragranceFamilies = (item: Fragrance): string[] => {
  const record = getFragranceRecord(item);
  return uniqueStrings([
    ...collectStrings(record.scentFamilies),
    ...collectStrings(record.scent_families),
    ...collectStrings(record.families),
    ...collectStrings(record.family),
  ]);
};

const getFragranceAccords = (item: Fragrance): string[] => {
  const record = getFragranceRecord(item);
  const pyramid = isLooseRecord(record.pyramid) ? record.pyramid : null;
  const dm = item.derived_metrics ?? item.raw_engine_detail?.derived_metrics ?? null;
  const accordLabels = collectMainAccordDisplayRows(dm?.main_accords).map((r) => r.label);
  const dmNotes = dm?.notes;

  return uniqueStrings([
    ...accordLabels,
    ...(dmNotes
      ? [
          ...collectStrings(dmNotes.top),
          ...collectStrings(dmNotes.heart),
          ...collectStrings(dmNotes.base),
          ...collectStrings(dmNotes.flat),
        ]
      : []),
    ...collectStrings(dm?.main_accords?.accord_summary),
    ...collectStrings(record.accords),
    ...collectStrings(record.notes),
    ...collectStrings(record.topNotes),
    ...collectStrings(record.middleNotes),
    ...collectStrings(record.heartNotes),
    ...collectStrings(record.baseNotes),
    ...collectStrings(pyramid?.top),
    ...collectStrings(pyramid?.heart),
    ...collectStrings(pyramid?.middle),
    ...collectStrings(pyramid?.base),
    ...collectStrings(pyramid?.notes),
  ]);
};

const getFragranceProfileVector = (item: Fragrance): Record<string, number> => {
  const record = getFragranceRecord(item);
  const vector: Record<string, number> = {};

  for (const source of [record.profile_vector, record.vector, record.scent_vector]) {
    if (!isLooseRecord(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      const numberValue = numberFromValue(value);
      if (numberValue !== undefined) vector[key] = numberValue;
    }
  }

  return vector;
};

const getFragranceLongevity = (item: Fragrance): string | number | undefined => {
  const record = getFragranceRecord(item);
  const performance = isLooseRecord(record.performance) ? record.performance : null;
  const value = record.longevity ?? performance?.longevity;
  if (typeof value === 'string') return firstString(value);
  return numberFromValue(value);
};

const getFragranceTraitTexts = (item: Fragrance): string[] => {
  const traits: string[] = [];
  traits.push(...getFragranceFamilies(item));
  traits.push(...getFragranceAccords(item));
  for (const [key, value] of Object.entries(getFragranceProfileVector(item))) {
    if (Number.isFinite(value) && value > 0) traits.push(key);
  }
  return traits.map(normalizeTrait).filter(Boolean);
};

const fragranceHasFamilySignal = (item: Fragrance, family: ScentFamily): boolean => {
  const traits = getFragranceTraitTexts(item);
  return traits.some((trait) =>
    FAMILY_TRAIT_SIGNALS[family].some((signal) => trait.includes(signal)),
  );
};

const mapSillageToEngineLabel = (sillage: unknown): string | undefined => {
  if (typeof sillage === 'string') return firstString(sillage);
  const numericSillage = numberFromValue(sillage);
  if (numericSillage === undefined) return undefined;
  if (numericSillage >= 8) return 'strong';
  if (numericSillage <= 3) return 'light';
  return 'moderate';
};

const getFragranceSillage = (item: Fragrance): string | undefined => {
  const record = getFragranceRecord(item);
  const performance = isLooseRecord(record.performance) ? record.performance : null;
  return mapSillageToEngineLabel(record.sillage ?? record.projection ?? performance?.sillage);
};

const buildEngineInput = (
  item: Fragrance,
  intent: { destination: DestinationType; energy: EnergyState },
  weather: WeatherData | null,
): ScentWeatherEngineInput => {
  const condition = getWeatherString(weather, ['condition', 'description']);
  const normalizedCondition = condition.toLowerCase();

  return {
    weather: {
      temperature_f: getWeatherNumber(weather, ['temperature_f', 'temperature', 'temp'], 72),
      humidity_percent: getWeatherNumber(weather, ['humidity_percent', 'humidity'], 50),
      wind_speed_mph: getWeatherNumber(weather, ['wind_speed_mph', 'windSpeed'], 0),
      is_raining: RAIN_CONDITION_SIGNALS.some((signal) => normalizedCondition.includes(signal)),
      condition,
    },
    setting: {
      type: mapDestinationToEngineType(intent.destination),
    },
    fragrance: {
      name: wardrobeEntryName(item),
      brand: wardrobeEntryBrand(item),
      concentration: item.concentration,
      scent_families: getFragranceFamilies(item),
      accords: getFragranceAccords(item),
      profile_vector: getFragranceProfileVector(item),
      longevity: getFragranceLongevity(item),
      sillage: getFragranceSillage(item),
    },
  };
};

const calculateRecommendationDisplayScore = (
  recommendation: ScentWeatherRecommendation,
): number => {
  const confidenceBaseScore: Record<ScentWeatherRecommendation['confidence'], number> = {
    high: 92,
    medium: 78,
    low: 62,
  };
  const projectionPenalty: Record<ScentWeatherRecommendation['projection_risk'], number> = {
    low: 0,
    medium: 4,
    high: 10,
    overpowering_risk: 18,
  };
  const wearWindowPenalty: Record<ScentWeatherRecommendation['wear_window'], number> = {
    best_now: 0,
    daytime_safe: 2,
    better_later: 8,
    nighttime_better: 10,
    avoid_today: 28,
  };

  return Math.max(
    0,
    Math.min(
      100,
      confidenceBaseScore[recommendation.confidence] -
        projectionPenalty[recommendation.projection_risk] -
        wearWindowPenalty[recommendation.wear_window],
    ),
  );
};

const scoreRecommendationCandidate = (
  item: Fragrance,
  recommendation: ScentWeatherRecommendation,
  intent: { destination: DestinationType; energy: EnergyState },
): number => {
  const bestFamilyHits = recommendation.best_scent_families.filter((family) =>
    fragranceHasFamilySignal(item, family),
  ).length;
  const avoidFamilyHits = recommendation.avoid_scent_families.filter((family) =>
    fragranceHasFamilySignal(item, family),
  ).length;
  const intentBonus = item.intents?.includes(intent.destination) ? 4 : 0;
  const energyBonus = item.energies?.includes(intent.energy) ? 3 : 0;

  return (
    calculateRecommendationDisplayScore(recommendation) +
    bestFamilyHits * 8 -
    avoidFamilyHits * 14 +
    intentBonus +
    energyBonus
  );
};

const calculateEngineAlignment = (
  items: Fragrance[],
  intent: { destination: DestinationType; energy: EnergyState },
  weather: WeatherData | null,
) => {
  const candidates = items.map((item, index) => {
    const recommendation = calculateScentWeatherRecommendation(buildEngineInput(item, intent, weather));
    return {
      item,
      recommendation,
      score: scoreRecommendationCandidate(item, recommendation, intent),
      index,
    };
  });

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0];
};

const formatFamilyList = (families: ScentFamily[]): string =>
  families.length > 0 ? families.map(titleCaseToken).join(', ') : 'Flexible';

const formatAvoidList = (families: ScentFamily[]): string =>
  families.length > 0 ? families.map(titleCaseToken).join(', ') : 'None flagged';

const formatSprayCount = (sprayCount: ScentWeatherRecommendation['spray_count']): string => {
  const plural = sprayCount.recommended === 1 ? 'spray' : 'sprays';
  if (sprayCount.min === sprayCount.max) {
    return `${sprayCount.recommended} ${plural} recommended`;
  }
  return `${sprayCount.min}-${sprayCount.max} sprays (${sprayCount.recommended} recommended)`;
};

// --- Components ---

const LiveClock: React.FC = React.memo(() => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const syncMinute = () => {
      setTime(new Date());
      interval = setInterval(() => setTime(new Date()), 60_000);
    };

    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    timeout = setTimeout(syncMinute, msUntilNextMinute);

    return () => {
      if (timeout) clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  return (
    <span
      className="font-serif italic tracking-normal text-inherit leading-[1.05] text-[#fff7ec] tabular-nums"
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}
    </span>
  );
});

interface AtmosphereBarProps {
  weather: WeatherData | null;
  weatherLoading: boolean;
}

const ATMOSPHERE_TRACK_COPIES = 4;
const ATMOSPHERE_SCROLL_PIXELS_PER_SECOND = 14;
const ATMOSPHERE_SCROLL_MIN_SECONDS = 72;
const ATMOSPHERE_SCROLL_MAX_SECONDS = 160;

const AtmosphereBar: React.FC<AtmosphereBarProps> = React.memo(({ weather, weatherLoading }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const tempValue = getWeatherNumber(weather, ['temperature_f', 'temperature', 'temp'], Number.NaN);
  const humidityValue = getWeatherNumber(weather, ['humidity_percent', 'humidity'], Number.NaN);
  const temp = weatherLoading ? '—' : Number.isFinite(tempValue) ? `${Math.round(tempValue)}°F` : '—';
  const condition = weatherLoading ? '—' : getWeatherString(weather, ['condition', 'description'], '—');
  const humidity = weatherLoading ? '—' : Number.isFinite(humidityValue) ? `${humidityValue}%` : '—';
  const location = weather?.location ?? '—';
  const atmosphereTrackKey = [condition, humidity, temp, location].join('|');

  const metrics = [
    { label: 'Matrix', value: condition },
    { label: 'Saturation', value: humidity },
    { label: 'Chronos', value: <LiveClock /> },
    { label: 'Atmosphere', value: temp },
    { label: 'Coordinate', value: location },
  ];

  useLayoutEffect(() => {
    const track = trackRef.current;
    const group = groupRef.current;
    if (!track || !group) return;
    let cancelled = false;
    let animationFrame = 0;

    const updateDistance = (ready = true) => {
      if (cancelled) return;
      const distance = group.getBoundingClientRect().width;
      if (distance <= 0) return;

      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = prefersReducedMotion
        ? 240
        : Math.min(
            ATMOSPHERE_SCROLL_MAX_SECONDS,
            Math.max(ATMOSPHERE_SCROLL_MIN_SECONDS, distance / ATMOSPHERE_SCROLL_PIXELS_PER_SECOND),
          );

      track.style.setProperty('--atmosphere-marquee-distance', `${distance}px`);
      track.style.setProperty('--atmosphere-marquee-duration', `${duration}s`);
      if (ready) {
        track.dataset.marqueeReady = 'true';
      }
    };

    track.dataset.marqueeReady = 'false';

    const startWhenFontsSettle = () => {
      animationFrame = window.requestAnimationFrame(() => updateDistance(true));
    };

    if (document.fonts?.ready) {
      document.fonts.ready.then(startWhenFontsSettle);
    } else {
      startWhenFontsSettle();
    }

    const handleResize = () => updateDistance(track.dataset.marqueeReady === 'true');
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(group);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelled = true;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [condition, humidity, temp, location]);

  return (
    <section className="scent-atmosphere-marquee" aria-label="Current atmosphere">
      <div className="scent-atmosphere-marquee-track" key={atmosphereTrackKey} ref={trackRef}>
        {[...Array(ATMOSPHERE_TRACK_COPIES)].map((_, copyIndex) => (
          <div
            className="scent-atmosphere-marquee-group"
            key={copyIndex}
            ref={copyIndex === 0 ? groupRef : undefined}
            aria-hidden={copyIndex > 0}
          >
            {metrics.map((metric) => (
              <div key={metric.label} className="scent-atmosphere-marquee-cell">
                <span className="scent-atmosphere-label">{metric.label}</span>
                <span className="scent-atmosphere-value">{metric.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
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
  
  const [_authEmail, setAuthEmail] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthEmail = params.get('oauth_email');
    return oauthEmail ?? localStorage.getItem(STORAGE_KEYS.EMAIL);
  });

  const [items, setItems] = useState<Fragrance[]>([]);
  const [wardrobeLoaded, setWardrobeLoaded] = useState(false);
  const [isIntentModalOpen, setIsIntentModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [activeRecommendation, setActiveRecommendation] = useState<Fragrance | null>(null);
  const [activeEngineRecommendation, setActiveEngineRecommendation] = useState<ScentWeatherRecommendation | null>(null);
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
  const [vaultSearchUiActive, setVaultSearchUiActive] = useState(false);

  const handleVaultSearchStateChange = useCallback((active: boolean) => {
    setVaultSearchUiActive(active);
  }, []);

  const handleExpandArchive = useCallback(() => {
    const el = document.getElementById('scent-add-to-vault-search');
    if (!(el instanceof HTMLInputElement)) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => {
      el.focus({ preventScroll: true });
    }, 360);
  }, []);

  useEffect(() => {
    autoWardrobeRebuildAttemptedRef.current = false;
  }, [authToken]);

  const fetchWeather = useCallback(async (lat?: number, lon?: number, signal?: AbortSignal) => {
    try {
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
      const url = hasCoords ? `/api/weather?lat=${lat}&lon=${lon}` : '/api/weather';
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
        fetchWeather(undefined, undefined);
      },
      { timeout: 12000, enableHighAccuracy: false }
    );
  };

  const handleAddItem = async (
    item: any,
  ): Promise<{ persisted: boolean; requiresAuth?: boolean; error?: string }> => {
    const newItem: Fragrance = { ...item };

    let nextCount = 0;
    setItems((prev) => {
      nextCount = prev.length + 1;
      return [newItem, ...prev];
    });

    if (authToken) {
      try {
        const payload = { ...item };
        const res = await fetch('/api/wardrobe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(payload),
        });
        const saved = (await res.json().catch(() => null)) as Partial<Fragrance> | null;
        if (!res.ok) {
          const message =
            saved && typeof (saved as { error?: unknown }).error === 'string'
              ? (saved as { error: string }).error
              : `Wardrobe save failed: HTTP ${res.status}`;
          throw new Error(message);
        }
        if (res.ok && saved) {
          const savedItem: Fragrance = {
            ...newItem,
            ...saved,
            id: typeof saved.id === 'string' && saved.id ? saved.id : newItem.id,
          };
          setItems((prev) =>
            prev.map((existing) =>
              sameWardrobeEntry(existing, newItem) ? savedItem : existing,
            ),
          );
          return { persisted: true };
        }
        throw new Error('Wardrobe save failed: empty API response');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Wardrobe save failed';
        console.error('Failed to persist wardrobe item', err);
        return { persisted: false, error: message };
      }
    } else if (nextCount >= 2 && !guestPromptDismissed) {
      setIsAuthModalOpen(true);
      return { persisted: false, requiresAuth: true };
    }

    return { persisted: false, requiresAuth: !authToken };
  };

  useEffect(() => {
    if (authToken) return;
    if (items.length >= 2 && !guestPromptDismissed) {
      setIsAuthModalOpen(true);
    }
  }, [authToken, items.length, guestPromptDismissed]);

  const handlePersistWardrobeImage = useCallback(async (
    target: Fragrance,
    imageUrl?: string,
    imageAdjustment?: BottleImageAdjustment,
  ): Promise<Fragrance | null> => {
    if (!authToken) return null;
    const apiId = target._dbId ?? target.id;
    try {
      const body: Record<string, unknown> = {};
      if (imageUrl) {
        body.syncImageFromCatalog = true;
        body.imageUrl = imageUrl;
      }
      if (imageAdjustment) {
        body.imageAdjustment = imageAdjustment;
      }
      if (!body.syncImageFromCatalog && !body.imageUrl && !body.imageAdjustment) {
        body.syncImageFromCatalog = true;
      }

      const res = await fetch(`/api/wardrobe/${apiId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Partial<Fragrance> & { _dbId?: string; error?: string; imageHash?: string };
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const resolvedImageUrl = (() => {
        const raw =
          typeof data.imageUrl === 'string' && data.imageUrl.trim()
            ? data.imageUrl.trim()
            : imageUrl;
        if (!raw) return target.imageUrl;
        // Strip any existing v= before appending the fresh one to avoid ?v=old&v=new.
        let base = raw;
        try {
          const parsed = new URL(raw);
          parsed.searchParams.delete('v');
          base = parsed.toString();
        } catch { /* relative or non-URL — leave as-is */ }
        const v = data.imageHash ?? Date.now();
        return `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(v))}`;
      })();
      const next: Fragrance = {
        ...target,
        ...data,
        id: target.id,
        imageUrl: resolvedImageUrl,
        _dbId: data._dbId ?? target._dbId,
      };
      setItems((prev) =>
        prev.map((item) =>
          sameWardrobeEntry(item, target) ? next : item,
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
          !sameWardrobeEntry(item, target),
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
        !sameWardrobeEntry(item, target),
      ),
    );
  };

  const handleIntentComplete = (intent: { destination: DestinationType; energy: EnergyState }) => {
    setIsIntentModalOpen(false);
    if (items.length === 0) return;

    const winner = calculateEngineAlignment(items, intent, weather);
    if (!winner) return;

    setActiveEngineRecommendation(winner.recommendation);
    setRecommendationReason(winner.recommendation.explanation);
    setTimeout(() => setActiveRecommendation(winner.item), 800);
  };

  const closeRecommendationOverlay = useCallback(() => {
    setActiveRecommendation(null);
    setActiveEngineRecommendation(null);
  }, []);

  const tickerPhrases = useMemo(() => {
    if (!wardrobeLoaded || items.length === 0) {
      return [
        'Add scents to your vault and unlock deeper discovery',
        'Atmospheric nuance is analyzed to guide each wear',
        'Your signature profile is syncing with the current environment',
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
  const tickerTrackKey = tickerPhrases.join('|');

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
    <div className="scent-app-shell min-h-[100svh] bg-scent-bg selection:bg-scent-accent selection:text-black text-white relative overflow-x-hidden">
      <LavaBackground />
      <nav className="scent-topbar fixed top-0 left-0 right-0 h-14 sm:h-[72px] z-50 px-3 sm:px-8">
        <div className="max-w-[1760px] mx-auto h-full relative flex items-center justify-center">
          <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center gap-3 sm:gap-4">
            {!authToken ? (
              <button
                type="button"
                onClick={() => setIsAuthModalOpen(true)}
                className="text-[9px] sm:text-xs uppercase tracking-[0.2em] text-[#f4debd]/70 hover:text-white transition-colors whitespace-nowrap"
              >
                Sign In
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsShareModalOpen(true)}
                className="text-[9px] sm:text-xs uppercase tracking-[0.2em] text-[#f4debd]/70 hover:text-white transition-colors whitespace-nowrap"
              >
                Share
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 sm:gap-3 pointer-events-none">
            <Wind
              strokeWidth={1.25}
              className="h-[18px] w-[18px] sm:w-[22px] sm:h-[22px] text-scent-accent drop-shadow-[0_0_10px_rgba(201,139,44,0.22)]"
            />
            <h1 className="scent-brandmark font-serif text-[1rem] sm:text-3xl tracking-[0.14em] uppercase">{APP_BRAND_MARK}</h1>
          </div>

          <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-3 sm:gap-4 justify-end">
            {authToken ? (
              <button
                type="button"
                onClick={handleSignOut}
                className="text-[10px] sm:text-xs uppercase tracking-[0.2em] text-[#f4debd]/70 hover:text-white transition-colors whitespace-nowrap"
              >
                Sign Out
              </button>
            ) : null}
          </div>
        </div>
      </nav>

      <div className="pt-14 sm:pt-[72px]" />

      <main className="relative z-10 pb-24 px-4 sm:px-8 max-w-[1760px] mx-auto">
        <div className="space-y-14 sm:space-y-28 pt-6 sm:pt-14">
          <div className="scent-marquee-band scent-full-bleed w-full overflow-hidden py-[17px] sm:py-[18px] flex select-none relative">
            <div key={tickerTrackKey} className="scent-marquee-track-row flex animate-infinite-scroll whitespace-nowrap scent-marquee-text">
              {[...Array(4)].map((_, i) => (
                <span key={i} className="scent-marquee-phrase-group flex items-center" aria-hidden={i > 0}>
                  {tickerPhrases.map((phrase, j) => (
                    <React.Fragment key={j}>
                      <span className="scent-marquee-phrase whitespace-nowrap">{phrase}</span>
                      {j < tickerPhrases.length - 1 ? (
                        <span className="scent-marquee-divider shrink-0" aria-hidden="true" />
                      ) : null}
                    </React.Fragment>
                  ))}
                </span>
              ))}
            </div>
          </div>

          <section className="scent-hero-zone mx-auto w-full max-w-2xl space-y-7 scroll-mt-20 text-center">
            <h2 className="font-serif italic text-[clamp(2.15rem,7vw,3.8rem)] text-[#fff7ec] leading-[0.98] tracking-normal">
              Find your signature for the current atmosphere.
            </h2>
            <FragranceCapture onAdd={handleAddItem} onVaultSearchStateChange={handleVaultSearchStateChange} />
            <motion.button
              type="button"
              animate={{
                opacity: vaultSearchUiActive ? 0 : 1,
                y: vaultSearchUiActive ? 8 : 0,
              }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
              style={{ pointerEvents: vaultSearchUiActive ? 'none' : 'auto' }}
              tabIndex={vaultSearchUiActive ? -1 : undefined}
              onClick={() => {
                if (items.length === 0) { alert("Your vault is empty! Add at least one fragrance to discover your match."); return; }
                setIsIntentModalOpen(true);
              }}
              className="scent-primary-button w-full h-[60px] sm:h-16 flex items-center justify-center gap-4 transition-all group rounded-[var(--radius-scent)]"
            >
              <Play size={19} className="fill-current group-hover:scale-110 transition-transform" />
              <span className="font-serif italic text-xl sm:text-2xl leading-none">Discover Your Signature Scent</span>
            </motion.button>
          </section>

          <div className="scent-full-bleed">
            <AtmosphereBar weather={weather} weatherLoading={weatherLoading} />
          </div>

          <div>
            <Wardrobe
              items={items}
              onDelete={handleDeleteItem}
              onPersistWardrobeImage={authToken ? handlePersistWardrobeImage : undefined}
              featuredItem={activeRecommendation}
              onRevertWardrobe={handleRevertWardrobe}
              fixWardrobeBusy={wardrobeFixBusy}
              revertAvailable={!!wardrobeRevertSnapshot}
              wardrobeFixHint={wardrobeFixHint}
              onExpandArchive={handleExpandArchive}
            />
          </div>
          <section className="hidden">
            <FragranceCapture onAdd={handleAddItem} />
            <button
              onClick={() => {
                if (items.length === 0) { alert("Your vault is empty! Add at least one fragrance to discover your match."); return; }
                setIsIntentModalOpen(true);
              }}
              className="scent-primary-button w-full h-14 flex items-center justify-center gap-4 transition-all group rounded-[var(--radius-scent)]"
            >
              <Play size={19} className="fill-current group-hover:scale-110 transition-transform" />
              <span className="font-serif italic text-xl sm:text-2xl">Discover Your Signature Scent</span>
            </button>
          </section>
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
          setItems(prev =>
            prev.map(item =>
              (item._dbId ?? item.id) === id ? { ...item, shareHidden: hidden } : item,
            ),
          );
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
              <button onClick={closeRecommendationOverlay} className="p-2 text-white/40 hover:text-white hover:bg-white/10 transition-all active:scale-95">
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
                  <div className="py-6 sm:py-16 border-y border-white/10 group cursor-pointer" onClick={closeRecommendationOverlay}>
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
                    <div className="sm:col-span-2">
                      <ScentNotesInfographic
                        derivedMetrics={
                          activeRecommendation.derived_metrics ??
                          activeRecommendation.raw_engine_detail?.derived_metrics ??
                          null
                        }
                        legacyPyramid={activeRecommendation.pyramid}
                        scentAxesFallback={activeRecommendation.scent_vector ?? null}
                      />
                    </div>
                    {activeEngineRecommendation ? (
                      <>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Best Families</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{formatFamilyList(activeEngineRecommendation.best_scent_families)}</p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Avoid Today</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{formatAvoidList(activeEngineRecommendation.avoid_scent_families)}</p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Sprays</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{formatSprayCount(activeEngineRecommendation.spray_count)}</p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Projection Risk</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{titleCaseToken(activeEngineRecommendation.projection_risk)}</p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Confidence</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{titleCaseToken(activeEngineRecommendation.confidence)}</p>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            {/* Pinned bottom — Confirm always visible */}
            <div
              className="px-5 pt-3 shrink-0 border-t border-white/5"
              style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
            >
              <button onClick={closeRecommendationOverlay} className="w-full py-4 bg-scent-accent text-black uppercase tracking-[0.3em] text-[10px] font-bold hover:opacity-90 transition-opacity active:scale-[0.98]">
                Confirm Alignment
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="relative z-10 border-t border-scent-accent/10 py-16 px-8 mt-24">
        <div className="max-w-[1400px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center gap-2 opacity-30">
            <Wind size={18} />
            <p className="font-serif font-bold italic tracking-tighter uppercase">{APP_BRAND_MARK}</p>
          </div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-scent-muted">© 2026 Olfactory Intelligence Systems</p>
        </div>
      </footer>
    </div>
  );
}
