import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from './AuthContext';
import { useWeather } from './WeatherContext';
import { useToast } from '@/hooks/use-toast';
import type { Fragrance, DestinationType, EnergyState } from '@/components/Wardrobe';
import type { BottleImageAdjustment } from '@/lib/bottleImageAdjustment';
import {
  calculateScentWeatherRecommendation,
  type ScentFamily,
  type ScentWeatherEngineInput,
  type ScentWeatherRecommendation,
} from '@/lib/scentWeatherEngine';
import {
  collectMainAccordDisplayRows,
  getFragranceDetails,
  isBackgroundEnrichmentQueued,
  isSourceCoverageComplete,
  normalizeFragranceDetail,
  type FragranceDetail,
  type FragranceDetailRequestPayload,
} from '@/lib/fragranceApi';

// Helper types and algorithms relocated from App.tsx
type LooseRecord = Record<string, unknown>;

// Bounded retry: stop polling /details for a fragrance whose Fragrantica
// status payload never fully decodes, so a permanently-partial item does not
// poll forever. Counted off enrichment.requested_count.
const MAX_ENRICHMENT_ATTEMPTS = 8;

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
  weather: any,
  keys: string[],
  fallback: number,
): number => firstFiniteNumber(fallback, ...keys.map((key) => weather?.[key]));

const getWeatherString = (
  weather: any,
  keys: string[],
  fallback = '',
): string => firstString(...keys.map((key) => weather?.[key])) ?? fallback;

const getFragranceRecord = (item: Fragrance): LooseRecord => item as unknown as LooseRecord;

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

function normalizedEnrichmentStatus(item: Fragrance): string {
  return firstString(item.enrichment?.status, item.raw_engine_detail?.enrichment?.status)
    ?.toLowerCase() ?? '';
}

function hasFragranticaRefreshTarget(item: Fragrance): boolean {
  const detail = item.raw_engine_detail;
  return Boolean(
    item.source_coverage?.fragrantica_linked ||
      detail?.source_coverage?.fragrantica_linked ||
      firstString(
        detail?.raw?.source_urls?.frag_url,
        item.source_url,
        detail?.source_url,
      )?.toLowerCase().includes('fragrantica.com'),
  );
}

function fgMetricsComplete(item: Fragrance): boolean {
  return Boolean(
    item.source_coverage?.fragrantica_metrics_complete ??
      item.raw_engine_detail?.source_coverage?.fragrantica_metrics_complete,
  );
}

function sourceCoverageComplete(item: Fragrance): boolean {
  return (
    isSourceCoverageComplete(item.source_coverage) ||
    isSourceCoverageComplete(item.raw_engine_detail?.source_coverage)
  );
}

function wardrobeNeedsEnrichmentRefresh(item: Fragrance): boolean {
  const enrichment = item.enrichment ?? item.raw_engine_detail?.enrichment;
  if (fgMetricsComplete(item) || sourceCoverageComplete(item)) return false;
  if (isBackgroundEnrichmentQueued(enrichment)) return true;
  const status = normalizedEnrichmentStatus(item);
  if (status === 'completed' || status === 'complete' || status === 'not_needed') return false;
  if (status === 'failed' || status === 'ignored') return false;
  if ((enrichment?.requested_count ?? 0) >= MAX_ENRICHMENT_ATTEMPTS) return false;
  return hasFragranticaRefreshTarget(item) && !fgMetricsComplete(item);
}

