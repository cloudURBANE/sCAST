import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from './AuthContext';
import { useWeather } from './WeatherContext';
import { useToast } from '@/hooks/use-toast';
import type { Fragrance, DestinationType, EnergyState } from '@/components/Wardrobe';
import type { BottleImageAdjustment } from '@/lib/bottleImageAdjustment';
import { reconcileWardrobeItems } from '@/lib/wardrobeReconcile';
import { displayableVaultImageUrl } from '@/lib/vaultImagePolicy';
import { vaultIdentityKey } from '@/lib/vaultIdentity';
import {
  calculateScentWeatherRecommendation,
  traitsMatchScentFamily,
  type ScentFamily,
  type ScentWeatherEngineInput,
  type ScentWeatherRecommendation,
} from '@/lib/scentWeatherEngine';
import {
  dayCandidateScore,
  familyAlignmentScore,
  planWeeklyOutlook,
  type OutlookCandidate,
  type OutlookDayClimate,
  type OutlookDayInput,
} from '@/lib/weeklyOutlookPlanner';
import {
  collectMainAccordDisplayRows,
  getFragranceDetails,
  isBackgroundEnrichmentQueued,
  isSourceCoverageComplete,
  normalizeFragranceDetail,
  type DerivedMetrics,
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
// Client-side durable brake. The in-memory backoff map below resets on every
// reload, so a row the engine can never complete (no usable requested_count
// brake) would poll forever — fresh attempts every session. We persist the
// per-row attempt count to localStorage and stop scheduling once a row has been
// attempted this many times across reloads, independent of the engine's count.
const MAX_CLIENT_DETAIL_REFRESH_ATTEMPTS = 12;
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
        // Guest rows never round-trip through server hydration, so the
        // crawled-Fragrantica display gate applies here on read.
        imageUrl: displayableVaultImageUrl(value.imageUrl),
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

// Durable per-token detail-refresh backoff. Persists the in-memory backoff map
// so an un-completable row's attempt count survives reloads and the client brake
// (MAX_CLIENT_DETAIL_REFRESH_ATTEMPTS) actually bounds polling across sessions
// instead of resetting to zero on every page load.
function detailRefreshBackoffStorageKey(token: string): string {
  return `scent_detail_refresh_backoff_${token}`;
}

function readDetailRefreshBackoff(token: string): Map<string, DetailRefreshBackoffMeta> {
  const map = new Map<string, DetailRefreshBackoffMeta>();
  if (typeof localStorage === 'undefined' || !token) return map;
  try {
    const raw = localStorage.getItem(detailRefreshBackoffStorageKey(token));
    if (!raw) return map;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return map;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const meta = value as Partial<DetailRefreshBackoffMeta>;
      if (typeof meta.attemptCount !== 'number') continue;
      map.set(key, {
        attemptCount: meta.attemptCount,
        nextEligibleAt: typeof meta.nextEligibleAt === 'number' ? meta.nextEligibleAt : 0,
        lastStatus: typeof meta.lastStatus === 'string' ? meta.lastStatus : '',
      });
    }
  } catch {
    /* storage unavailable / malformed - start from an empty in-memory map */
  }
  return map;
}

