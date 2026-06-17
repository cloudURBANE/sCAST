import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from './AuthContext';
import { useWeather } from './WeatherContext';
import { useToast } from '@/hooks/use-toast';
import type { Fragrance, DestinationType, EnergyState } from '@/components/Wardrobe';
import type { BottleImageAdjustment } from '@/lib/bottleImageAdjustment';
import { reconcileWardrobeItems } from '@/lib/wardrobeReconcile';
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

// Durable onboarding completion. Once true, the dashboard shows the discover
// state and never re-shows the add-3 flow, even while the wardrobe is hydrating
// or returns empty. Server state (GET /api/me/app-state) is authoritative; the
// local marker only suppresses flicker before the server responds.
const ONBOARDING_STORAGE_KEY = 'scent_onboarding_completed';
const GUEST_WARDROBE_STORAGE_KEY = 'scent_guest_wardrobe_items';
const WARDROBE_ONBOARDING_THRESHOLD = 3;
// How many guest-added fragrances before we interrupt with the sign-in modal.
// Raised from 2 → 5 so a guest can meaningfully try the product (build a small
// wardrobe) before being asked to create an account; the gentler GuestSaveBanner
// nudges in the meantime.
const GUEST_SAVE_PROMPT_THRESHOLD = 5;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?.replace(/\/+$/, '');

function appApiUrl(path: string): string {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

function onboardingMarkerKey(authToken: string): string {
  return `${ONBOARDING_STORAGE_KEY}:${authToken}`;
}

function readOnboardingMarker(authToken?: string | null): boolean {
  if (!authToken) return false;
  try {
    return localStorage.getItem(onboardingMarkerKey(authToken)) === '1';
  } catch {
    return false;
  }
}

function writeOnboardingMarker(authToken: string | null | undefined, value: boolean): void {
  if (!authToken) return;
  try {
    const key = onboardingMarkerKey(authToken);
    if (value) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable (private mode / quota) — degrade silently */
  }
}

function clearOnboardingMarkers(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key === ONBOARDING_STORAGE_KEY || key?.startsWith(`${ONBOARDING_STORAGE_KEY}:`)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* storage unavailable (private mode / quota) — degrade silently */
  }
}

// Helper types and algorithms relocated from App.tsx
type LooseRecord = Record<string, unknown>;

// Bounded retry: stop polling /details for a fragrance whose Fragrantica
// status payload never fully decodes, so a permanently-partial item does not
// poll forever. Counted off enrichment.requested_count.
const MAX_ENRICHMENT_ATTEMPTS = 8;
const DETAIL_REFRESH_POLL_MS = 15_000;
const DETAIL_REFRESH_EMPTY_BACKOFF_MS = 3 * 60_000;
const DETAIL_REFRESH_BASE_BACKOFF_MS = 60_000;
const DETAIL_REFRESH_MAX_BACKOFF_MS = 10 * 60_000;

type DetailRefreshBackoffMeta = {
  nextEligibleAt: number;
  attemptCount: number;
  lastStatus: string;
};

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

const UNKNOWN_FACT_VALUES = new Set(['unknown', 'n/a', 'na', 'none', 'null']);

const titleFactValue = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (word.length <= 3 && word === word.toUpperCase()
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');

const usefulFactString = (value: unknown, options?: { rejectUniversal?: boolean }): string | undefined => {
  const raw = firstString(value);
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (UNKNOWN_FACT_VALUES.has(normalized)) return undefined;
  if (options?.rejectUniversal && normalized === 'universal') return undefined;
  return raw.trim();
};

const detailRefreshFactPatch = (detail: FragranceDetail): Partial<Pick<Fragrance, 'year' | 'gender' | 'concentration' | 'season'>> => {
  const patch: Partial<Pick<Fragrance, 'year' | 'gender' | 'concentration' | 'season'>> = {};

  if (typeof detail.year === 'number' && Number.isFinite(detail.year)) {
    patch.year = Math.trunc(detail.year);
  }

  const gender = usefulFactString(detail.gender);
  if (gender) patch.gender = gender;

  const concentration = usefulFactString(detail.concentration);
  if (concentration) patch.concentration = concentration;

  const explicitSeason = usefulFactString(detail.season, { rejectUniversal: true });
  const derivedSeasons = detail.derived_metrics?.wear_profile?.primary_seasons
    ?.map((season) => usefulFactString(season, { rejectUniversal: true }))
    .filter((season): season is string => Boolean(season));
  const season = explicitSeason ?? (
    derivedSeasons && derivedSeasons.length > 0
      ? uniqueStrings(derivedSeasons).map(titleFactValue).join(' / ')
      : undefined
  );
  if (season) patch.season = season;

  return patch;
};

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const collectStrings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  return [];
};

function readGuestWardrobeItems(): Fragrance[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    const raw = localStorage.getItem(GUEST_WARDROBE_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((value): Fragrance[] => {
      if (!isLooseRecord(value)) return [];

      const product = isLooseRecord(value.product) ? value.product : null;
      const id = firstString(value.id, value._dbId);
      const name = firstString(value.name, product?.name);
      const brand = firstString(value.brand, value.house, product?.brand);
      if (!id || !name || !brand) return [];

      return [{
        ...value,
        id,
        name,
        brand,
        imageUrl: typeof value.imageUrl === 'string' ? value.imageUrl : '',
        season: firstString(value.season) ?? 'Universal',
      } as Fragrance];
    });
  } catch {
    return [];
  }
}