function detailRefreshPayloadFor(item: Fragrance): FragranceDetailRequestPayload | null {
  const detail = item.raw_engine_detail;
  const sourceUrl = firstString(
    detail?.raw?.source_urls?.frag_url,
    item.source_url,
    detail?.source_url,
    detail?.raw?.source_urls?.bn_url,
  );
  const engineId = firstString(item.fragranceApiId, detail?.id);
  if (engineId) {
    const origin = engineId.startsWith('catalog:') ||
      engineId.startsWith('dataset:') ||
      engineId.startsWith('local:')
      ? 'app'
      : 'srt';
    return { id: engineId, ...(sourceUrl ? { source_url: sourceUrl } : {}), origin };
  }
  return sourceUrl ? { source_url: sourceUrl, origin: 'srt' } : null;
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
  weather: any,
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
  weather: any,
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

interface WardrobeContextType {
  items: Fragrance[];
  wardrobeLoaded: boolean;
  isIntentModalOpen: boolean;
  isShareModalOpen: boolean;
  activeRecommendation: Fragrance | null;
  activeEngineRecommendation: ScentWeatherRecommendation | null;
  recommendationReason: string;
  userId: string | null;
  wardrobeRevertSnapshot: Fragrance[] | null;
  wardrobeFixBusy: boolean;
  wardrobeFixHint: string | null;
  vaultSearchUiActive: boolean;
  wardrobeError: string | null;
  retryLoadWardrobe: () => void;
  setItems: React.Dispatch<React.SetStateAction<Fragrance[]>>;
  setIsIntentModalOpen: (open: boolean) => void;
  setIsShareModalOpen: (open: boolean) => void;
  setActiveRecommendation: (item: Fragrance | null) => void;
  setActiveEngineRecommendation: (rec: ScentWeatherRecommendation | null) => void;
  setRecommendationReason: (reason: string) => void;
  setUserId: (id: string | null) => void;
  setVaultSearchUiActive: (active: boolean) => void;
  loadWardrobe: (token: string, signal?: AbortSignal) => Promise<void>;
  handleAddItem: (item: any) => Promise<{ persisted: boolean; requiresAuth?: boolean; error?: string }>;
  handlePersistWardrobeImage: (target: Fragrance, imageUrl?: string, imageAdjustment?: BottleImageAdjustment) => Promise<Fragrance | null>;
  handlePersistWardrobeDetailRefresh: (target: Fragrance, detail: FragranceDetail) => Promise<Fragrance | null>;
  handleRevertWardrobe: () => void;
  handleDeleteItem: (target: Fragrance) => Promise<void>;
  handleIntentComplete: (intent: { destination: DestinationType; energy: EnergyState }) => void;
  closeRecommendationOverlay: () => void;
  handleVaultSearchStateChange: (active: boolean) => void;
  handleExpandArchive: () => void;
}

const WardrobeContext = createContext<WardrobeContextType | undefined>(undefined);
const WardrobeItemsContext = createContext<Fragrance[] | undefined>(undefined);
const WardrobeShareModalActionsContext = createContext<Pick<WardrobeContextType, 'setIsShareModalOpen'> | undefined>(undefined);

export const WardrobeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { authToken, isAuthModalOpen, setIsAuthModalOpen, guestPromptDismissed, setGuestPromptDismissed } = useAuth();
  const { weather } = useWeather();
  const { toast } = useToast();

  const [items, setItems] = useState<Fragrance[]>([]);
  const [wardrobeLoaded, setWardrobeLoaded] = useState(false);
  const [wardrobeError, setWardrobeError] = useState<string | null>(null);
  const [isIntentModalOpen, setIsIntentModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [activeRecommendation, setActiveRecommendation] = useState<Fragrance | null>(null);
  const [activeEngineRecommendation, setActiveEngineRecommendation] = useState<ScentWeatherRecommendation | null>(null);
  const [recommendationReason, setRecommendationReason] = useState<string>('');
  const [userId, setUserId] = useState<string | null>(null);
  const [wardrobeRevertSnapshot, setWardrobeRevertSnapshot] = useState<Fragrance[] | null>(null);
  const [wardrobeFixBusy, setWardrobeFixBusy] = useState(false);
  const [wardrobeFixHint, setWardrobeFixHint] = useState<string | null>(null);
  const [vaultSearchUiActive, setVaultSearchUiActive] = useState(false);

  const autoWardrobeRebuildAttemptedRef = useRef(false);
  const enrichmentRefreshInFlightRef = useRef(false);
  const isMutatingRef = useRef(false);
  const lastMutationRef = useRef(0);

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

  const loadWardrobe = useCallback(async (token: string, signal?: AbortSignal) => {
    if (isMutatingRef.current) return;
    const now = Date.now();
    if (now - lastMutationRef.current < 5000) return;

    setWardrobeError(null);
    try {
      const res = await fetch('/api/wardrobe', {
        headers: { Authorization: `Bearer ${token}` },
        signal
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: Fragrance[] = await res.json();
      if (isMutatingRef.current) return;
      setItems(data);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error("Failed to load wardrobe", err);
        setWardrobeError((err as Error).message || "Check your internet connection.");
        toast({
          title: "Synchronization Error",
          description: "Could not fetch your latest wardrobe. Check your internet connection.",
          variant: "destructive"
        });
      }
    } finally {
      setWardrobeLoaded(true);
    }
  }, [toast]);

  const retryLoadWardrobe = useCallback(() => {
    if (authToken) {
      lastMutationRef.current = 0;
      loadWardrobe(authToken);
    }
  }, [authToken, loadWardrobe]);

  // Reset auto-rebuild attempt on auth change
  useEffect(() => {
    autoWardrobeRebuildAttemptedRef.current = false;
  }, [authToken]);

  // Load wardrobe & share settings on login
  useEffect(() => {
    const abortController = new AbortController();

    if (authToken) {
      setWardrobeLoaded(false);
      loadWardrobe(authToken, abortController.signal);
      fetch('/api/share-settings', { 
        headers: { Authorization: `Bearer ${authToken}` },
        signal: abortController.signal 
      })
        .then(r => {
          if (!r.ok) throw new Error("Settings fetch failed");
          return r.json();
        })
        .then(d => { if (d.userId) setUserId(d.userId); })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            console.error("Settings load failed", err);
            toast({
              title: "Settings Sync Failed",
              description: "Could not load sharing configuration. Please try again.",
              variant: "destructive"
            });
          }
        });
    } else {
      setWardrobeLoaded(true);
    }

    return () => abortController.abort();
  }, [authToken, loadWardrobe, toast]);

  // Background polling wardrobe updates
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

  const handleAddItem = useCallback(async (
    item: any,
  ): Promise<{ persisted: boolean; requiresAuth?: boolean; error?: string }> => {
    const newItem: Fragrance = { ...item };

    let nextCount = 0;
    setItems((prev) => {
      nextCount = prev.length + 1;
      return [newItem, ...prev];
    });

    if (authToken) {
      isMutatingRef.current = true;
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
          toast({
            title: "Fragrance Enshrined",
            description: `${newItem.name} has been synced with your database.`
          });
          return { persisted: true };
        }
        throw new Error('Wardrobe save failed: empty API response');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Wardrobe save failed';
        console.error('Failed to persist wardrobe item', err);
        setItems((prev) => prev.filter((i) => !sameWardrobeEntry(i, newItem)));
        toast({
          title: "Save Failed",
          description: message,
          variant: "destructive"
        });
        return { persisted: false, error: message };
      } finally {
        isMutatingRef.current = false;
        lastMutationRef.current = Date.now();
      }
    } else if (nextCount >= 2 && !guestPromptDismissed) {
      setIsAuthModalOpen(true);
      return { persisted: false, requiresAuth: true };
    }

    return { persisted: false, requiresAuth: !authToken };
  }, [authToken, guestPromptDismissed, setIsAuthModalOpen, toast]);

  const handlePersistWardrobeImage = useCallback(async (
    target: Fragrance,
    imageUrl?: string,
    imageAdjustment?: BottleImageAdjustment,
  ): Promise<Fragrance | null> => {
    if (!authToken) return null;
    const apiId = target._dbId ?? target.id;
    isMutatingRef.current = true;
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
        let base = raw;
        try {
          const parsed = new URL(raw);
          parsed.searchParams.delete('v');
          base = parsed.toString();
        } catch { /* relative or non-URL */ }
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
      toast({
        title: "Portrait Saved",
        description: "Bottle display styling aligned."
      });
      return next;
    } catch (e) {
      console.error(e);
      toast({
        title: "Image Sync Error",
        description: "Failed to persist portrait changes.",
        variant: "destructive"
      });
      return null;
    } finally {
      isMutatingRef.current = false;
      lastMutationRef.current = Date.now();
    }
  }, [authToken, toast]);

  const handlePersistWardrobeDetailRefresh = useCallback(async (
    target: Fragrance,
    detail: FragranceDetail,
  ): Promise<Fragrance | null> => {
    if (!authToken) return null;
    const apiId = target._dbId ?? target.id;
    isMutatingRef.current = true;
    try {
      const res = await fetch(`/api/wardrobe/${apiId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          derived_metrics: detail.derived_metrics ?? null,
          source_coverage: detail.source_coverage,
          enrichment: detail.enrichment ?? null,
          raw_engine_detail: detail,
        }),
      });
      const data = (await res.json().catch(() => null)) as Partial<Fragrance> & { _dbId?: string; error?: string } | null;
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const next: Fragrance = {
        ...target,
        ...data,
        id: target.id,
        derived_metrics: detail.derived_metrics ?? null,
        source_coverage: detail.source_coverage,
        enrichment: detail.enrichment ?? null,
        raw_engine_detail: detail,
        _dbId: data?._dbId ?? target._dbId,
      };
      setItems((prev) =>
        prev.map((item) =>
          sameWardrobeEntry(item, target) ? next : item,
        ),
      );
      return next;
    } catch (e) {
      console.error('Failed to persist enriched wardrobe detail', e);
      toast({
        title: "Enrichment Sync Failed",
        description: "Failed to store background molecular profiling.",
        variant: "destructive"
      });
      return null;
    } finally {
      isMutatingRef.current = false;
      lastMutationRef.current = Date.now();
    }
  }, [authToken, toast]);

  // Background detail enrichments scheduler
  useEffect(() => {
    if (!authToken || !wardrobeLoaded || items.length === 0) return;
    const abortController = new AbortController();
    let cancelled = false;
    const REFRESH_MS = 15_000;

    const refreshPendingDetails = async () => {
      if (cancelled || enrichmentRefreshInFlightRef.current || isMutatingRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const targets = items
        .filter(wardrobeNeedsEnrichmentRefresh)
        .slice(0, 3);
      if (targets.length === 0) return;

      enrichmentRefreshInFlightRef.current = true;
      try {
        for (const item of targets) {
          if (cancelled) break;
          const payload = detailRefreshPayloadFor(item);
          if (!payload) continue;
          const detail = normalizeFragranceDetail(
            (await getFragranceDetails(payload, { signal: abortController.signal })) as FragranceDetail,
          );
          // Persist as soon as Fragrantica's 4 metric groups are all in, even
          // if enrichment.status is still "pending" upstream. The engine can
          // leave the job marked pending after a partial-but-usable completion;
          // gating purely on enrichment.status meant we'd never write the
          // enriched payload to the vault row.
          const metricsComplete = Boolean(
            detail.source_coverage?.fragrantica_metrics_complete,
          );
          if (!metricsComplete && isBackgroundEnrichmentQueued(detail.enrichment)) continue;
          await handlePersistWardrobeDetailRefresh(item, detail);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('Background fragrance detail refresh failed', err);
        }
      } finally {
        enrichmentRefreshInFlightRef.current = false;
      }
    };

    void refreshPendingDetails();
    const id = window.setInterval(refreshPendingDetails, REFRESH_MS);
    return () => {
      cancelled = true;
      abortController.abort();
      window.clearInterval(id);
    };
  }, [authToken, wardrobeLoaded, items, handlePersistWardrobeDetailRefresh]);

  const handleRevertWardrobe = useCallback(() => {
    if (!wardrobeRevertSnapshot) return;
    const snap = JSON.parse(JSON.stringify(wardrobeRevertSnapshot)) as Fragrance[];
    setItems(snap);
    lastMutationRef.current = Date.now();
    setWardrobeFixHint('Reverted to the in-memory snapshot from before the last automatic rebuild. Server data may differ; refresh loads the API again.');
    setActiveRecommendation((prev) => {
      if (!prev) return null;
      const ok = snap.some(
        (i) => i.id === prev.id || (i._dbId && prev._dbId && i._dbId === prev._dbId),
      );
      return ok ? prev : null;
    });
    toast({
      title: "Reversion Applied",
      description: "Returned to the local copy pre-rebuild."
    });
  }, [wardrobeRevertSnapshot, toast]);

  // Auto legacy database rebuild logic
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
        toast({
          title: "Database Calibrated",
          description: `Automatically rebuilt ${data.rebuilt} legacy fragrances. ID formats verified.`
        });
      } catch (e) {
        console.error('Wardrobe rebuild failed', e);
        const errMsg = (e as Error).message || 'Rebuild failed';
        setWardrobeFixHint(errMsg);
        toast({
          title: "Calibration Failed",
          description: errMsg,
          variant: "destructive"
        });
      } finally {
        setWardrobeFixBusy(false);
      }
    })();
  }, [authToken, wardrobeLoaded, items, loadWardrobe, toast]);

  const handleDeleteItem = useCallback(async (target: Fragrance) => {
    const apiId = target._dbId ?? target.id;

    if (!authToken) {
      setItems((prev) =>
        prev.filter(item =>
          !sameWardrobeEntry(item, target),
        ),
      );
      toast({
        title: "Enshrined Locally Removed",
        description: `${target.name} removed from transient list.`
      });
      return;
    }

    isMutatingRef.current = true;
    try {
      const res = await fetch(`/api/wardrobe/${apiId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setItems((prev) =>
        prev.filter(item =>
          !sameWardrobeEntry(item, target),
        ),
      );
      toast({
        title: "Olfactory Link Broken",
        description: `${target.name} has been purged from your collection.`
      });
    } catch (err) {
      console.error(err);
      toast({
        title: "Delete Failed",
        description: "Could not remove the fragrance. Re-syncing database.",
        variant: "destructive"
      });
      await loadWardrobe(authToken);
    } finally {
      isMutatingRef.current = false;
      lastMutationRef.current = Date.now();
    }
  }, [authToken, loadWardrobe, toast]);

  const handleIntentComplete = useCallback((intent: { destination: DestinationType; energy: EnergyState }) => {
    setIsIntentModalOpen(false);
    if (items.length === 0) return;

    const winner = calculateEngineAlignment(items, intent, weather);
    if (!winner) return;

    setActiveEngineRecommendation(winner.recommendation);
    setRecommendationReason(winner.recommendation.explanation);
    setActiveRecommendation(winner.item);
  }, [items, weather]);

  const closeRecommendationOverlay = useCallback(() => {
    setActiveRecommendation(null);
    setActiveEngineRecommendation(null);
  }, []);

  // Empty items on logout
  useEffect(() => {
    if (!authToken) {
      setItems([]);
      setWardrobeLoaded(true);
      setWardrobeError(null);
      setWardrobeRevertSnapshot(null);
      setWardrobeFixHint(null);
    }
  }, [authToken]);

  const contextValue = useMemo<WardrobeContextType>(() => ({
    items,
    wardrobeLoaded,
    wardrobeError,
    isIntentModalOpen,
    isShareModalOpen,
    activeRecommendation,
    activeEngineRecommendation,
    recommendationReason,
    userId,
    wardrobeRevertSnapshot,
    wardrobeFixBusy,
    wardrobeFixHint,
    vaultSearchUiActive,
    setItems,
    setIsIntentModalOpen,
    setIsShareModalOpen,
    setActiveRecommendation,
    setActiveEngineRecommendation,
    setRecommendationReason,
    setUserId,
    setVaultSearchUiActive,
    loadWardrobe,
    retryLoadWardrobe,
    handleAddItem,
    handlePersistWardrobeImage,
    handlePersistWardrobeDetailRefresh,
    handleRevertWardrobe,
    handleDeleteItem,
    handleIntentComplete,
    closeRecommendationOverlay,
    handleVaultSearchStateChange,
    handleExpandArchive,
  }), [
    items,
    wardrobeLoaded,
    wardrobeError,
    isIntentModalOpen,
    isShareModalOpen,
    activeRecommendation,
    activeEngineRecommendation,
    recommendationReason,
    userId,
    wardrobeRevertSnapshot,
    wardrobeFixBusy,
    wardrobeFixHint,
    vaultSearchUiActive,
    loadWardrobe,
    retryLoadWardrobe,
    handleAddItem,
    handlePersistWardrobeImage,
    handlePersistWardrobeDetailRefresh,
    handleRevertWardrobe,
    handleDeleteItem,
    handleIntentComplete,
    closeRecommendationOverlay,
    handleVaultSearchStateChange,
    handleExpandArchive,
  ]);

  const shareModalActions = useMemo<Pick<WardrobeContextType, 'setIsShareModalOpen'>>(() => ({
    setIsShareModalOpen,
  }), [setIsShareModalOpen]);

  return (
    <WardrobeShareModalActionsContext.Provider value={shareModalActions}>
      <WardrobeItemsContext.Provider value={items}>
        <WardrobeContext.Provider value={contextValue}>
          {children}
        </WardrobeContext.Provider>
      </WardrobeItemsContext.Provider>
    </WardrobeShareModalActionsContext.Provider>
  );
};

export const useWardrobe = () => {
  const context = useContext(WardrobeContext);
  if (!context) {
    throw new Error('useWardrobe must be used within a WardrobeProvider');
  }
  return context;
};

export const useWardrobeItems = () => {
  const context = useContext(WardrobeItemsContext);
  if (!context) {
    throw new Error('useWardrobeItems must be used within a WardrobeProvider');
  }
  return context;
};

export const useWardrobeShareModalActions = () => {
  const context = useContext(WardrobeShareModalActionsContext);
  if (!context) {
    throw new Error('useWardrobeShareModalActions must be used within a WardrobeProvider');
  }
  return context;
};