function writeDetailRefreshBackoff(token: string, map: Map<string, DetailRefreshBackoffMeta>): void {
  if (typeof localStorage === 'undefined' || !token) return;
  try {
    if (map.size === 0) {
      localStorage.removeItem(detailRefreshBackoffStorageKey(token));
      return;
    }
    localStorage.setItem(
      detailRefreshBackoffStorageKey(token),
      JSON.stringify(Object.fromEntries(map)),
    );
  } catch {
    /* storage unavailable (private mode / quota) - in-memory brake still applies this session */
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

// Calendar season from the current month (Northern-Hemisphere mapping). The
// engine accepts a `season` hint but no caller populated it, so its season-aware
// explanation branch was unreachable. Month-based is a deliberate minimal
// derivation; a hemisphere flip would need the user's latitude, which is not
// available at this layer.
const deriveSeason = (date = new Date()): ScentWeatherEngineInput['weather']['season'] => {
  const month = date.getMonth(); // 0 = Jan
  if (month === 11 || month <= 1) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'fall';
};

// Local part of day from the wall clock, so the engine can refine the wear
// window against the real time instead of inferring day/night from the setting.
const deriveTimeOfDay = (date = new Date()): ScentWeatherEngineInput['weather']['time_of_day'] => {
  const hour = date.getHours();
  if (hour >= 5 && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 16) return 'afternoon';
  if (hour >= 17 && hour <= 20) return 'evening';
  return 'night';
};

// Resolve a destination to an engine setting type AND report whether it was
// actually recognized. An unrecognized destination must NOT silently become
// `indoor` (the most restrictive rule set) — that flips the whole
// recommendation toward fresh/clean and flags richer scents as "avoid". We
// fall back to neutral `mixed` and flag `recognized:false` so the engine
// demotes confidence instead of presenting a confident wrong answer.
const resolveEngineSetting = (
  destination: DestinationType | string,
): { type: ScentWeatherEngineInput['setting']['type']; recognized: boolean } => {
  const normalized = destination.trim().toLowerCase();
  switch (normalized) {
    case 'work':
      return { type: 'work', recognized: true };
    case 'night out':
    case 'night':
      return { type: 'night', recognized: true };
    case 'going out':
      return { type: 'mixed', recognized: true };
    case 'staying in':
      return { type: 'indoor', recognized: true };
    case 'date':
      return { type: 'date', recognized: true };
    case 'gym':
      return { type: 'gym', recognized: true };
    default:
      return { type: 'mixed', recognized: false };
  }
};

// True only when the live weather payload actually carried the field — used to
// distinguish real data from the neutral defaults applied below.
const hasFiniteWeatherValue = (weather: any, keys: string[]): boolean =>
  keys.some((key) => Number.isFinite(weather?.[key]));

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

/**
 * Phase 2 (A2-GAP1/3): a 0..1 data-quality signal from the backend vector's
 * provenance. The scent engine builds a 6-axis vector from a keyword dictionary;
 * when most of a fragrance's notes were unrecognized (`vector_confidence: 'none'`
 * / a low `match_ratio`) that vector is largely fabricated and must not lend the
 * recommendation full confidence. Returns undefined for profiles that predate the
 * provenance fields (older catalog rows / engine-only details) so they are not
 * retroactively penalized.
 */
// A5-GAP5: how recently this fragrance was actually worn (accepted as a pick),
// stamped into fragrance_data.lastWornAt. Returns a 0..1 recency factor — 1.0 if
// worn just now, decaying linearly to 0 after RECENCY_WINDOW_DAYS — or 0 when the
// bottle has no wear record (so an un-worn bottle is never penalized).
const RECENCY_WINDOW_DAYS = 7;
const RECENCY_PENALTY_WEIGHT = 25;
const getFragranceRecencyFactor = (item: Fragrance, now: number): number => {
  const record = getFragranceRecord(item);
  const raw = record.lastWornAt;
  const wornMs = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(wornMs)) return 0;
  const days = (now - wornMs) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return 0;
  if (days >= RECENCY_WINDOW_DAYS) return 0;
  return 1 - days / RECENCY_WINDOW_DAYS;
};

const getFragranceVectorConfidence = (item: Fragrance): number | undefined => {
  const record = getFragranceRecord(item);
  const flag = typeof record.vector_confidence === 'string' ? record.vector_confidence : undefined;
  if (flag === 'none') return 0;
  if (flag === 'low') return 0.4;
  if (flag === 'ok') return 1;
  const ratio = numberFromValue(record.match_ratio);
  if (ratio !== undefined && Number.isFinite(ratio)) return Math.max(0, Math.min(1, ratio));
  return undefined;
};

// WS-7: a profile-vector axis must reach >= 30% of the 0-10 range before it counts
// as a present scent trait. Mirrors VECTOR_TRAIT_THRESHOLD in the scent-weather
// engine so candidate hit-counting and the engine's family verdicts agree.
const VECTOR_TRAIT_THRESHOLD = 3;

const getFragranceTraitTexts = (item: Fragrance): string[] => {
  const traits: string[] = [];
  traits.push(...getFragranceFamilies(item));
  traits.push(...getFragranceAccords(item));
  for (const [key, value] of Object.entries(getFragranceProfileVector(item))) {
    // WS-7: only count an axis as a present trait at meaningful magnitude (>= 30%
    // of the 0-10 range), matching the engine's VECTOR_TRAIT_THRESHOLD. The
    // vectorizer no longer applies a +2.5 floor, so a residual near-zero axis must
    // not be promoted to a family signal for candidate hit-counting.
    if (Number.isFinite(value) && value >= VECTOR_TRAIT_THRESHOLD) traits.push(key);
  }
  return traits.map(normalizeTrait).filter(Boolean);
};

// Delegate to the engine's canonical family-signal matcher so candidate
// hit-counting uses the exact same token map the engine used to build
// best_scent_families/avoid_scent_families. A previous local copy of the signal
// map had drifted (missing tokens like galbanum, oak, labdanum, watery, edible),
// which silently dropped legitimate best/avoid hits and skewed the surfaced pick.
const fragranceHasFamilySignal = (item: Fragrance, family: ScentFamily): boolean =>
  traitsMatchScentFamily(getFragranceTraitTexts(item), family);

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

// Token families used to place a fragrance on the continuous warm/heavy ↔
// fresh/light axis the weekly planner scores against. Kept consistent with the
// engine's HEAVY_SIGNALS/FRESH_SIGNALS so the forecast's thermal reasoning and
// the engine's family verdicts never disagree about what "warm" vs "fresh" means.
const WARM_HEAVY_SIGNALS = [
  'oud', 'agarwood', 'amber', 'resin', 'resinous', 'labdanum', 'incense', 'smoke', 'smoky',
  'leather', 'leathery', 'suede', 'tobacco', 'cigar', 'vanilla', 'tonka', 'caramel', 'honey',
  'boozy', 'gourmand', 'praline', 'chocolate', 'coffee', 'cinnamon', 'clove', 'cardamom',
  'saffron', 'spice', 'spicy', 'pepper', 'wood', 'woody', 'cedar', 'sandalwood', 'patchouli',
  'balsam', 'myrrh', 'benzoin',
];

const FRESH_LIGHT_SIGNALS = [
  'fresh', 'freshness', 'clean', 'laundry', 'soap', 'citrus', 'bergamot', 'lemon', 'lime',
  'orange', 'grapefruit', 'mandarin', 'aquatic', 'marine', 'ocean', 'sea', 'water', 'watery',
  'ozonic', 'green', 'grass', 'leaf', 'leafy', 'herbal', 'mint', 'lavender', 'tea', 'cucumber',
  'melon', 'musk', 'musky',
];

const countSignalHits = (traits: readonly string[], signals: readonly string[]): number =>
  traits.reduce(
    (count, trait) => (signals.some((signal) => trait.includes(signal)) ? count + 1 : count),
    0,
  );

/** 0..1 projection strength from sillage label, longevity, and concentration. */
const estimateProjectionStrength = (item: Fragrance): number => {
  let strength = 0.5;

  const sillage = getFragranceSillage(item);
  if (sillage === 'strong') strength = 0.85;
  else if (sillage === 'light') strength = 0.3;

  const longevity = getFragranceLongevity(item);
  if (typeof longevity === 'number' && Number.isFinite(longevity)) {
    // Longevity is reported in hours; 12h+ reads as a powerhouse.
    strength = (strength + Math.max(0, Math.min(1, longevity / 12))) / 2;
  } else if (typeof longevity === 'string') {
    const text = longevity.toLowerCase();
    if (/(eternal|very long|long lasting|long-lasting|beast)/.test(text)) strength = Math.max(strength, 0.8);
    else if (/(weak|poor|short)/.test(text)) strength = Math.min(strength, 0.35);
  }

  const concentration = normalizeTrait(item.concentration);
  if (/(parfum|extrait)/.test(concentration) && !/eau de parfum/.test(concentration)) {
    strength = Math.min(1, strength + 0.1);
  } else if (/(cologne|edc|eau de cologne)/.test(concentration)) {
    strength = Math.max(0, strength - 0.1);
  }

  return Math.max(0, Math.min(1, strength));
};

const getFragranceDerivedMetrics = (item: Fragrance): DerivedMetrics | null =>
  item.raw_engine_detail?.derived_metrics ?? item.derived_metrics ?? null;

const percentOrNull = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
    }
  }
  return null;
};

// Normalize one accord row to a 0..1 prominence weight, tolerating the engine's
// `pct` (0-100), 0-10 axis `score`, and 0-1 model `score` shapes.
const accordWeight = (row: { score?: number; pct?: number }): number => {
  if (typeof row.pct === 'number' && Number.isFinite(row.pct)) {
    return Math.max(0, Math.min(1, row.pct / 100));
  }
  if (typeof row.score === 'number' && Number.isFinite(row.score)) {
    if (row.score <= 1) return Math.max(0, row.score);
    if (row.score <= 10) return row.score / 10;
    return Math.max(0, Math.min(1, row.score / 100));
  }
  return 0.5;
};

/**
 * Warm/heavy ↔ fresh/light placement (each 0..1), preferring the WEIGHTED main
 * accords from `derived_metrics` so a fragrance that is 40% vanilla + 30% amber
 * reads as genuinely warm — rather than counting raw note text where a trace
 * note weighs the same as a dominant one. Falls back to note-text matching only
 * when no scored accords exist.
 */
const deriveWarmFreshAxis = (
  item: Fragrance,
  metrics: DerivedMetrics | null,
): { warmth: number; freshness: number; fromAccords: boolean } => {
  const rows = collectMainAccordDisplayRows(metrics?.main_accords);
  let warmSum = 0;
  let freshSum = 0;
  for (const row of rows) {
    const label = normalizeTrait(row.label);
    if (!label) continue;
    const weight = accordWeight(row);
    if (WARM_HEAVY_SIGNALS.some((signal) => label.includes(signal))) warmSum += weight;
    else if (FRESH_LIGHT_SIGNALS.some((signal) => label.includes(signal))) freshSum += weight;
  }

  if (warmSum + freshSum > 0) {
    const total = warmSum + freshSum;
    return { warmth: warmSum / total, freshness: freshSum / total, fromAccords: true };
  }

  // Fallback: unweighted note-text counting.
  const traits = getFragranceTraitTexts(item);
  const warmHits = countSignalHits(traits, WARM_HEAVY_SIGNALS);
  const freshHits = countSignalHits(traits, FRESH_LIGHT_SIGNALS);
  const total = warmHits + freshHits;
  return {
    warmth: total > 0 ? warmHits / total : 0.5,
    freshness: total > 0 ? freshHits / total : 0.5,
    fromAccords: false,
  };
};