function writeGuestWardrobeItems(items: Fragrance[]): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(GUEST_WARDROBE_STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable (private mode / quota) - keep in-memory state only */
  }
}

// One-time accord-heal re-sync.
//
// A vault row's accords/derived_metrics are snapshotted at add-time and then
// frozen: once `fragrantica_metrics_complete` is true the background refresh
// (`wardrobeNeedsEnrichmentRefresh`) treats the row as done and never re-fetches.
// That is correct for steady state, but it also means rows captured *before* an
// upstream data healing keep their stale (pre-heal) accords forever. Bumping
// this version forces each existing complete row to re-fetch from the (now
// healed) engine exactly once, persist the clean metrics, and then mark itself
// done so it never re-syncs again. Bump the integer whenever a catalog/engine
// data healing needs to land on already-saved vault rows.
const ACCORD_HEAL_RESYNC_VERSION = 1;

function accordHealResyncStorageKey(token: string): string {
  return `scent_accord_heal_resync_${token}`;
}

function readAccordHealResyncDone(token: string): Set<string> {
  if (typeof localStorage === 'undefined' || !token) return new Set();
  try {
    const raw = localStorage.getItem(accordHealResyncStorageKey(token));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { v?: number; ids?: unknown };
    // A version mismatch means a new heal needs to run: discard prior progress.
    if (parsed?.v !== ACCORD_HEAL_RESYNC_VERSION) return new Set();
    return new Set(Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeAccordHealResyncDone(token: string, ids: Set<string>): void {
  if (typeof localStorage === 'undefined' || !token) return;
  try {
    localStorage.setItem(
      accordHealResyncStorageKey(token),
      JSON.stringify({ v: ACCORD_HEAL_RESYNC_VERSION, ids: [...ids] }),
    );
  } catch {
    /* storage unavailable (private mode / quota) - resync just retries next load */
  }
}

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

function detailRefreshKeyFor(item: Pick<Fragrance, 'id' | '_dbId'>): string {
  return item._dbId ?? item.id;
}

function detailRefreshBackoffDelay(attemptCount: number): number {
  return Math.min(
    DETAIL_REFRESH_MAX_BACKOFF_MS,
    DETAIL_REFRESH_BASE_BACKOFF_MS * 2 ** Math.max(0, attemptCount - 1),
  );
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

function wardrobeNeedsIncompleteRecovery(item: Fragrance): boolean {
  if (fgMetricsComplete(item) || sourceCoverageComplete(item)) return false;
  const status = normalizedEnrichmentStatus(item);
  if (status !== 'completed' && status !== 'complete') return false;
  return hasFragranticaRefreshTarget(item);
}

function wardrobeNeedsEnrichmentRefresh(item: Fragrance): boolean {
  const enrichment = item.enrichment ?? item.raw_engine_detail?.enrichment;
  if (fgMetricsComplete(item) || sourceCoverageComplete(item)) return false;
  if (isBackgroundEnrichmentQueued(enrichment)) return true;
  const status = normalizedEnrichmentStatus(item);
  if (status === 'completed' || status === 'complete') return wardrobeNeedsIncompleteRecovery(item);
  if (status === 'not_needed') return false;
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
  const recoveryFlag = wardrobeNeedsIncompleteRecovery(item)
    ? { recover_incomplete: true }
    : {};
  if (engineId) {
    const origin = engineId.startsWith('catalog:') ||
      engineId.startsWith('dataset:') ||
      engineId.startsWith('local:')
      ? 'app'
      : 'srt';
    return { id: engineId, ...(sourceUrl ? { source_url: sourceUrl } : {}), origin, ...recoveryFlag };
  }
  return sourceUrl ? { source_url: sourceUrl, origin: 'srt', ...recoveryFlag } : null;
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
  const dm = item.raw_engine_detail?.derived_metrics ?? item.derived_metrics ?? null;
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
  onboardingCompleted: boolean;
  /** False until app-state has been fetched for the signed-in user (guests: true). */
  onboardingResolved: boolean;
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
  /** True when the signed-in user is an admin (server-confirmed via app-state). */
  isAdmin: boolean;
  /** True while a freshly-added imageless tile is actively backfilling its image. */
  isImageSyncing: (item: Pick<Fragrance, 'id' | '_dbId'>) => boolean;
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
  handlePersistWardrobeImage: (target: Fragrance, imageUrl?: string, imageAdjustment?: BottleImageAdjustment, options?: { suppressToast?: boolean }) => Promise<Fragrance | null>;
  /** Admin-only: re-host an uploaded file / URL and return a persistable image URL. */
  uploadAdminBottleImage: (input: {
    brand: string;
    name: string;
    fragranceId?: string | null;
    file?: File;
    imageUrl?: string;
    sourcePageUrl?: string;
    removeBackground: boolean;
  }) => Promise<{ imageUrl: string; imageHash?: string; backgroundRemoved: boolean }>;
  handlePersistWardrobeDetailRefresh: (target: Fragrance, detail: FragranceDetail) => Promise<Fragrance | null>;
  handleRevertWardrobe: () => void;
  handleDeleteItem: (target: Fragrance) => Promise<void>;
  handleIntentComplete: (intent: { destination: DestinationType; energy: EnergyState }) => void;
  closeRecommendationOverlay: () => void;
  handleVaultSearchStateChange: (active: boolean) => void;
  handleExpandArchive: (options?: { target?: 'hero' | 'vault' }) => void;
}

const WardrobeContext = createContext<WardrobeContextType | undefined>(undefined);
const WardrobeItemsContext = createContext<Fragrance[] | undefined>(undefined);
const WardrobeShareModalActionsContext = createContext<Pick<WardrobeContextType, 'setIsShareModalOpen'> | undefined>(undefined);

export const WardrobeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { authToken, setIsAuthModalOpen, guestPromptDismissed, handleSignOut } = useAuth();
  const { weather } = useWeather();
  const { toast } = useToast();

  const [items, setItems] = useState<Fragrance[]>(() =>
    authToken ? [] : readGuestWardrobeItems(),
  );
  const [wardrobeLoaded, setWardrobeLoaded] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean>(false);
  const [onboardingResolved, setOnboardingResolved] = useState<boolean>(false);
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
  // Admin flag from GET /api/me/app-state. UI hint only — the upload route
  // enforces admin access server-side regardless of this value.
  const [isAdmin, setIsAdmin] = useState(false);

  const autoWardrobeRebuildAttemptedRef = useRef(false);
  const enrichmentRefreshInFlightRef = useRef(false);
  const detailRefreshBackoffRef = useRef<Map<string, DetailRefreshBackoffMeta>>(new Map());
  const detailRefreshIdleUntilRef = useRef(0);
  const isMutatingRef = useRef(false);
  // Vault rows already re-synced for the current ACCORD_HEAL_RESYNC_VERSION.
  const accordHealResyncDoneRef = useRef<Set<string>>(new Set());
  const lastMutationRef = useRef(0);
  // Last ETag returned by GET /api/wardrobe; sent as If-None-Match on the
  // conditional interval poll so the server can answer 304 when nothing changed.
  const wardrobeEtagRef = useRef<string | null>(null);
  const appStateRefreshInFlightRef = useRef(false);
  const imageBackfillTimersRef = useRef<number[]>([]);
  // The single fragrance whose image is being actively backfilled (one burst runs
  // at a time — see `scheduleImageBackfillRehydrate`). Drives the honest "fetching
  // image…" affordance so a freshly-added imageless tile shows a spinner *while it
  // is genuinely syncing*, then settles to "No image" once the burst gives up —
  // rather than spinning forever (FE-1) or lying with "No image" mid-fetch.
  const [imageSyncTarget, setImageSyncTarget] = useState<Pick<Fragrance, 'id' | '_dbId'> | null>(null);
  const itemsRef = useRef(items);
  const authTokenRef = useRef(authToken);
  const previousGuestPersistenceAuthRef = useRef(authToken);
  itemsRef.current = items;
  authTokenRef.current = authToken;

  useEffect(() => {
    if (authToken) {
      previousGuestPersistenceAuthRef.current = authToken;
      return;
    }

    if (previousGuestPersistenceAuthRef.current) {
      previousGuestPersistenceAuthRef.current = authToken;
      return;
    }

    writeGuestWardrobeItems(items);
    previousGuestPersistenceAuthRef.current = authToken;
  }, [authToken, items]);

  const handleVaultSearchStateChange = useCallback((active: boolean) => {
    setVaultSearchUiActive(active);
  }, []);

  const handleExpandArchive = useCallback((options?: { target?: 'hero' | 'vault' }) => {
    setVaultSearchUiActive(true);
    const target = options?.target ?? 'hero';
    const searchInputIds =
      target === 'vault'
        ? ['wardrobe-vault-search', 'scent-add-to-vault-search']
        : ['scent-add-to-vault-search', 'wardrobe-vault-search'];

    const focusSearch = () => {
      const el = searchInputIds
        .map((id) => document.getElementById(id))
        .find((candidate): candidate is HTMLInputElement => candidate instanceof HTMLInputElement);
      if (!el) return false;

      el.focus({ preventScroll: true });
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    };
    // Focus synchronously, inside the click's user-gesture, so the search field
    // visibly activates (and the mobile keyboard opens) on every platform.
    // Deferring focus to a setTimeout breaks the user-gesture chain on iOS
    // Safari, where focus() is then silently ignored — which made the empty-vault
    // "Add a fragrance" button appear to do nothing for guests. Scroll after, so
    // the field is both focused and centered in view.
    focusSearch();

    window.requestAnimationFrame(() => {
      if (focusSearch()) return;

      window.requestAnimationFrame(() => {
        focusSearch();
      });
    });
  }, []);

  const loadWardrobe = useCallback(async (
    token: string,
    signal?: AbortSignal,
    opts?: { conditional?: boolean },
  ) => {
    if (isMutatingRef.current) return;
    const now = Date.now();
    if (now - lastMutationRef.current < 5000) return;

    setWardrobeError(null);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      // Conditional poll: let the server short-circuit with 304 when nothing in
      // user_fragrances changed since our last copy, so an idle tab stops
      // re-pulling the whole wardrobe. Only the steady-state interval tick is
      // conditional; focus/visibility and initial loads fetch unconditionally.
      if (opts?.conditional && wardrobeEtagRef.current) {
        headers['If-None-Match'] = wardrobeEtagRef.current;
      }
      const res = await fetch('/api/wardrobe', { headers, signal });
      if (res.status === 304) {
        // Server confirmed our copy is current — leave items untouched.
        return;
      }
      const etag = res.headers.get('ETag');
      if (etag) wardrobeEtagRef.current = etag;
      if (res.status === 401) {
        // Token is missing/stale (e.g. left over from a DB reset). The backend
        // rejected it, so this is not a network problem; clear the dead token
        // and re-prompt login instead of looping on a generic "sync failed".
        handleSignOut();
        setWardrobeError(null);
        setIsAuthModalOpen(true);
        toast({
          title: "Session Expired",
          description: "Please sign in again to sync your wardrobe.",
        });
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: Fragrance[] = await res.json();
      // Discard a payload that resolved across a mutation. The entry guard only
      // caught loads that *started* during a mutation; a poll already in-flight
      // when the user saves (e.g. Find Image) finishes after isMutatingRef has
      // flipped back to false and would otherwise stomp the optimistic image
      // with stale rows — the "tester → old image → tester" flicker. The 5s
      // cooldown matches the entry guard above.
      if (isMutatingRef.current) return;
      if (Date.now() - lastMutationRef.current < 5000) return;
      setItems((prev) => reconcileWardrobeItems(prev, data));
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
  }, [toast, handleSignOut, setIsAuthModalOpen]);

  const retryLoadWardrobe = useCallback(() => {
    if (authToken) {
      lastMutationRef.current = 0;
      loadWardrobe(authToken);
    }
  }, [authToken, loadWardrobe]);

  const clearImageBackfillTimers = useCallback(() => {
    for (const id of imageBackfillTimersRef.current) {
      window.clearTimeout(id);
    }
    imageBackfillTimersRef.current = [];
    // Stopping the burst (image arrived, row deleted, auth changed, or unmount)
    // also drops the syncing affordance — the tile reverts to its real state.
    setImageSyncTarget(null);
  }, []);

  // Guest backfill probe: guests have no server wardrobe row to re-hydrate, so
  // instead of reloading `/api/wardrobe` we read the SHARED image state for this
  // brand/name via `GET /api/shared-image`. That endpoint is cache-only (no Serper
  // search), so polling it on the bounded schedule below is cheap and never turns
  // a guest add into a blocking image search. When an image is found we merge it
  // into the local guest item and persist to localStorage — but only if the item
  // is still imageless, so a background probe can never clobber a real image the
  // guest already has (or just set via "Find image").
  const pollGuestSharedImage = useCallback(async (target: Fragrance) => {
    const brand = firstString(target.brand, (target as { house?: string }).house) ?? '';
    const name = firstString(target.name);
    if (!name) return;
    try {
      const params = new URLSearchParams({ brand, name });
      const res = await fetch(appApiUrl(`/api/shared-image?${params.toString()}`));
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as { imageUrl?: string | null } | null;
      const imageUrl = typeof data?.imageUrl === 'string' ? data.imageUrl.trim() : '';
      if (!imageUrl) return;
      let applied = false;
      setItems((prev) => {
        const next = prev.map((item) => {
          if (!sameWardrobeEntry(item, target)) return item;
          // Safety: never overwrite an existing non-empty image during background
          // backfill — the guest's own image always wins.
          if (typeof item.imageUrl === 'string' && item.imageUrl.trim().length > 0) return item;
          applied = true;
          return { ...item, imageUrl };
        });
        if (applied) writeGuestWardrobeItems(next);
        return next;
      });
      if (applied) clearImageBackfillTimers();
    } catch {
      /* non-fatal: the next scheduled poll (or the give-up timer) handles it */
    }
  }, [clearImageBackfillTimers]);

  // New fragrances save with no image: `POST /api/scent-profile` resolves images
  // deferred (returns empty now, backfills the shared catalog in the background),
  // so the tile only fills in when the shared catalog re-hydrates. Without help the
  // soonest that happens for a signed-in user is the 60s background poll — the tile
  // sits on "No image" for up to a minute; guests would never see it fill in at all.
  // Kick a short, decaying burst so the image appears within seconds. `token` is the
  // auth token for a signed-in save (re-hydrates `/api/wardrobe`) or `null` for a
  // guest save (probes the cache-only `/api/shared-image`). Delays clear the 5s
  // post-mutation cooldown in `loadWardrobe` and stop early once the image arrives.
  const scheduleImageBackfillRehydrate = useCallback(
    (target: Fragrance, token: string | null) => {
      clearImageBackfillTimers();
      // Mark the tile as actively syncing for the lifetime of the burst.
      setImageSyncTarget(target);
      const POLL_SCHEDULE_MS = [6000, 12000, 20000, 32000, 48000];
      for (const delay of POLL_SCHEDULE_MS) {
        const id = window.setTimeout(() => {
          // Auth changed since the burst began (signed in or out) → abandon: the
          // freshly-relevant mode owns the tile now. For a guest burst `token` is
          // null, so this fires the moment a token appears mid-burst.
          if (authTokenRef.current !== token) {
            clearImageBackfillTimers();
            return;
          }
          const current = itemsRef.current.find((item) => sameWardrobeEntry(item, target));
          const resolved =
            typeof current?.imageUrl === 'string' && current.imageUrl.trim().length > 0;
          // Row gone (deleted) or image already arrived → stop the remaining burst.
          if (!current || resolved) {
            clearImageBackfillTimers();
            return;
          }
          if (token) {
            void loadWardrobe(token);
          } else {
            void pollGuestSharedImage(target);
          }
        }, delay);
        imageBackfillTimersRef.current.push(id);
      }
      // Hard stop just after the final poll: if the image still hasn't landed,
      // drop the syncing affordance so the tile settles to "No image" instead of
      // spinning indefinitely. This guarantees the spinner is always bounded —
      // never reintroducing the perpetual-spinner bug FE-1 fixed.
      const giveUpId = window.setTimeout(() => {
        setImageSyncTarget((current) =>
          current && sameWardrobeEntry(current, target) ? null : current,
        );
      }, POLL_SCHEDULE_MS[POLL_SCHEDULE_MS.length - 1] + 4000);
      imageBackfillTimersRef.current.push(giveUpId);
    },
    [clearImageBackfillTimers, loadWardrobe, pollGuestSharedImage],
  );

  useEffect(() => clearImageBackfillTimers, [clearImageBackfillTimers]);

  // True only while a tile's image is being actively backfilled, so the UI can
  // show "fetching image…" instead of a premature "No image". Matches the burst's
  // own `sameWardrobeEntry` logic so it survives the id→_dbId hydration swap.
  const isImageSyncing = useCallback(
    (item: Pick<Fragrance, 'id' | '_dbId'>) =>
      imageSyncTarget != null && sameWardrobeEntry(item, imageSyncTarget),
    [imageSyncTarget],
  );

  const loadAppState = useCallback(async (token: string, signal?: AbortSignal): Promise<boolean> => {
    const res = await fetch('/api/me/app-state', {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) {
      throw new Error(`App-state fetch failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { wardrobeOnboardingCompleted?: boolean; isAdmin?: boolean };
    const completed = Boolean(data.wardrobeOnboardingCompleted);
    if (authTokenRef.current === token) {
      setOnboardingCompleted(completed);
      setIsAdmin(Boolean(data.isAdmin));
      writeOnboardingMarker(token, completed);
    }
    return completed;
  }, []);

  const refreshOnboardingCompletionFromServer = useCallback(async (token: string) => {
    if (appStateRefreshInFlightRef.current) return;
    appStateRefreshInFlightRef.current = true;
    try {
      await loadAppState(token);
    } catch (err) {
      console.error('Failed to reconcile app-state', err);
    } finally {
      appStateRefreshInFlightRef.current = false;
    }
  }, [loadAppState]);

  // Reset auto-rebuild attempt on auth change
  useEffect(() => {
    autoWardrobeRebuildAttemptedRef.current = false;
    appStateRefreshInFlightRef.current = false;
    detailRefreshBackoffRef.current.clear();
    detailRefreshIdleUntilRef.current = 0;
    // Clear admin until app-state reconfirms it for the new token (and on sign-out).
    setIsAdmin(false);
  }, [authToken]);

  // Load wardrobe & share settings on login
  useEffect(() => {
    const abortController = new AbortController();

    if (authToken) {
      setWardrobeLoaded(false);
      setItems([]);
      loadWardrobe(authToken, abortController.signal);
      fetch('/api/share-settings', {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: abortController.signal,
      })
        .then(r => {
          if (!r.ok) throw new Error("Settings fetch failed");
          return r.json();
        })
        .then(d => { if (d.userId) setUserId(d.userId); })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            console.error("Settings load failed", err);
          }
        });
    } else {
      setWardrobeLoaded(true);
    }

    return () => abortController.abort();
  }, [authToken, loadWardrobe, toast]);

  // Durable onboarding/discovery state. Fetched independently of /api/wardrobe so
  // a slow or empty wardrobe load cannot flash the add-3 flow at a completed user.
  // Server state wins; a 401 here is left to the wardrobe loader's recovery path.
  useEffect(() => {
    if (!authToken) return;
    const abortController = new AbortController();
    setOnboardingResolved(false);
    setOnboardingCompleted(readOnboardingMarker(authToken));

    void (async () => {
      try {
        await loadAppState(authToken, abortController.signal);
      } catch (err) {
        if ((err as Error).name !== 'AbortError' && authTokenRef.current === authToken) {
          console.error('Failed to load app-state', err);
          setOnboardingCompleted(false);
          writeOnboardingMarker(authToken, false);
        }
      } finally {
        if (!abortController.signal.aborted && authTokenRef.current === authToken) {
          setOnboardingResolved(true);
        }
      }
    })();

    return () => abortController.abort();
  }, [authToken, loadAppState]);

  // Completion is durable only after the server sees a persisted wardrobe count
  // at or above the threshold. This catches background/tab updates without
  // trusting transient optimistic items while a save is still in flight.
  useEffect(() => {
    if (!authToken || onboardingCompleted) return;
    if (items.length >= WARDROBE_ONBOARDING_THRESHOLD && !isMutatingRef.current) {
      void refreshOnboardingCompletionFromServer(authToken);
    }
  }, [authToken, items.length, onboardingCompleted, refreshOnboardingCompletionFromServer]);

  // Background polling wardrobe updates.
  //
  // The interval tick is a CONDITIONAL GET (sends If-None-Match): when nothing
  // in user_fragrances changed, the server answers 304 from a cheap
  // count+max(updated_at) probe — a few bytes — instead of re-pulling the full
  // JSONB wardrobe over the metered Supabase → Express hop. That lets us keep a
  // prompt 60s cadence for cross-device edits at near-zero idle egress (the
  // 60s × fat-payload poll on long-open tabs was the dominant egress burner).
  //
  // The visibility/focus tick fetches UNCONDITIONALLY so returning to a tab
  // always re-runs image hydration and surfaces any opportunistic image-cache
  // improvement, which the user_fragrances-scoped ETag deliberately ignores.
  useEffect(() => {
    if (!authToken) return;
    const REFRESH_MS = 60_000;

    const intervalTick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void loadWardrobe(authToken, undefined, { conditional: true });
    };

    const id = window.setInterval(intervalTick, REFRESH_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadWardrobe(authToken);
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
      const nextItems = [newItem, ...prev];
      nextCount = nextItems.length;
      if (!authToken) {
        writeGuestWardrobeItems(nextItems);
      }
      return nextItems;
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
          if (nextCount >= WARDROBE_ONBOARDING_THRESHOLD && !onboardingCompleted) {
            try {
              await loadAppState(authToken);
            } catch (err) {
              console.error('Failed to persist onboarding completion after wardrobe save', err);
            }
          }
          toast({
            title: "Fragrance Enshrined",
            description: `${newItem.name} has been synced with your database.`
          });
          // Deferred image resolution saves the row imageless; poll the catalog
          // re-hydrate quickly instead of waiting for the 60s background tick.
          const savedHasImage =
            typeof savedItem.imageUrl === 'string' && savedItem.imageUrl.trim().length > 0;
          if (!savedHasImage) {
            scheduleImageBackfillRehydrate(savedItem, authToken);
          }
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
    }

    // Guest path (the signed-in branch above always returns). A guest add lands
    // imageless in local storage, so kick the same bounded burst — in guest mode
    // it probes the cache-only `/api/shared-image` and merges any found image into
    // local storage, instead of re-hydrating a (non-existent) server row.
    const guestHasImage =
      typeof newItem.imageUrl === 'string' && newItem.imageUrl.trim().length > 0;
    if (!guestHasImage) {
      scheduleImageBackfillRehydrate(newItem, null);
    }

    if (nextCount >= GUEST_SAVE_PROMPT_THRESHOLD && !guestPromptDismissed) {
      setIsAuthModalOpen(true);
      return { persisted: false, requiresAuth: true };
    }

    return { persisted: false, requiresAuth: !authToken };
  }, [authToken, guestPromptDismissed, loadAppState, onboardingCompleted, scheduleImageBackfillRehydrate, setIsAuthModalOpen, toast]);

  const handlePersistWardrobeImage = useCallback(async (
    target: Fragrance,
    imageUrl?: string,
    imageAdjustment?: BottleImageAdjustment,
    options?: { suppressToast?: boolean },
  ): Promise<Fragrance | null> => {
    // Background curation (handleCurateCollection) drives this in a loop to
    // backfill bottle images the user never manually edited. Those passes must
    // stay silent — otherwise each item stacks a "Portrait Saved" toast, which
    // on iPad/iOS piles up because a tap's simulated hover pauses Radix's
    // auto-dismiss timer and the toasts never clear. Only surface toasts for
    // genuine, user-initiated portrait edits.
    const suppressToast = options?.suppressToast ?? false;
    if (!authToken) {
      // Guest: there is no server row to PATCH, so persist the chosen image and/or
      // framing onto the local item + localStorage. This is what lets a guest's
      // manual "Find image" preview actually stick instead of being a throwaway
      // preview. We only touch the matched item and leave everything else intact.
      let next: Fragrance | null = null;
      setItems((prev) => {
        const updated = prev.map((item) => {
          if (!sameWardrobeEntry(item, target)) return item;
          next = {
            ...item,
            ...(imageUrl ? { imageUrl } : {}),
            ...(imageAdjustment ? { imageAdjustment } : {}),
          };
          return next;
        });
        if (next) writeGuestWardrobeItems(updated);
        return updated;
      });
      if (next && !suppressToast) {
        toast({ title: "Portrait Saved", description: "Bottle display styling aligned." });
      }
      return next;
    }
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
      if (!suppressToast) {
        toast({
          title: "Portrait Saved",
          description: "Bottle display styling aligned."
        });
      }
      return next;
    } catch (e) {
      console.error(e);
      if (!suppressToast) {
        toast({
          title: "Image Sync Error",
          description: "Failed to persist portrait changes.",
          variant: "destructive"
        });
      }
      return null;
    } finally {
      isMutatingRef.current = false;
      lastMutationRef.current = Date.now();
    }
  }, [authToken, toast]);

  // Admin-only: upload/replace a bottle image (file or URL) via the re-hosting
  // endpoint, returning a persistable storage URL. The caller then runs the
  // returned URL through the normal preview -> handlePersistWardrobeImage save
  // path, so this does not touch wardrobe state itself. Throws on failure so the
  // editor can surface a clear error and keep the original image.
  const uploadAdminBottleImage = useCallback(async (input: {
    brand: string;
    name: string;
    fragranceId?: string | null;
    file?: File;
    imageUrl?: string;
    sourcePageUrl?: string;
    removeBackground: boolean;
  }): Promise<{ imageUrl: string; imageHash?: string; backgroundRemoved: boolean }> => {
    if (!authToken) throw new Error('Sign in required');

    let res: Response;
    if (input.file) {
      const params = new URLSearchParams({
        brand: input.brand,
        name: input.name,
        removeBackground: String(input.removeBackground),
      });
      if (input.fragranceId) params.set('fragranceId', String(input.fragranceId));
      res = await fetch(`/api/admin/bottle-image/upload?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': input.file.type || 'application/octet-stream',
        },
        body: input.file,
      });
    } else {
      res = await fetch('/api/admin/bottle-image/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          imageUrl: input.imageUrl,
          sourcePageUrl: input.sourcePageUrl,
          brand: input.brand,
          name: input.name,
          removeBackground: input.removeBackground,
          fragranceId: input.fragranceId ?? undefined,
        }),
      });
    }

    const data = (await res.json().catch(() => ({}))) as {
      imageUrl?: string;
      imageHash?: string;
      backgroundRemoved?: boolean;
      error?: string;
    };
    if (!res.ok || !data.imageUrl) {
      throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
    }
    return {
      imageUrl: data.imageUrl,
      imageHash: data.imageHash,
      backgroundRemoved: Boolean(data.backgroundRemoved),
    };
  }, [authToken]);

  const handlePersistWardrobeDetailRefresh = useCallback(async (
    target: Fragrance,
    detail: FragranceDetail,
  ): Promise<Fragrance | null> => {
    if (!authToken) return null;
    const apiId = target._dbId ?? target.id;
    isMutatingRef.current = true;
    try {
      const factPatch = detailRefreshFactPatch(detail);
      const res = await fetch(`/api/wardrobe/${apiId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          ...factPatch,
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

  const handlePersistWardrobeDetailRefreshBatch = useCallback(async (
    updates: Array<{ target: Fragrance; detail: FragranceDetail }>,
  ): Promise<Fragrance[]> => {
    if (!authToken || updates.length === 0) return [];
    isMutatingRef.current = true;
    try {
      const res = await fetch('/api/wardrobe/detail-refresh/batch', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          updates: updates.map(({ target, detail }) => {
            const factPatch = detailRefreshFactPatch(detail);
            return {
              id: target._dbId ?? target.id,
              ...factPatch,
              derived_metrics: detail.derived_metrics ?? null,
              source_coverage: detail.source_coverage,
              enrichment: detail.enrichment ?? null,
              raw_engine_detail: detail,
            };
          }),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        items?: Array<Partial<Fragrance> & { _dbId?: string; error?: string }>;
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      const returned = Array.isArray(data?.items) ? data.items : [];
      const mergedPairs = updates.flatMap(({ target, detail }) => {
        const apiId = target._dbId ?? target.id;
        const row = returned.find((item) =>
          item._dbId === target._dbId ||
          item._dbId === apiId ||
          item.id === apiId ||
          item.id === target.id,
        );
        if (!row) return [];
        const next = {
          ...target,
          ...row,
          id: target.id,
          derived_metrics: detail.derived_metrics ?? null,
          source_coverage: detail.source_coverage,
          enrichment: detail.enrichment ?? null,
          raw_engine_detail: detail,
          _dbId: row._dbId ?? target._dbId,
        } as Fragrance;
        return [{ target, next }];
      });

      if (mergedPairs.length > 0) {
        setItems((prev) =>
          prev.map((item) => mergedPairs.find((pair) => sameWardrobeEntry(item, pair.target))?.next ?? item),
        );
      }
      return mergedPairs.map((pair) => pair.next);
    } catch (e) {
      console.error('Failed to persist batched wardrobe detail refresh', e);
      return [];
    } finally {
      isMutatingRef.current = false;
      lastMutationRef.current = Date.now();
    }
  }, [authToken]);

  // Load (or reset on version bump) the per-token accord-heal re-sync progress.
  useEffect(() => {
    accordHealResyncDoneRef.current = readAccordHealResyncDone(authToken ?? '');
  }, [authToken]);

  // Background detail enrichments scheduler
  useEffect(() => {
    if (!authToken || !wardrobeLoaded || items.length === 0) return;
    const abortController = new AbortController();
    let cancelled = false;

    // One-time heal re-sync: a complete row that the normal refresh path would
    // skip still gets re-fetched once if it hasn't been re-synced for the
    // current heal version. After a successful persist it is marked done below.
    const needsAccordHealResync = (item: Fragrance): boolean => {
      if (accordHealResyncDoneRef.current.has(detailRefreshKeyFor(item))) return false;
      if (!(fgMetricsComplete(item) || sourceCoverageComplete(item))) return false;
      return hasFragranticaRefreshTarget(item);
    };

    const markAccordHealResynced = (item: Fragrance) => {
      const key = detailRefreshKeyFor(item);
      if (accordHealResyncDoneRef.current.has(key)) return;
      accordHealResyncDoneRef.current.add(key);
      writeAccordHealResyncDone(authToken, accordHealResyncDoneRef.current);
    };

    const noteBackoff = (item: Fragrance, status: string) => {
      const key = detailRefreshKeyFor(item);
      const current = detailRefreshBackoffRef.current.get(key);
      const attemptCount = (current?.attemptCount ?? 0) + 1;
      detailRefreshBackoffRef.current.set(key, {
        attemptCount,
        lastStatus: status,
        nextEligibleAt: Date.now() + detailRefreshBackoffDelay(attemptCount),
      });
    };

    const clearBackoff = (item: Fragrance) => {
      detailRefreshBackoffRef.current.delete(detailRefreshKeyFor(item));
    };

    const refreshPendingDetails = async () => {
      if (cancelled || enrichmentRefreshInFlightRef.current || isMutatingRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (detailRefreshIdleUntilRef.current > now) return;
      const targets = itemsRef.current
        .filter((item) => wardrobeNeedsEnrichmentRefresh(item) || needsAccordHealResync(item))
        .filter((item) => {
          const meta = detailRefreshBackoffRef.current.get(detailRefreshKeyFor(item));
          return !meta || meta.nextEligibleAt <= now;
        })
        .slice(0, 3);
      if (targets.length === 0) {
        detailRefreshIdleUntilRef.current = now + DETAIL_REFRESH_EMPTY_BACKOFF_MS;
        return;
      }
      detailRefreshIdleUntilRef.current = 0;

      enrichmentRefreshInFlightRef.current = true;
      try {
        const readyUpdates: Array<{ target: Fragrance; detail: FragranceDetail }> = [];
        for (const item of targets) {
          if (cancelled) break;
          const payload = detailRefreshPayloadFor(item);
          if (!payload) {
            noteBackoff(item, 'missing_payload');
            continue;
          }
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
          if (!metricsComplete && isBackgroundEnrichmentQueued(detail.enrichment)) {
            setItems((prev) =>
              prev.map((existing) =>
                sameWardrobeEntry(existing, item)
                  ? {
                      ...existing,
                      enrichment: detail.enrichment ?? existing.enrichment,
                      source_coverage: detail.source_coverage ?? existing.source_coverage,
                      raw_engine_detail: {
                        ...(existing.raw_engine_detail ?? {}),
                        enrichment:
                          detail.enrichment ?? existing.raw_engine_detail?.enrichment,
                        source_coverage:
                          detail.source_coverage ??
                          existing.raw_engine_detail?.source_coverage,
                      },
                    }
                  : existing,
              ),
            );
            noteBackoff(item, String(detail.enrichment?.status ?? 'queued'));
            continue;
          }
          readyUpdates.push({ target: item, detail });
        }

        if (readyUpdates.length > 0) {
          const persisted = await handlePersistWardrobeDetailRefreshBatch(readyUpdates);
          for (const update of readyUpdates) {
            const wasPersisted = persisted.some((item) =>
              item.id === update.target.id || sameWardrobeEntry(item, update.target),
            );
            if (wasPersisted) {
              clearBackoff(update.target);
              markAccordHealResynced(update.target);
            } else {
              noteBackoff(update.target, 'persist_failed');
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('Background fragrance detail refresh failed', err);
          for (const item of targets) noteBackoff(item, 'request_failed');
        }
      } finally {
        enrichmentRefreshInFlightRef.current = false;
      }
    };

    void refreshPendingDetails();
    const id = window.setInterval(refreshPendingDetails, DETAIL_REFRESH_POLL_MS);
    return () => {
      cancelled = true;
      abortController.abort();
      window.clearInterval(id);
    };
  }, [authToken, wardrobeLoaded, items.length, handlePersistWardrobeDetailRefreshBatch]);

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
      // Rethrow so the detail modal that triggered the delete can stay open
      // and show inline failure feedback instead of silently closing.
      throw err instanceof Error ? err : new Error(String(err));
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

  // Hydrate local guest items whenever there is no signed-in wardrobe.
  useEffect(() => {
    if (!authToken) {
      setItems(readGuestWardrobeItems());
      setWardrobeLoaded(true);
      setWardrobeError(null);
      setWardrobeRevertSnapshot(null);
      setWardrobeFixHint(null);
      // Clear onboarding state so a different account signing in on this device
      // does not inherit the previous user's completed state. Guests have no
      // server state to wait on, so treat them as already resolved.
      setOnboardingCompleted(false);
      clearOnboardingMarkers();
      setOnboardingResolved(true);
    }
  }, [authToken]);

  const contextValue = useMemo<WardrobeContextType>(() => ({
    items,
    wardrobeLoaded,
    onboardingCompleted,
    onboardingResolved,
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
    isAdmin,
    isImageSyncing,
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
    uploadAdminBottleImage,
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
    onboardingCompleted,
    onboardingResolved,
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
    isAdmin,
    isImageSyncing,
    loadWardrobe,
    retryLoadWardrobe,
    handleAddItem,
    handlePersistWardrobeImage,
    uploadAdminBottleImage,
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