/** Real 0..1 projection from sillage/longevity percentages, else label heuristic. */
const deriveProjection = (
  item: Fragrance,
  metrics: DerivedMetrics | null,
): { projection: number; fromMetrics: boolean } => {
  const perf = metrics?.performance_score ?? null;
  const sillage = percentOrNull(perf?.sillage_percent, perf?.sillage_pct);
  const longevity = percentOrNull(perf?.longevity_percent, perf?.longevity_pct);
  if (sillage !== null || longevity !== null) {
    const s = sillage ?? longevity ?? 0.5;
    const l = longevity ?? sillage ?? 0.5;
    // Sillage drives projection; longevity refines it.
    return { projection: Math.max(0, Math.min(1, s * 0.6 + l * 0.4)), fromMetrics: true };
  }
  return { projection: estimateProjectionStrength(item), fromMetrics: false };
};

/** Community season votes → [winter, spring, summer, fall] affinity, or undefined. */
const deriveSeasonAffinity = (
  metrics: DerivedMetrics | null,
): [number, number, number, number] | undefined => {
  const seasons = metrics?.wear_profile?.primary_seasons?.filter(Boolean) ?? [];
  if (seasons.length === 0) return undefined;
  const affinity: [number, number, number, number] = [0, 0, 0, 0];
  for (const raw of seasons) {
    const season = normalizeTrait(raw);
    if (season.includes('winter')) affinity[0] = 1;
    if (season.includes('spring')) affinity[1] = 1;
    if (season.includes('summer')) affinity[2] = 1;
    if (season.includes('autumn') || season.includes('fall')) affinity[3] = 1;
  }
  return affinity.some((value) => value > 0) ? affinity : undefined;
};

/** Crowd-consensus quality 0..1 (blends overall consensus and community interest). */
const deriveQuality = (metrics: DerivedMetrics | null): number | undefined => {
  const consensus = percentOrNull(metrics?.headline?.crowd_consensus_score);
  const interest = percentOrNull(metrics?.community_interest_score?.score);
  if (consensus !== null && interest !== null) return consensus * 0.8 + interest * 0.2;
  return consensus ?? interest ?? undefined;
};

/**
 * Distill a vault fragrance into the axes the weekly planner scores against,
 * sourced from the app's real metric systems — weighted main accords, sillage/
 * longevity performance scores, community-voted seasons, and crowd consensus —
 * so each day's pick is data-driven rather than guessed. Every metric degrades
 * gracefully to a heuristic when a fragrance has not been enriched yet, and the
 * `confidence` axis records how much structured data actually backed the pick.
 */
const buildOutlookCandidate = (item: Fragrance): OutlookCandidate => {
  const metrics = getFragranceDerivedMetrics(item);
  const { warmth, freshness, fromAccords } = deriveWarmFreshAxis(item, metrics);
  const { projection, fromMetrics: projectionFromMetrics } = deriveProjection(item, metrics);
  const seasonAffinity = deriveSeasonAffinity(metrics);
  const quality = deriveQuality(metrics);

  // Confidence: share of the four structured metric systems that backed this
  // candidate. Drives the planner's gentle lean toward well-understood bottles.
  const present =
    (fromAccords ? 1 : 0) +
    (projectionFromMetrics ? 1 : 0) +
    (seasonAffinity ? 1 : 0) +
    (quality !== undefined ? 1 : 0);

  return {
    id: String(item.id ?? item._dbId ?? `${wardrobeEntryBrand(item)}:${wardrobeEntryName(item)}`),
    warmth,
    freshness,
    projection,
    seasonAffinity,
    quality,
    confidence: present / 4,
  };
};

// Phase 4 (A5): the signed-in user's persisted scent-taste profile, fetched from
// GET /api/me/scent-preferences and threaded into scoring. All fields optional so
// a guest / pre-migration / not-yet-loaded state scores exactly as before.
export interface UserScentPreferences {
  preferredFamilies?: ScentFamily[];
  dislikedFamilies?: ScentFamily[];
  scentLastsOnMe?: 'short' | 'normal' | 'long';
  projectionPreference?: 'subtle' | 'noticeable';
}

const EMPTY_SCENT_PREFERENCES: UserScentPreferences = {};

const buildEngineInput = (
  item: Fragrance,
  intent: { destination: DestinationType; energy: EnergyState },
  weather: any,
  preferences: UserScentPreferences = EMPTY_SCENT_PREFERENCES,
): ScentWeatherEngineInput => {
  const condition = getWeatherString(weather, ['condition', 'description']);
  const normalizedCondition = condition.toLowerCase();
  // Whether the live weather payload actually supplied the conditions that
  // drive scoring. Computed from the RAW weather, before the neutral defaults
  // below mask the gap — temperature and humidity are the two fields that
  // skew the heat/humidity scoring, so both must be present to count as
  // complete. Threaded to the engine so a failed weather fetch can't yield a
  // confident pick built on fabricated 72°F/50% conditions.
  const weatherDataComplete =
    hasFiniteWeatherValue(weather, ['temperature_f', 'temperature', 'temp']) &&
    hasFiniteWeatherValue(weather, ['humidity_percent', 'humidity']);
  const setting = resolveEngineSetting(intent.destination);
  const uvIndex =
    weather && typeof weather.uv_index === 'number' && Number.isFinite(weather.uv_index)
      ? weather.uv_index
      : null;

  return {
    weather: {
      temperature_f: getWeatherNumber(weather, ['temperature_f', 'temperature', 'temp'], 72),
      humidity_percent: getWeatherNumber(weather, ['humidity_percent', 'humidity'], 50),
      wind_speed_mph: getWeatherNumber(weather, ['wind_speed_mph', 'windSpeed'], 0),
      is_raining: RAIN_CONDITION_SIGNALS.some((signal) => normalizedCondition.includes(signal)),
      season: deriveSeason(),
      uv_index: uvIndex,
      time_of_day: deriveTimeOfDay(),
      condition,
      data_complete: weatherDataComplete,
    },
    setting: {
      type: setting.type,
      recognized: setting.recognized,
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
    // How much real structured data backs this fragrance. Blends the share of
    // the four crowd metric systems present (buildOutlookCandidate.confidence)
    // with the backend vector's note-coverage provenance (Phase 2) so a profile
    // whose 6-axis vector was mostly fabricated from unrecognized notes can't
    // surface as "high" just because weather+setting are known. Profiles without
    // the newer provenance fields fall back to the structured-metric share alone.
    dataConfidence: (() => {
      const structured = buildOutlookCandidate(item).confidence ?? 0;
      const vectorSignal = getFragranceVectorConfidence(item);
      return vectorSignal === undefined ? structured : (structured + vectorSignal) / 2;
    })(),
    // A5-GAP1: the engine consumes userPreference in its spray/projection math but
    // the app never built it. Thread the user's skin-longevity + projection taste.
    ...(preferences.scentLastsOnMe || preferences.projectionPreference
      ? {
          userPreference: {
            ...(preferences.scentLastsOnMe ? { scentLastsOnMe: preferences.scentLastsOnMe } : {}),
            ...(preferences.projectionPreference
              ? { projectionPreference: preferences.projectionPreference }
              : {}),
          },
        }
      : {}),
  };
};

// Distill a loose weather object into the climate axes the planner scores
// against. Mirrors the keys `buildEngineInput` reads so the forecast's thermal
// reasoning and the engine see the same numbers.
const buildOutlookClimate = (weather: any): OutlookDayClimate => {
  const condition = getWeatherString(weather, ['condition', 'description']);
  const normalizedCondition = condition.toLowerCase();
  return {
    temperature_f: getWeatherNumber(weather, ['temperature_f', 'temperature', 'temp'], 72),
    humidity: getWeatherNumber(weather, ['humidity_percent', 'humidity'], 50),
    wind_speed_mph: getWeatherNumber(weather, ['wind_speed_mph', 'windSpeed'], 0),
    is_raining: RAIN_CONDITION_SIGNALS.some((signal) => normalizedCondition.includes(signal)),
    condition,
  };
};

// Engine family-alignment for one fragrance on one day, WITHOUT the continuous
// thermal term. This is the `baseScore` the weekly planner builds on. A6-GAP2:
// delegates to the shared `familyAlignmentScore` so the home hero, the forecast
// planner, and the API mission ranker score family alignment identically (the
// display-score table and best/avoid/intent/energy weights are single-sourced).
const scoreFamilyAlignment = (
  item: Fragrance,
  recommendation: ScentWeatherRecommendation,
  intent: { destination: DestinationType; energy: EnergyState },
  preferences: UserScentPreferences = EMPTY_SCENT_PREFERENCES,
): number =>
  familyAlignmentScore({
    recommendation,
    traits: getFragranceTraitTexts(item),
    intentMatch: item.intents?.includes(intent.destination) ?? false,
    energyMatch: item.energies?.includes(intent.energy) ?? false,
    // A5-GAP2: steer toward liked families and away from disliked ones.
    preferredFamilies: preferences.preferredFamilies,
    dislikedFamilies: preferences.dislikedFamilies,
  });

const scoreRecommendationCandidate = (
  item: Fragrance,
  recommendation: ScentWeatherRecommendation,
  intent: { destination: DestinationType; energy: EnergyState },
  climate?: OutlookDayClimate,
  preferences: UserScentPreferences = EMPTY_SCENT_PREFERENCES,
): number => {
  const base = scoreFamilyAlignment(item, recommendation, intent, preferences);
  // A5-GAP5: down-weight a bottle worn in the last week so the same pick doesn't
  // resurface every similar day; the penalty decays to zero as the wear ages.
  const recencyPenalty = getFragranceRecencyFactor(item, Date.now()) * RECENCY_PENALTY_WEIGHT;
  if (!climate) return base - recencyPenalty;
  // Layer the data-backed weather terms (continuous thermal harmony, community
  // season suitability, crowd-consensus quality, confidence) on top of the
  // engine's family verdict — the gradient that makes a 58°F day rank the vault
  // differently from a 78°F day instead of every forecast day looking identical.
  return dayCandidateScore(base, buildOutlookCandidate(item), climate) - recencyPenalty;
};

const calculateEngineAlignment = (
  items: Fragrance[],
  intent: { destination: DestinationType; energy: EnergyState },
  weather: any,
  preferences: UserScentPreferences = EMPTY_SCENT_PREFERENCES,
) => {
  const climate = buildOutlookClimate(weather);
  const candidates = items.map((item, index) => {
    const recommendation = calculateScentWeatherRecommendation(
      buildEngineInput(item, intent, weather, preferences),
    );
    return {
      item,
      recommendation,
      score: scoreRecommendationCandidate(item, recommendation, intent, climate, preferences),
      index,
    };
  });

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0];
};

// Neutral intent for occasion-agnostic scoring (e.g. the weekly outlook
// dashboard), so each day's pick reflects the WEATHER rather than a specific
// destination/energy the user hasn't chosen for that day.
const NEUTRAL_OUTLOOK_INTENT: { destination: DestinationType; energy: EnergyState } = {
  destination: 'Going Out',
  energy: 'Confident',
};

export interface WeatherOutlookPick {
  item: Fragrance;
  name: string;
  brand: string;
  recommendation: ScentWeatherRecommendation;
  score: number;
}

/**
 * Pick the single best-aligned vault fragrance for a given weather snapshot,
 * using the same engine + scoring as the home recommendation. Exposed so the
 * weekly outlook dashboard can score each forecast day off the user's vault
 * without duplicating the engine plumbing. Returns null for an empty vault.
 */
export function recommendFragranceForWeather(
  items: Fragrance[],
  weather: any,
  intent: { destination: DestinationType; energy: EnergyState } = NEUTRAL_OUTLOOK_INTENT,
): WeatherOutlookPick | null {
  if (!items || items.length === 0) return null;
  const winner = calculateEngineAlignment(items, intent, weather);
  if (!winner) return null;
  return {
    item: winner.item,
    name: wardrobeEntryName(winner.item),
    brand: wardrobeEntryBrand(winner.item),
    recommendation: winner.recommendation,
    score: winner.score,
  };
}

/**
 * Plan a whole week of forecast picks at once.
 *
 * Scoring each day in isolation (as the dashboard used to) collapsed to one
 * repeated bottle: in the common temperate band the engine emits the same
 * family verdict every day, and ties broke on wardrobe index. This runs the
 * engine per (fragrance, day) for family alignment, layers on the continuous
 * thermal-harmony term so each day's temperature reorders the vault, and hands
 * the matrix to `planWeeklyOutlook` which assigns each day its best-fit bottle
 * while spreading picks across the collection. Returns one entry per climate
 * (null only when the vault is empty), aligned to the input order.
 */
export function planWeeklyScentOutlook(
  items: Fragrance[],
  climates: OutlookDayClimate[],
  intent: { destination: DestinationType; energy: EnergyState } = NEUTRAL_OUTLOOK_INTENT,
): (WeatherOutlookPick | null)[] {
  if (!items || items.length === 0) return climates.map(() => null);

  const candidates = items.map(buildOutlookCandidate);

  // Engine recommendation + family alignment for every (fragrance, day) cell.
  // Cached so the planner's report step and the rendered recommendation reuse
  // the exact same engine verdict.
  const recommendations = climates.map((climate) =>
    items.map((item) =>
      calculateScentWeatherRecommendation(buildEngineInput(item, intent, climate)),
    ),
  );

  const days: OutlookDayInput[] = climates.map((climate, dayIndex) => ({
    climate,
    baseScores: items.map((item, i) =>
      scoreFamilyAlignment(item, recommendations[dayIndex][i], intent),
    ),
  }));

  return planWeeklyOutlook(candidates, days).map((assignment) => {
    const i = assignment.candidateIndex;
    if (i < 0) return null;
    const item = items[i];
    return {
      item,
      name: wardrobeEntryName(item),
      brand: wardrobeEntryBrand(item),
      recommendation: recommendations[assignment.dayIndex][i],
      score: assignment.score,
    };
  });
}

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
  /**
   * A fragrance queued to open in the wardrobe detail modal from OUTSIDE the
   * wardrobe (the Scent Mission proposal's "View", a curation deep-link). The
   * detail modal lives in the lazy-mounted Wardrobe, so cross-view opens hand the
   * target through here instead of lifting the whole modal up to App. Null when
   * nothing is queued; the modal consumes it via `consumePendingDetailOpen`.
   */
  pendingDetailOpen: Fragrance | null;
  /** Shared-element source to use when the queued detail was opened outside the vault. */
  pendingDetailOpenSourceLayoutId: string | null;
  /** True while a freshly-added imageless tile is actively backfilling its image. */
  isImageSyncing: (item: Pick<Fragrance, 'id' | '_dbId'>) => boolean;
  retryLoadWardrobe: () => void;
  setItems: React.Dispatch<React.SetStateAction<Fragrance[]>>;
  setIsIntentModalOpen: (open: boolean) => void;
  setIsShareModalOpen: (open: boolean) => void;
  setActiveRecommendation: (item: Fragrance | null) => void;
  setActiveEngineRecommendation: (rec: ScentWeatherRecommendation | null) => void;
  setRecommendationReason: (reason: string) => void;
  /** Phase 4 (A5): the user's persisted scent-taste profile, threaded into scoring. */
  scentPreferences: UserScentPreferences;
  /** Persist a partial update to the taste profile (onboarding capture / settings). */
  updateScentPreferences: (patch: Partial<UserScentPreferences>) => Promise<void>;
  /** Phase 4 (A5-GAP5): record that a fragrance was worn/accepted (recency penalty). */
  markFragranceWorn: (item: Pick<Fragrance, 'id' | '_dbId'>) => Promise<void>;
  setUserId: (id: string | null) => void;
  setVaultSearchUiActive: (active: boolean) => void;
  loadWardrobe: (token: string, signal?: AbortSignal) => Promise<void>;
  handleAddItem: (item: any) => Promise<{ persisted: boolean; requiresAuth?: boolean; error?: string; duplicate?: boolean; guestSaved?: boolean }>;
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
  /** Persist a single user-verified metric (year/gender/concentration/season) from the detail modal's inline editor. */
  handleVerifyWardrobeFact: (
    target: Fragrance,
    field: 'year' | 'gender' | 'concentration' | 'season',
    rawValue: string,
  ) => Promise<Fragrance | null>;
  handleRevertWardrobe: () => void;
  handleDeleteItem: (target: Fragrance) => Promise<void>;
  handleIntentComplete: (intent: { destination: DestinationType; energy: EnergyState }) => void;
  closeRecommendationOverlay: () => void;
  handleVaultSearchStateChange: (active: boolean) => void;
  handleExpandArchive: (options?: { target?: 'hero' | 'vault' }) => void;
  /**
   * Open a fragrance — which may NOT be in the vault — in the wardrobe detail
   * modal, app-wide. Queues `pendingDetailOpen` and normally scrolls the vault
   * into view. A caller with a visible shared-element source can keep the current
   * scroll position and pass that source's layout id instead.
   */
  openFragranceDetail: (
    fragrance: Fragrance,
    options?: { sourceLayoutId?: string; scrollToVault?: boolean },
  ) => void;
  /** Detail modal: clear the queued fragrance once it has been opened. */
  clearPendingDetailOpen: () => void;
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
  // Phase 4 (A5): the signed-in user's persisted scent-taste profile, threaded
  // into every recommendation scoring path. Empty for guests / before load.
  const [scentPreferences, setScentPreferences] = useState<UserScentPreferences>(EMPTY_SCENT_PREFERENCES);
  const [wardrobeError, setWardrobeError] = useState<string | null>(null);
  const [isIntentModalOpen, setIsIntentModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [activeRecommendation, setActiveRecommendation] = useState<Fragrance | null>(null);
  const [activeEngineRecommendation, setActiveEngineRecommendation] = useState<ScentWeatherRecommendation | null>(null);
  const [recommendationReason, setRecommendationReason] = useState<string>('');
  // The last intent the user submitted, so a weather refresh can re-score the
  // surfaced pick without re-prompting. Null when no pick is displayed.
  const lastIntentRef = useRef<{ destination: DestinationType; energy: EnergyState } | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [wardrobeRevertSnapshot, setWardrobeRevertSnapshot] = useState<Fragrance[] | null>(null);
  const [wardrobeFixBusy, setWardrobeFixBusy] = useState(false);
  const [wardrobeFixHint, setWardrobeFixHint] = useState<string | null>(null);
  const [vaultSearchUiActive, setVaultSearchUiActive] = useState(false);
  // Admin flag from GET /api/me/app-state. UI hint only — the upload route
  // enforces admin access server-side regardless of this value.
  const [isAdmin, setIsAdmin] = useState(false);
  // A fragrance queued to open in the (lazy-mounted) wardrobe detail modal from
  // another view. See `openFragranceDetail` / `consumePendingDetailOpen`.
  const [pendingDetailOpen, setPendingDetailOpen] = useState<Fragrance | null>(null);
  const [pendingDetailOpenSourceLayoutId, setPendingDetailOpenSourceLayoutId] =
    useState<string | null>(null);

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
  const imageBackfillInFlightRef = useRef(false);
  // The single fragrance whose image is being actively backfilled (one burst runs
  // at a time — see `scheduleImageBackfillRehydrate`). Drives the honest "fetching
  // image…" affordance so a freshly-added imageless tile shows a spinner *while it
  // is genuinely syncing*, then settles to "No image" once the burst gives up —
  // rather than spinning forever (FE-1) or lying with "No image" mid-fetch.
  const [imageSyncTarget, setImageSyncTarget] = useState<Pick<Fragrance, 'id' | '_dbId'> | null>(null);
  const itemsRef = useRef(items);
  const authTokenRef = useRef(authToken);
  const previousGuestPersistenceAuthRef = useRef(authToken);
  // Once-per-sign-in guard so the guest→server wardrobe migration runs exactly
  // once for a given token, even if the load effect re-runs.
  const guestMigrationTokenRef = useRef<string | null>(null);
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
    // A mutation is in flight or just landed: skip this load so an in-flight poll
    // can't stomp the optimistic state. But never strand the user on a skeleton —
    // mark the wardrobe loaded (we already have the optimistic items) and schedule
    // a one-shot retry once the 5s cooldown clears, so server state is still
    // reconciled. Conditional background polls don't need the retry (the 60s tick
    // already reschedules them) and must not flip wardrobeLoaded on their own.
    const scheduleCooldownRetry = () => {
      if (opts?.conditional) return;
      setWardrobeLoaded(true);
      window.setTimeout(() => {
        if (authTokenRef.current === token && !isMutatingRef.current) {
          void loadWardrobe(token);
        }
      }, 5200);
    };
    if (isMutatingRef.current) {
      scheduleCooldownRetry();
      return;
    }
    const now = Date.now();
    if (now - lastMutationRef.current < 5000) {
      scheduleCooldownRetry();
      return;
    }

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
      // Only advance the cached validator once we're actually applying this body.
      // Advancing it on any non-304 response while the discard guards above throw
      // the payload away would make every future conditional poll send the new
      // tag, get a 304, and never observe the change we just discarded — until an
      // unconditional focus/visibility poll happens to fire.
      const etag = res.headers.get('ETag');
      if (etag) wardrobeEtagRef.current = etag;
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
      void loadWardrobe(authToken);
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

  // Resolve the shared catalog image and persist it into this user's row. A
  // full wardrobe reload can keep returning an imageless row when the separate
  // best-effort background write lags behind the catalog update.
  const pollSignedInSharedImage = useCallback(async (target: Fragrance, token: string) => {
    if (imageBackfillInFlightRef.current) return;
    imageBackfillInFlightRef.current = true;
    try {
      const rowId = target._dbId ?? target.id;
      const res = await fetch(`/api/wardrobe/${encodeURIComponent(rowId)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ syncImageFromCatalog: true }),
      });
      // 409 means the deferred image pipeline is still working; the next
      // scheduled probe will retry without surfacing an error to the user.
      if (res.status === 409) return;
      const data = (await res.json().catch(() => null)) as (Fragrance & { error?: string }) | null;
      if (!res.ok || !data) return;

      setItems((prev) =>
        prev.map((item) =>
          sameWardrobeEntry(item, target)
            ? reconcileWardrobeItems([item], [{ ...data, id: item.id }])[0] ?? item
            : item,
        ),
      );
      clearImageBackfillTimers();
    } catch {
      /* non-fatal: the next scheduled probe (or give-up timer) handles it */
    } finally {
      imageBackfillInFlightRef.current = false;
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
      // Mark the tile as actively syncing for the lifetime of the VISIBLE burst.
      setImageSyncTarget(target);
      // One probe attempt; returns false once the burst should stop (auth flipped,
      // row deleted, or image landed) so callers can skip scheduling more work.
      const runProbe = (): boolean => {
        // Auth changed since the burst began (signed in or out) → abandon: the
        // freshly-relevant mode owns the tile now. For a guest burst `token` is
        // null, so this fires the moment a token appears mid-burst.
        if (authTokenRef.current !== token) {
          clearImageBackfillTimers();
          return false;
        }
        const current = itemsRef.current.find((item) => sameWardrobeEntry(item, target));
        const resolved =
          typeof current?.imageUrl === 'string' && current.imageUrl.trim().length > 0;
        // Row gone (deleted) or image already arrived → stop the remaining burst.
        if (!current || resolved) {
          clearImageBackfillTimers();
          return false;
        }
        if (token) {
          void pollSignedInSharedImage(target, token);
        } else {
          void pollGuestSharedImage(target);
        }
        return true;
      };
      // Visible phase: fast, decaying probes while the "fetching image…" spinner
      // is shown. The image usually lands here (catalog re-hydrate after the
      // engine harvest + deferred pipeline).
      const VISIBLE_POLL_SCHEDULE_MS = [6000, 12000, 20000, 32000, 48000];
      for (const delay of VISIBLE_POLL_SCHEDULE_MS) {
        imageBackfillTimersRef.current.push(window.setTimeout(runProbe, delay));
      }
      // Hard stop just after the final visible poll: if the image still hasn't
      // landed, drop the syncing affordance so the tile settles to "No image"
      // instead of spinning indefinitely. The spinner is always bounded here —
      // never reintroducing the perpetual-spinner bug FE-1 fixed.
      const SPINNER_GIVE_UP_MS = VISIBLE_POLL_SCHEDULE_MS[VISIBLE_POLL_SCHEDULE_MS.length - 1] + 4000;
      imageBackfillTimersRef.current.push(
        window.setTimeout(() => {
          setImageSyncTarget((current) =>
            current && sameWardrobeEntry(current, target) ? null : current,
          );
        }, SPINNER_GIVE_UP_MS),
      );
      // Silent phase: a few more decaying probes AFTER the spinner is dropped, so
      // a slow cold-start image (slow Decodo crawl, deferred Serper+Poof+upload,
      // or a catalog row that lands past the visible window) still fills the tile
      // without any spinner. This is the only recovery path for guests, who have
      // no 60s signed-in wardrobe poll. Bounded total (~3 min) keeps it cheap and
      // preserves FE-1: probing continues silently, the spinner does not.
      const SILENT_POLL_SCHEDULE_MS = [70000, 95000, 130000, 175000];
      for (const delay of SILENT_POLL_SCHEDULE_MS) {
        imageBackfillTimersRef.current.push(window.setTimeout(runProbe, delay));
      }
    },
    [clearImageBackfillTimers, pollGuestSharedImage, pollSignedInSharedImage],
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

  // A5: load the user's scent-taste profile. Tolerates the pre-migration 503/empty
  // and guests (no token) by leaving preferences empty — scoring then behaves
  // exactly as before personalization existed.
  const loadScentPreferences = useCallback(async (token: string, signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/me/scent-preferences', {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        scentPreferences?: {
          preferredFamilies?: unknown;
          dislikedFamilies?: unknown;
          scentLastsOnMe?: unknown;
          projectionPreference?: unknown;
        };
      };
      const raw = data.scentPreferences ?? {};
      const asFamilies = (v: unknown): ScentFamily[] =>
        Array.isArray(v) ? (v.filter((x): x is ScentFamily => typeof x === 'string')) : [];
      const lasts = raw.scentLastsOnMe;
      const projection = raw.projectionPreference;
      if (authTokenRef.current === token) {
        setScentPreferences({
          preferredFamilies: asFamilies(raw.preferredFamilies),
          dislikedFamilies: asFamilies(raw.dislikedFamilies),
          ...(lasts === 'short' || lasts === 'normal' || lasts === 'long' ? { scentLastsOnMe: lasts } : {}),
          ...(projection === 'subtle' || projection === 'noticeable' ? { projectionPreference: projection } : {}),
        });
      }
    } catch {
      // Network/abort — keep whatever we have; personalization is best-effort.
    }
  }, []);

  // A5-GAP6: persist a partial taste-profile update (onboarding family capture or
  // the settings panel) and optimistically merge it into local scoring state.
  const updateScentPreferences = useCallback(
    async (patch: Partial<UserScentPreferences>) => {
      setScentPreferences((prev) => ({ ...prev, ...patch }));
      const token = authTokenRef.current;
      if (!token) return; // guest: local-only, nothing to persist
      try {
        await fetch('/api/me/scent-preferences', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(patch),
        });
      } catch {
        // Best-effort: a failed sync keeps the optimistic local value for this session.
      }
    },
    [],
  );

  // A5-GAP5: record that the user wore/accepted a fragrance today. Optimistically
  // stamps lastWornAt locally (so the recency penalty applies immediately) and
  // best-effort persists to the wardrobe row's jsonb. Guests update locally only.
  const markFragranceWorn = useCallback(async (item: Pick<Fragrance, 'id' | '_dbId'>) => {
    const wornAt = new Date().toISOString();
    setItems((prev) =>
      prev.map((it) => (sameWardrobeEntry(it, item) ? ({ ...it, lastWornAt: wornAt } as Fragrance) : it)),
    );
    const token = authTokenRef.current;
    if (!token) return;
    const id = item._dbId ?? item.id;
    if (!id) return;
    try {
      await fetch(`/api/wardrobe/${encodeURIComponent(String(id))}/worn`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ wornAt }),
      });
    } catch {
      // Best-effort: the optimistic local stamp still rotates this session's picks.
    }
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
    // Clear the post-mutation cooldown and the conditional-poll ETag so a fresh
    // account's initial load (the effect below) is never short-circuited by the
    // previous user's recent mutation or suppressed by a stale If-None-Match.
    // Without this, switching accounts within 5s of a save/delete leaves the new
    // user with an empty vault until the next background poll.
    isMutatingRef.current = false;
    lastMutationRef.current = 0;
    wardrobeEtagRef.current = null;
    // On sign-out, allow a future sign-in to migrate a freshly-built guest vault
    // again. Only reset on null so this effect can't clear the guard for the very
    // token the load effect is about to migrate.
    if (!authToken) {
      guestMigrationTokenRef.current = null;
    }
    // Clear admin until app-state reconfirms it for the new token (and on sign-out).
    setIsAdmin(false);
  }, [authToken]);

  // Migrate a guest's locally-held wardrobe into the freshly-signed-in account.
  // Without this, signing in discards everything a guest built in localStorage —
  // defeating the app's own "sign in to save your vault" prompt. Runs once per
  // token (guard ref), AFTER the initial server load so it can de-dupe each guest
  // entry against the loaded server rows by brand+name identity. Confirmed uploads
  // are merged optimistically; the guest storage key is cleared only after every
  // item that needed uploading was either uploaded or already present on the server.
  const migrateGuestWardrobe = useCallback(async (token: string, guestItems: Fragrance[]) => {
    if (guestItems.length === 0) {
      writeGuestWardrobeItems([]);
      return;
    }

    // De-dupe against what the server already returned (now in itemsRef) so a
    // guest item that also exists on the account is not re-added.
    const serverKeys = new Set(
      itemsRef.current
        .map((existing) =>
          vaultIdentityKey(
            existing.brand ?? (existing as { house?: string }).house ?? existing.product?.brand,
            existing.name ?? existing.product?.name,
          ),
        )
        .filter(Boolean),
    );

    let allHandled = true;
    const seen = new Set<string>(serverKeys);
    for (const guestItem of guestItems) {
      // Token changed mid-migration (signed out / switched account) — abandon and
      // keep the remaining guest items so nothing is lost.
      if (authTokenRef.current !== token) {
        allHandled = false;
        break;
      }
      const key = vaultIdentityKey(
        guestItem.brand ?? (guestItem as { house?: string }).house ?? guestItem.product?.brand,
        guestItem.name ?? guestItem.product?.name,
      );
      if (key && seen.has(key)) continue; // already on server or earlier in this batch
      if (key) seen.add(key);

      const newItem: Fragrance = { ...guestItem };
      isMutatingRef.current = true;
      try {
        const res = await fetch('/api/wardrobe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ ...guestItem }),
        });
        const saved = (await res.json().catch(() => null)) as Partial<Fragrance> | null;
        if (!res.ok || !saved) {
          allHandled = false;
          continue;
        }
        const savedItem: Fragrance = {
          ...newItem,
          ...saved,
          id: typeof saved.id === 'string' && saved.id ? saved.id : newItem.id,
        };
        // Merge optimistically (de-duped) so there is no empty flash and a
        // concurrent server poll can't double-insert.
        setItems((prev) => {
          const savedKey = vaultIdentityKey(
            savedItem.brand ?? (savedItem as { house?: string }).house ?? savedItem.product?.brand,
            savedItem.name ?? savedItem.product?.name,
          );
          if (
            savedKey &&
            prev.some(
              (existing) =>
                vaultIdentityKey(
                  existing.brand ?? (existing as { house?: string }).house ?? existing.product?.brand,
                  existing.name ?? existing.product?.name,
                ) === savedKey,
            )
          ) {
            return prev;
          }
          return [savedItem, ...prev];
        });
      } catch {
        allHandled = false;
      } finally {
        isMutatingRef.current = false;
        lastMutationRef.current = Date.now();
      }
    }

    // Only clear the guest storage once everything was handled, so a partial
    // failure (network blip, token flip) leaves the un-migrated items for a retry.
    if (allHandled && authTokenRef.current === token) {
      writeGuestWardrobeItems([]);
    }
  }, []);

  // Load wardrobe & share settings on login
  useEffect(() => {
    const abortController = new AbortController();

    if (authToken) {
      // Capture the guest wardrobe BEFORE it is cleared, so sign-in can migrate it
      // into the account instead of discarding it.
      const guestItems =
        guestMigrationTokenRef.current !== authToken ? readGuestWardrobeItems() : [];
      setWardrobeLoaded(false);
      setItems([]);
      void (async () => {
        await loadWardrobe(authToken, abortController.signal);
        if (
          guestMigrationTokenRef.current !== authToken &&
          authTokenRef.current === authToken &&
          !abortController.signal.aborted
        ) {
          guestMigrationTokenRef.current = authToken;
          await migrateGuestWardrobe(authToken, guestItems);
        }
      })();
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
          if (!(err instanceof Error) || err.name !== 'AbortError') {
            console.error("Settings load failed", err);
          }
        });
    } else {
      setWardrobeLoaded(true);
    }

    return () => abortController.abort();
  }, [authToken, loadWardrobe, migrateGuestWardrobe, toast]);

  // Durable onboarding/discovery state. Fetched independently of /api/wardrobe so
  // a slow or empty wardrobe load cannot flash the add-3 flow at a completed user.
  // Server state wins; a 401 here is left to the wardrobe loader's recovery path.
  useEffect(() => {
    if (!authToken) {
      // Guest / signed-out: reset to the empty taste profile so a previous user's
      // preferences can't leak into a new session's scoring.
      setScentPreferences(EMPTY_SCENT_PREFERENCES);
      return;
    }
    const abortController = new AbortController();
    setOnboardingResolved(false);
    setOnboardingCompleted(readOnboardingMarker(authToken));
    void loadScentPreferences(authToken, abortController.signal);

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
  }, [authToken, loadAppState, loadScentPreferences]);

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
  ): Promise<{ persisted: boolean; requiresAuth?: boolean; error?: string; duplicate?: boolean; guestSaved?: boolean }> => {
    const newItem: Fragrance = { ...item };
    // Display gate: an add payload can carry the engine's raw Fragrantica image
    // (community picks, curation deep-links, engine details). That fallback is
    // owner-rejected on vault tiles — blank it locally so the tile shows the
    // honest syncing placeholder while the image pipeline resolves a processed
    // packshot. The server applies the same gate to its persisted copy.
    newItem.imageUrl = displayableVaultImageUrl(newItem.imageUrl);

    // Client-side duplicate guard. The search overlay flags already-saved results
    // via `existingVaultKeys`, but the Beam curate loop, a double-tap, or a
    // curation deep-link all reach handleAddItem directly with no such check —
    // each one creating a duplicate tile + row. Short-circuit on the same
    // brand+name identity used everywhere else so those paths can't duplicate.
    // (A backend unique index is being added separately as the durable guard.)
    const addKey = vaultIdentityKey(
      newItem.brand ?? (newItem as { house?: string }).house ?? newItem.product?.brand,
      newItem.name ?? newItem.product?.name,
    );
    if (addKey) {
      const alreadyInVault = itemsRef.current.some(
        (existing) =>
          vaultIdentityKey(
            existing.brand ?? (existing as { house?: string }).house ?? existing.product?.brand,
            existing.name ?? existing.product?.name,
          ) === addKey,
      );
      if (alreadyInVault) {
        return { persisted: false, duplicate: true };
      }
    }

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
            title: "Added to your vault",
            description: `${newItem.name} is saved and ready to wear.`
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

    // The guest item IS saved (in localStorage) at this point — report that as a
    // distinct `guestSaved` success so callers (Beam curate loop, search add)
    // don't count a successfully-stored guest add as a failure. `persisted`
    // stays false because nothing was written to the server.
    if (nextCount >= GUEST_SAVE_PROMPT_THRESHOLD && !guestPromptDismissed) {
      setIsAuthModalOpen(true);
      return { persisted: false, guestSaved: true, requiresAuth: true };
    }

    return { persisted: false, guestSaved: true, requiresAuth: !authToken };
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

  // User-verified metric: persist a single fact (year/gender/concentration/
  // season) the user typed into the detail modal's inline "verify" field. The
  // engine leaves these as "Unknown" when an authoritative source never stated
  // them; this lets the owner of the vault row correct/fill one by hand. Reuses
  // the same PATCH /api/wardrobe/:id fact path as enrichment, so the server's
  // placeholder guard (usefulDetailFactString) still rejects junk like "n/a",
  // and a later "Unknown" enrichment can't clobber the value the user supplied.
  const handleVerifyWardrobeFact = useCallback(async (
    target: Fragrance,
    field: 'year' | 'gender' | 'concentration' | 'season',
    rawValue: string,
  ): Promise<Fragrance | null> => {
    const value = rawValue.trim();
    if (!value) return null;

    // Build the optimistic local patch with the field's real type.
    const localPatch: Partial<Pick<Fragrance, 'year' | 'gender' | 'concentration' | 'season'>> = {};
    if (field === 'year') {
      const year = Number.parseInt(value, 10);
      if (!Number.isFinite(year) || year < 1800 || year > 2100) {
        toast({
          title: 'Enter a valid year',
          description: 'Use a 4-digit release year, e.g. 2018.',
          variant: 'destructive',
        });
        return null;
      }
      localPatch.year = year;
    } else {
      localPatch[field] = value;
    }
    // The server applies the same guard; mirror it here so the optimistic update
    // and the "saved" toast don't claim success for a placeholder the API drops.
    if (field !== 'year' && !usefulFactString(value)) {
      toast({
        title: "That reads as “unknown”",
        description: 'Enter the real value (e.g. Eau de Parfum) to verify this detail.',
        variant: 'destructive',
      });
      return null;
    }
    const requestBody = field === 'year' ? { year: localPatch.year } : { [field]: value };

    if (!authToken) {
      // Guest: no server row to PATCH — persist onto the local item + localStorage
      // so a guest's verified detail still sticks on this device.
      let next: Fragrance | null = null;
      setItems((prev) => {
        const updated = prev.map((item) => {
          if (!sameWardrobeEntry(item, target)) return item;
          next = { ...item, ...localPatch };
          return next;
        });
        if (next) writeGuestWardrobeItems(updated);
        return updated;
      });
      if (next) {
        toast({ title: 'Detail saved', description: 'Saved to this device.' });
      }
      return next;
    }

    const apiId = target._dbId ?? target.id;
    isMutatingRef.current = true;
    try {
      const res = await fetch(`/api/wardrobe/${apiId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(requestBody),
      });
      const data = (await res.json().catch(() => null)) as
        | (Partial<Fragrance> & { _dbId?: string; error?: string })
        | null;
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const next: Fragrance = {
        ...target,
        ...data,
        ...localPatch,
        id: target.id,
        _dbId: data?._dbId ?? target._dbId,
      };
      setItems((prev) =>
        prev.map((item) => (sameWardrobeEntry(item, target) ? next : item)),
      );
      toast({ title: 'Detail verified', description: 'Thanks — saved to your vault.' });
      return next;
    } catch (e) {
      console.error('Failed to persist verified wardrobe fact', e);
      toast({
        title: 'Save failed',
        description: 'Could not save your verified detail. Try again.',
        variant: 'destructive',
      });
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
              // WS-9c: every row reaching this batch is complete, so stamp the
              // current heal version into fragrance_data. The server persists it
              // and it becomes the cross-device "already healed" marker.
              accordHealVersion: ACCORD_HEAL_RESYNC_VERSION,
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

  // Load (or reset on version bump) the per-token accord-heal re-sync progress,
  // and rehydrate the durable detail-refresh backoff map so a row's cross-reload
  // attempt count survives and the client brake can actually bound polling.
  useEffect(() => {
    accordHealResyncDoneRef.current = readAccordHealResyncDone(authToken ?? '');
    detailRefreshBackoffRef.current = readDetailRefreshBackoff(authToken ?? '');
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
      // WS-9c: server-authoritative skip. Once any device heal-resynced this row
      // for the current version and persisted it, the marker rides in
      // fragrance_data, so a fresh device / guest-after-sign-in sees it on load
      // and does NOT re-fetch the whole already-complete vault.
      if (typeof item.accordHealVersion === 'number' && item.accordHealVersion >= ACCORD_HEAL_RESYNC_VERSION) {
        return false;
      }
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
      // Persist so the attempt count survives reloads and the client brake below
      // actually stops an un-completable row from re-polling every session.
      writeDetailRefreshBackoff(authToken, detailRefreshBackoffRef.current);
    };

    const clearBackoff = (item: Fragrance) => {
      if (detailRefreshBackoffRef.current.delete(detailRefreshKeyFor(item))) {
        writeDetailRefreshBackoff(authToken, detailRefreshBackoffRef.current);
      }
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
          // Durable client brake: once a row has been attempted this many times
          // across reloads (persisted backoff), stop scheduling it — it is not
          // completable and must not poll forever regardless of the engine count.
          if (meta && meta.attemptCount >= MAX_CLIENT_DETAIL_REFRESH_ATTEMPTS) return false;
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
    const snap = structuredClone(wardrobeRevertSnapshot) as Fragrance[];
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
    const snapshot = structuredClone(items) as Fragrance[];

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

    const winner = calculateEngineAlignment(items, intent, weather, scentPreferences);
    if (!winner) return;

    lastIntentRef.current = intent;
    setActiveEngineRecommendation(winner.recommendation);
    setRecommendationReason(winner.recommendation.explanation);
    setActiveRecommendation(winner.item);
  }, [items, weather, scentPreferences]);

  // Keep the surfaced pick honest when conditions move. The recommendation is
  // computed once on intent submission; without this, a later weather refresh
  // (temperature/humidity/rain/wind change) would leave a stale pick and stale
  // spray/projection/window advice on screen that can contradict current air.
  // Re-score against the same intent whenever weather changes while a pick is
  // displayed. Cleared on close so it no-ops otherwise.
  //
  // We intentionally depend on `weather` ONLY (reading the current wardrobe via
  // itemsRef). Depending on `items` re-ran this on every background mutation
  // (60s reconcile poll, image backfill merge, enrichment write) and would
  // reassign activeRecommendation to a possibly-different winner mid-view,
  // silently swapping the fragrance the user is reading and resetting overlay
  // scroll. Weather is the only signal that should re-score an open pick.
  useEffect(() => {
    const intent = lastIntentRef.current;
    const currentItems = itemsRef.current;
    if (!intent || currentItems.length === 0) return;
    const winner = calculateEngineAlignment(currentItems, intent, weather, scentPreferences);
    if (!winner) return;
    setActiveEngineRecommendation(winner.recommendation);
    setRecommendationReason(winner.recommendation.explanation);
    setActiveRecommendation(winner.item);
  }, [weather, scentPreferences]);

  const closeRecommendationOverlay = useCallback(() => {
    lastIntentRef.current = null;
    setActiveRecommendation(null);
    setActiveEngineRecommendation(null);
  }, []);

  // Cross-view detail open. The wardrobe detail modal is owned by the lazy
  // Wardrobe component (the vault section), which is far down the page and may
  // not be mounted/visible when the user taps "View" in the Beam proposal up in
  // the hero, or follows a curation deep-link. Rather than lift that whole modal
  // up to App, we queue the target here. Most callers scroll the vault into view;
  // surfaces with their own shared-element source (the forecast hero) stay put
  // and pass that source id so the modal can project from the visible bottle.
  const openFragranceDetail = useCallback((
    fragrance: Fragrance,
    options?: { sourceLayoutId?: string; scrollToVault?: boolean },
  ) => {
    setPendingDetailOpenSourceLayoutId(options?.sourceLayoutId ?? null);
    setPendingDetailOpen(fragrance);
    if (options?.scrollToVault !== false && typeof document !== 'undefined') {
      document
        .getElementById('scent-vault-section')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const clearPendingDetailOpen = useCallback(() => {
    setPendingDetailOpen(null);
    setPendingDetailOpenSourceLayoutId(null);
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
    pendingDetailOpen,
    pendingDetailOpenSourceLayoutId,
    isImageSyncing,
    setItems,
    setIsIntentModalOpen,
    setIsShareModalOpen,
    setActiveRecommendation,
    setActiveEngineRecommendation,
    setRecommendationReason,
    scentPreferences,
    updateScentPreferences,
    markFragranceWorn,
    setUserId,
    setVaultSearchUiActive,
    loadWardrobe,
    retryLoadWardrobe,
    handleAddItem,
    handlePersistWardrobeImage,
    uploadAdminBottleImage,
    handlePersistWardrobeDetailRefresh,
    handleVerifyWardrobeFact,
    handleRevertWardrobe,
    handleDeleteItem,
    handleIntentComplete,
    closeRecommendationOverlay,
    handleVaultSearchStateChange,
    handleExpandArchive,
    openFragranceDetail,
    clearPendingDetailOpen,
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
    pendingDetailOpen,
    pendingDetailOpenSourceLayoutId,
    isImageSyncing,
    loadWardrobe,
    retryLoadWardrobe,
    handleAddItem,
    handlePersistWardrobeImage,
    uploadAdminBottleImage,
    handlePersistWardrobeDetailRefresh,
    handleVerifyWardrobeFact,
    handleRevertWardrobe,
    handleDeleteItem,
    handleIntentComplete,
    closeRecommendationOverlay,
    handleVaultSearchStateChange,
    handleExpandArchive,
    openFragranceDetail,
    clearPendingDetailOpen,
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
