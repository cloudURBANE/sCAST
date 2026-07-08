import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Award, Check, Search } from 'lucide-react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useCalmMotion } from '@/hooks/useCalmMotion';
import { SCENT_EASE_OUT, SCENT_EASE_OUT_EXPO } from '@/lib/motion';
import { markHouseLogoFailed, resolveHouseLogoUrl } from '@/lib/houseMark';
import { ScentIntelligenceLoader } from './ScentIntelligenceLoader';
import {
  collectMainAccordDisplayRows,
  getFragranceDetails,
  isBackgroundEnrichmentQueued,
  isFetchNetworkError,
  isSearchResponseDegraded,
  isTransientDetailFetchError,
  normalizeFragranceDetail,
  sanitizeEngineQuery,
  searchFragrances,
  type FragranceDetail,
  type FragranceDetailRequestPayload,
  type FragranceSearchResult,
} from '@/lib/fragranceApi';
import {
  buildPyramidFromFlatNotes,
  hasTieredPyramidNotes,
  normalizePyramidNotes as normalizePyramidInput,
} from '@/lib/fragranceNotes';
import { isIpadSafariPerformanceMode, isLowRenderBudget } from '@/lib/platform';

/**
 * Generate a stable, collision-resistant id for newly added wardrobe items.
 * `Math.random().toString(36).substr(2, 9)` is 9 alphanumeric chars (~52
 * bits) — small enough that real users hit collisions, which then make
 * `data.id`-keyed lookups in the wardrobe PATCH/DELETE routes ambiguous (B8).
 */
function newFragranceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for very old browsers — full 128-bit space, hex.
  const a = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const b = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const c = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const d = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${a}-${b}-${c}-${d}`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeNoteList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((item) => {
      if (typeof item !== 'string') return [];
      return item
        .split(/\s*,\s*/)
        .map((note) => note.trim())
        .filter(Boolean);
    })
    .filter((note, index, list) => list.findIndex((candidate) => candidate.toLowerCase() === note.toLowerCase()) === index);
}

function firstNonEmptyNoteList(...values: unknown[]): string[] {
  for (const value of values) {
    const notes = normalizeNoteList(value);
    if (notes.length > 0) return notes;
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * True once a detail payload carries scraped olfactory notes (flat or any
 * pyramid tier). Used to stop polling early when notes land even if the
 * enrichment status hasn't flipped to a terminal value yet.
 */
function detailHasUsableNotes(detail: FragranceDetail): boolean {
  const metricNotes = detail.derived_metrics?.notes;
  const rawNotes = detail.raw?.notes;
  return (
    firstNonEmptyNoteList(
      metricNotes?.flat,
      rawNotes?.flat,
      metricNotes?.top,
      rawNotes?.top,
      metricNotes?.heart,
      rawNotes?.heart,
      metricNotes?.base,
      rawNotes?.base,
    ).length > 0
  );
}

interface FragranceMatch extends FragranceSearchResult {
  name: string;
  brand: string;
  house: string;
  scent_vector?: unknown;
  family?: unknown;
}

type LoadingSurface = 'search' | 'sync' | null;
type ErrorPhase = 'search' | 'sync' | null;

// The loader's longest completion flourish is the 720ms bloom. Keep the veil
// mounted through that choreography so success does not flash and disappear.
const SYNC_COMPLETE_SETTLE_MS = 760;
const REDUCED_MOTION_SETTLE_MS = 680;

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?.trim()
  .replace(/\/+$/, "");
const SCENT_PROFILE_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/scent-profile`
  : "/api/scent-profile";
const SEARCH_SCENT_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/search-scent`
  : "/api/search-scent";

/** Match list rows: keep one line each; overflow shows ellipsis in CSS */
const MATCH_LINE_MAX_CHARS = 30;

function truncateMatchLine(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function matchMonogram(m: FragranceMatch): string {
  const brand = firstString(m.brand, m.house);
  const source = brand || firstString(m.name) || "";
  const cleaned = source.replace(/[^a-z0-9\s]/gi, " ").trim();
  if (!cleaned) return "SC";
  if (/\bdior\b/i.test(cleaned)) return "CD";

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Secondary facts worth surfacing on a result row, in display order. Each is
 * rendered only when the engine actually supplied it, so rows never show
 * placeholder noise: release year, gender bucket (same vocabulary as the
 * filter chips), and the Basenotes community sentiment — gated on a minimum
 * vote count so a 3-vote "100% liked" never masquerades as consensus.
 */
const RATING_MIN_VOTES = 25;

interface MatchMetaItem {
  key: string;
  label: string;
  /** Compact variant for phone widths; falls back to `label`. */
  shortLabel?: string;
  /** Drop on phone widths where the house name needs the room. */
  hideOnMobile?: boolean;
}

function matchMetaItems(m: FragranceMatch): MatchMetaItem[] {
  const items: MatchMetaItem[] = [];

  const year = typeof m.year === 'number' && Number.isFinite(m.year) ? Math.trunc(m.year) : null;
  if (year && year >= 1700 && year <= new Date().getFullYear() + 1) {
    items.push({ key: 'year', label: String(year) });
  }

  const gender = genderLabel(m.gender);
  if (gender) items.push({ key: 'gender', label: gender, hideOnMobile: true });

  const votes = m.bn_vote_count ?? 0;
  const pct = m.bn_positive_pct;
  if (typeof pct === 'number' && Number.isFinite(pct) && votes >= RATING_MIN_VOTES) {
    const rounded = Math.round(Math.min(100, Math.max(0, pct)));
    items.push({ key: 'rating', label: `${rounded}% liked`, shortLabel: `${rounded}%` });
  }

  return items;
}

/**
 * Row anchor disc: the house's actual mark when we can resolve one from the
 * curated domain map (see lib/houseMark.ts), layered over the serif monogram
 * so there is never an empty or broken frame — the monogram stays until the
 * mark has fully loaded, and returns on any failure (offline PWA included).
 */
const HouseMarkDisc: React.FC<{ house?: string; monogram: string }> = ({ house, monogram }) => {
  const logoUrl = useMemo(() => resolveHouseLogoUrl(house), [house]);
  const [logoState, setLogoState] = useState<'loading' | 'loaded' | 'failed'>('loading');

  useEffect(() => {
    setLogoState('loading');
  }, [logoUrl]);

  const showLogo = logoUrl !== null && logoState !== 'failed';

  return (
    <span
      className="scent-vault-monogram relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full font-serif text-[0.95rem] font-semibold leading-none sm:h-12 sm:w-12 sm:text-[1.05rem]"
      aria-hidden
    >
      <span
        className={`transition-opacity duration-300 ${showLogo && logoState === 'loaded' ? 'opacity-0' : 'opacity-100'}`}
      >
        {monogram}
      </span>
      {showLogo && (
        <img
          src={logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => setLogoState('loaded')}
          onError={() => {
            markHouseLogoFailed(logoUrl);
            setLogoState('failed');
          }}
          // Cream medallion behind the mark so dark-on-transparent favicons
          // stay legible against the near-black disc; the gold ring and inset
          // highlight of .scent-vault-monogram continue to frame it.
          className={`absolute inset-0 m-auto h-[72%] w-[72%] rounded-full bg-[#f5eedd] object-contain p-[3px] transition-opacity duration-300 ${
            logoState === 'loaded' ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}
    </span>
  );
};

/**
 * Stable identity for a result row. Selection, filtering, and React keys all
 * use this instead of the array index so a result stays selected when the
 * visible list is re-derived by the House/Gender filters. Every match passes
 * the `id || source_url` guard in `handleSearch`, so this is always non-empty.
 */
function matchKey(m: FragranceMatch): string {
  return firstString(m.id, m.source_url) ?? '';
}

/**
 * Brand + name identity used to tell whether a search result is already in the
 * vault. Adding a fragrance replaces the engine id with a fresh local id, so the
 * row's original id can't be matched back — brand+name is the only stable signal
 * shared across the search result and the saved vault entry. Lowercased, trimmed,
 * punctuation-stripped, and whitespace-collapsed so trivial formatting drift
 * ("Dior — Sauvage" vs "dior sauvage") still collides. Exported so the vault key
 * set is built with the exact same normalization the lookup uses.
 */
export function vaultIdentityKey(brand?: string | null, name?: string | null): string {
  const norm = (value?: string | null) =>
    (value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const b = norm(brand);
  const n = norm(name);
  if (!n) return '';
  return `${b}|${n}`;
}

/** Bucket the engine's free-form gender string into a stable filter label. */
function genderLabel(value: unknown): 'Men' | 'Women' | 'Unisex' | null {
  const g = firstString(value)?.toLowerCase();
  if (!g) return null;
  if (g.includes('unisex')) return 'Unisex';
  const hasWomen = /\b(women|woman|female|femme|feminine)\b/.test(g);
  const hasMen = /\b(men|man|male|homme|masculine)\b/.test(g);
  if (hasWomen && hasMen) return 'Unisex';
  if (hasWomen) return 'Women';
  if (hasMen) return 'Men';
  return null;
}

const GENDER_FILTER_ORDER: ReadonlyArray<'Men' | 'Women' | 'Unisex'> = ['Women', 'Men', 'Unisex'];

const INVALID_RESULT_NAME_STARTERS = new Set(['and', '&', 'by', 'de', 'du', 'di', 'et']);

function isDisplayableResultName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase();
  return !INVALID_RESULT_NAME_STARTERS.has(firstToken);
}

function profileToFallbackMatch(profile: Record<string, unknown>, _query: string): FragranceMatch | null {
  const product = profile.product as Record<string, unknown> | undefined;
  const name = firstString(
    typeof product?.name === 'string' ? product.name : undefined,
    typeof profile.name === 'string' ? profile.name : undefined,
  );
  const brand = firstString(
    typeof product?.brand === 'string' ? product.brand : undefined,
    typeof profile.brand === 'string' ? profile.brand : undefined,
  );

  if (!name || !brand) return null;

  return {
    ...(profile as Record<string, unknown>),
    id: `local:${brand}:${name}`,
    name,
    brand,
    house: brand,
    origin: 'app',
  } as FragranceMatch;
}

async function searchLocalFallback(query: string, signal?: AbortSignal): Promise<FragranceMatch | null> {
  const res = await fetch(SEARCH_SCENT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  });

  const profile = await readJsonOrWarn<Record<string, unknown> & { error?: string }>(
    res,
    'local fallback search',
    {},
  );

  if (!res.ok || (typeof profile.error === 'string' && profile.error.trim())) {
    return null;
  }

  return profileToFallbackMatch(profile, query);
}

async function fetchLocalProfile(query: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const res = await fetch(SEARCH_SCENT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  });

  const profile = await readJsonOrWarn<Record<string, unknown> & { error?: string }>(
    res,
    'local profile fetch',
    {},
  );

  if (!res.ok || (typeof profile.error === 'string' && profile.error.trim())) {
    return null;
  }

  return profile;
}

async function readJsonOrWarn<T>(res: Response, context: string, fallback: T): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[FragranceCapture] ${context} returned unreadable JSON`, {
      status: res.status,
      statusText: res.statusText,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

function formatGender(value: unknown): string | undefined {
  const gender = firstString(value);
  if (!gender) return undefined;
  return gender
    .replace(/\s*\/\s*unspecified\b/i, '')
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' / ');
}

function isFragranticaUrl(value: unknown): value is string {
  return typeof value === 'string' && /fragrantica\.com/i.test(value);
}

const HERITAGE_HOUSES = new Set([
  'Chanel', 'Dior', 'Guerlain', 'Hermès', 'Creed', 'Tom Ford', 'Diptyque', 
  'Byredo', 'Le Labo', 'Frederic Malle', 'Serge Lutens', 'Parfums de Marly',
  'Amouage', 'Roja Dove', 'Maison Francis Kurkdjian', 'By Kilian'
]);

function isVetted(m: FragranceMatch): boolean {
  // 1. Heritage House Check
  if (m.brand && HERITAGE_HOUSES.has(m.brand)) return true;
  if (m.house && HERITAGE_HOUSES.has(m.house)) return true;

  // 2. Community Consensus Check (if metrics are available)
  const votes = m.bn_vote_count ?? 0;
  const rating = m.bn_positive_pct ?? -1;
  
  // High volume (vetted by many) + High sentiment
  if (votes > 400 && rating >= 70) return true;
  // Massive volume (legendary status)
  if (votes > 1000) return true;
  
  return false;
}

export const FragranceCapture: React.FC<{
  onAdd?: (item: any) => void | Promise<{ persisted: boolean; requiresAuth?: boolean; error?: string }>;
  onVaultSearchStateChange?: (active: boolean) => void;
  /** Brand+name identity keys ({@link vaultIdentityKey}) of fragrances already saved. */
  existingVaultKeys?: Set<string>;
  /** Open the matching saved fragrance in the vault — used by the "View in vault"
   *  action on duplicates. Receives the selected result so the parent can open
   *  that exact item's detail rather than just scrolling to the section. */
  onViewVault?: (match: FragranceMatch) => void;
  /** Render only the search interior when the stable vault panel is owned by the parent. */
  embeddedInVaultPanel?: boolean;
  autoFocusTrigger?: number;
}> = ({
  onAdd,
  onVaultSearchStateChange,
  existingVaultKeys,
  onViewVault,
  embeddedInVaultPanel = false,
  autoFocusTrigger,
}) => {
  const [uploading, setUploading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [matches, setMatches] = useState<FragranceMatch[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [houseFilter, setHouseFilter] = useState<string | null>(null);
  const [genderFilter, setGenderFilter] = useState<'Men' | 'Women' | 'Unisex' | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const [errorPhase, setErrorPhase] = useState<ErrorPhase>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [syncComplete, setSyncComplete] = useState(false);
  const [loadingSurface, setLoadingSurface] = useState<LoadingSurface>(null);
  const reduceMotion = useReducedMotion();
  // Canonical calm-motion gate (reduced-motion, phone-class touch, iPad Safari
  // performance mode) for the add-flow's height-collapse exits.
  const reducedAddMotion = useCalmMotion();
  // Render budget for the in-card intelligence loader: phone-class or iPad
  // Safari. Sampled once (device class is stable). Drives the loader's
  // GPU-surface gating so a single search doesn't flood WebKit's compositor.
  const loaderLightweight = useRef(isLowRenderBudget() || isIpadSafariPerformanceMode()).current;

  const searchAbortController = useRef<AbortController | null>(null);
  const syncAbortController = useRef<AbortController | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const actionBarRef = useRef<HTMLDivElement | null>(null);
  const autoFocusPendingRef = useRef(false);

  useEffect(() => {
    return () => {
      searchAbortController.current?.abort();
      syncAbortController.current?.abort();
    };
  }, []);

  // Auto-focus the hero search on load so users can type immediately.
  // Desktop pointers only — on touch devices autofocus pops the keyboard and
  // jumps the viewport. The pending ref keeps this *programmatic* focus from
  // flipping `searchFocused`, which would activate search mode and hide the
  // onboarding steps / discovery CTA before the user has actually engaged.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const el = searchInputRef.current;
    if (!el || document.activeElement === el) return;
    autoFocusPendingRef.current = true;
    el.focus({ preventScroll: true });
    if (document.activeElement !== el) autoFocusPendingRef.current = false;
  }, []);

  // Handle external focus triggers (e.g. deep-link routing)
  useEffect(() => {
    if (autoFocusTrigger && searchInputRef.current) {
      searchInputRef.current.focus({ preventScroll: true });
      if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        searchInputRef.current.click();
      }
    }
  }, [autoFocusTrigger]);

  // Filter chips operate on the full result set; the rendered list, available
  // chips, and the resolved selection are all derived from it so nothing drifts
  // out of sync when a filter hides the currently-selected row.
  const availableHouses = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of matches) {
      const house = firstString(m.house, m.brand);
      if (house && !seen.has(house.toLowerCase())) seen.set(house.toLowerCase(), house);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [matches]);

  const availableGenders = useMemo(() => {
    const present = new Set<'Men' | 'Women' | 'Unisex'>();
    for (const m of matches) {
      const label = genderLabel(m.gender);
      if (label) present.add(label);
    }
    return GENDER_FILTER_ORDER.filter((label) => present.has(label));
  }, [matches]);

  const visibleMatches = useMemo(() => {
    return matches.filter((m) => {
      if (houseFilter) {
        const house = firstString(m.house, m.brand);
        if (!house || house.toLowerCase() !== houseFilter.toLowerCase()) return false;
      }
      if (genderFilter && genderLabel(m.gender) !== genderFilter) return false;
      return true;
    });
  }, [matches, houseFilter, genderFilter]);

  const selectedMatch = useMemo(
    () => visibleMatches.find((m) => matchKey(m) === selectedId) ?? null,
    [visibleMatches, selectedId],
  );

  const vaultSearchActive = searchFocused || searchQuery.trim().length > 0;
  const hasSelectedMatch = selectedMatch !== null;

  // A result is "already in vault" when its brand+name identity is in the saved
  // set. Used to badge rows and to convert the primary CTA into "View in vault"
  // so a fragrance can't be silently added twice.
  const matchInVault = useCallback(
    (m: FragranceMatch): boolean => {
      if (!existingVaultKeys || existingVaultKeys.size === 0) return false;
      const key = vaultIdentityKey(firstString(m.brand, m.house), m.name);
      return key.length > 0 && existingVaultKeys.has(key);
    },
    [existingVaultKeys],
  );
  const selectedInVault = selectedMatch ? matchInVault(selectedMatch) : false;

  // Plain (non-memoized) so it always closes over the current `handleConfirm`,
  // which is declared below and re-created each render.
  const handlePrimaryAction = () => {
    if (selectedInVault && selectedMatch) {
      onViewVault?.(selectedMatch);
      return;
    }
    void handleConfirm();
  };

  // When a filter hides the selected row, clear the selection so the "ready to
  // add" CTA never points at something off-screen. Never auto-pick another
  // result — adding to vault must always reflect an explicit user choice.
  useEffect(() => {
    if (!selectedId) return;
    if (visibleMatches.some((m) => matchKey(m) === selectedId)) return;
    setSelectedId(null);
  }, [visibleMatches, selectedId]);

  // Selection changes the CTA from disabled to actionable. Wait for that
  // committed layout, then center the desktop action instead of leaving it
  // below the fold. Mobile already exposes a fixed, portaled action bar.
  useEffect(() => {
    if (!selectedId || typeof window === 'undefined') return;
    if (!window.matchMedia('(min-width: 640px)').matches) return;
    // Run after the clicked result receives browser focus; otherwise that native
    // focus scroll can win the same frame and strand the CTA below the fold.
    const id = window.setTimeout(() => {
      const actionBar = actionBarRef.current;
      if (!actionBar) return;
      const rect = actionBar.getBoundingClientRect();
      // Skip the scroll when the CTA is already fully in view. With a compact
      // result set (e.g. a single match, now that the panel hugs its content)
      // the action appears on-screen immediately, so re-centering it only reads
      // as an unprompted jump. Only chase the CTA when it's actually off the fold.
      if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
      const top = window.scrollY + rect.top - Math.max(0, (window.innerHeight - rect.height) / 2);
      window.scrollTo({
        behavior: reduceMotion ? 'auto' : 'smooth',
        top,
      });
    }, 240);
    return () => window.clearTimeout(id);
  }, [reduceMotion, selectedId]);
  useEffect(() => {
    onVaultSearchStateChange?.(vaultSearchActive);
  }, [vaultSearchActive, onVaultSearchStateChange]);

  useEffect(() => {
    return () => {
      onVaultSearchStateChange?.(false);
    };
  }, [onVaultSearchStateChange]);

  const handleSearch = async (e?: React.FormEvent, overrideQuery?: string) => {
    if (e) e.preventDefault();
    
    const targetQuery = (overrideQuery !== undefined ? overrideQuery : searchQuery).trim();
    if (!targetQuery) return;

    // Abort any in-flight searches to prevent race conditions
    if (searchAbortController.current) {
      searchAbortController.current.abort();
    }
    const controller = new AbortController();
    searchAbortController.current = controller;

    // Loading replaces the search controls visually and in the accessibility
    // tree, so release input focus before the embedded interior is hidden.
    searchInputRef.current?.blur();
    setUploading(true);
    setLoadingSurface('search');
    setLoadingStatus("Researching Fragrance...");
    setMatches([]);
    setSelectedId(null);
    setHouseFilter(null);
    setGenderFilter(null);
    setErrorStatus(null);
    setErrorPhase(null);
    setHasSearched(false);
    setSyncComplete(false);

    try {
      let nextMatches: FragranceMatch[] = [];
      let primarySearchError: Error | null = null;
      // True when the engine answered from a degraded/fallback path. A zero-result
      // search in that state is a transient coverage condition (live providers
      // were blocked), so it is surfaced as retryable rather than a flat "no such
      // fragrance" — see the empty-state branch below.
      let searchWasDegraded = false;

      try {
        const searchData = await searchFragrances(targetQuery, { signal: controller.signal });
        searchWasDegraded = isSearchResponseDegraded(searchData);
        const results = Array.isArray(searchData.results) ? searchData.results : [];
        nextMatches = results
          .map((result): FragranceMatch | null => {
            const house = firstString(result.house, result.brand) ?? "";
            const id = firstString(result.id) ?? "";
            const name = firstString(result.name);
            if (!isDisplayableResultName(name)) return null;
            return {
              ...result,
              id,
              name,
              house,
              brand: house,
              origin: result.origin ?? 'srt',
            };
          })
          .filter((result): result is FragranceMatch => Boolean(result && (result.id || firstString(result.source_url))));
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        primarySearchError =
          err instanceof Error ? err : new Error(String(err));
        console.warn('[FragranceCapture] external fragrance search failed', {
          query: targetQuery,
          error: primarySearchError.message,
        });
      }

      if (nextMatches.length === 0) {
        const fallbackMatch = await searchLocalFallback(targetQuery, controller.signal);
        if (fallbackMatch) nextMatches = [fallbackMatch];
      }

      setHasSearched(true);
      if (nextMatches.length === 0) {
        if (primarySearchError) {
          const message = isFetchNetworkError(primarySearchError)
            ? 'Fragrance search is temporarily unavailable. Check your connection and try again.'
            : primarySearchError.message || 'Search failed.';
          setErrorStatus(message);
          setErrorPhase('search');
          setLoadingStatus('Search failed.');
        } else if (searchWasDegraded) {
          // The engine reached us but only via a degraded fallback and found
          // nothing — a retryable coverage gap, not a confirmed non-match. Route
          // it through the error banner's "Try Again" instead of the absolute
          // "No Olfactory Matches" empty state, which would misread a transient
          // provider outage as the fragrance not existing.
          setErrorStatus('Search is still expanding coverage for this one. Try again in a moment.');
          setErrorPhase('search');
          setLoadingStatus('Coverage still expanding.');
        } else {
          setLoadingStatus('No fragrance match found.');
        }
      }
      // On success leave loadingStatus as "Researching Fragrance..."; the overlay
      // exits via finally → setUploading(false) and the results list animates in.
      setMatches(nextMatches);
      // No default selection: the user must explicitly pick a result before
      // "Add to Vault" enables, so it can never act on a row they didn't choose.
      setSelectedId(null);

    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return; // Ignore expected aborts
      setErrorStatus(err instanceof Error ? err.message : "Search failed.");
      setErrorPhase('search');
    } finally {
      if (searchAbortController.current === controller) {
        searchAbortController.current = null;
        setUploading(false);
        setLoadingSurface(null);
      }
    }
  };

  const handleConfirm = async () => {
    if (!selectedMatch || !onAdd) return;

    const selected = selectedMatch;
    if (selected.scent_vector) {
      setUploading(true);
      setLoadingSurface('sync');
      setLoadingStatus("Syncing to Vault...");
      setSyncComplete(false);
      const familyStr = typeof selected.family === 'string' ? selected.family : '';
      try {
        const saveResult = await onAdd({
          ...selected,
          id: newFragranceId(),
          season: familyStr.includes('Fresh') ? 'Summer' : familyStr.includes('Woody') ? 'Winter' : 'Universal',
        });
        setLoadingStatus(
          saveResult?.persisted
            ? "Synced to Vault."
            : saveResult?.error
              ? `Added locally. ${saveResult.error}`
              : "Added locally. Sign in to save.",
        );
        if (saveResult?.error) {
          setErrorStatus(`Added locally, but database save failed: ${saveResult.error}`);
          setErrorPhase('sync');
          setSyncComplete(false);
          return;
        }
        setSyncComplete(true);
        await sleep(reduceMotion ? REDUCED_MOTION_SETTLE_MS : SYNC_COMPLETE_SETTLE_MS);
        resetState();
      } catch (err: any) {
        setErrorStatus(err?.message || "Vault sync failed. Please try again.");
        setErrorPhase('sync');
        setSyncComplete(false);
      } finally {
        setUploading(false);
        setLoadingSurface(null);
      }
      return;
    }

    // Local detail id for this confirm — named distinctly from the `selectedId`
    // selection *state* above so it can never shadow it.
    const selectedDetailId = firstString(selected.id);
    const selectedSourceUrl = firstString(selected.source_url);
    if (!selectedDetailId && !selectedSourceUrl) {
      setErrorStatus("Selected fragrance is missing a detail identifier.");
      return;
    }

    // Abort any in-flight syncs to prevent duplicate database writes
    if (syncAbortController.current) {
      syncAbortController.current.abort();
    }
    const controller = new AbortController();
    syncAbortController.current = controller;

    setUploading(true);
    setLoadingSurface('sync');
    setLoadingStatus("Fetching Fragrance Intelligence...");
    setSyncComplete(false);

    try {
      const syntheticSourceUrl = selectedDetailId?.startsWith('source:')
        ? firstString(selectedDetailId.slice('source:'.length))
        : undefined;
      const detailSourceUrl = firstString(selectedSourceUrl, syntheticSourceUrl);
      const selectedOrigin = syntheticSourceUrl
        ? 'app'
        : selected.origin ??
          (
            selectedDetailId?.startsWith('catalog:') ||
            selectedDetailId?.startsWith('dataset:') ||
            selectedDetailId?.startsWith('local:')
              ? 'app'
              : 'srt'
          );
      const detailsRequest: FragranceDetailRequestPayload =
        selectedOrigin === 'app' && detailSourceUrl
          ? { source_url: detailSourceUrl, origin: 'app' }
          : selectedOrigin === 'app' && selectedDetailId
            ? { id: selectedDetailId, origin: 'app' }
            : selectedDetailId
          ? {
              id: selectedDetailId,
              origin: 'srt',
            }
          : { source_url: detailSourceUrl as string, origin: 'app' };

      if (!detailSourceUrl || !isFragranticaUrl(detailSourceUrl)) {
        // Useful in production debugging: explains why partial details may not enqueue.
        console.info('[FragranceCapture] /details request has no Fragrantica source URL', {
          selectedId: selected.id,
          selectedSourceUrl,
        });
      }

      let detail: FragranceDetail;
      try {
        detail = normalizeFragranceDetail(
          (await getFragranceDetails(detailsRequest, { signal: controller.signal })) as FragranceDetail,
        );
      } catch (detailErr) {
        if (detailErr instanceof Error && detailErr.name === 'AbortError') throw detailErr;
        // Real failures (validation, 4xx not-found) still surface to the user.
        if (!isTransientDetailFetchError(detailErr)) throw detailErr;
        // Transient failure on a valid selection: synthesize a minimal detail from
        // the selected result so the add can still proceed through the scent-profile
        // pipeline (which only needs name/brand). The olfactory pyramid simply comes
        // back thinner until a later detail refresh fills it in — far better than
        // failing the whole add over a momentary engine hiccup.
        console.warn(
          '[FragranceCapture] detail fetch failed transiently; proceeding with best-effort profile from selected result',
          {
            selectedId: selected.id,
            error: detailErr instanceof Error ? detailErr.message : String(detailErr),
          },
        );
        detail = normalizeFragranceDetail({
          id: selectedDetailId,
          name: selected.name,
          brand: firstString(selected.brand, selected.house),
          house: firstString(selected.house, selected.brand),
          source_url: selectedSourceUrl,
        } as FragranceDetail);
      }

      // A brand-new fragrance can come back as a provisional detail with no
      // notes while the backend scrapes the olfactory pyramid in the background
      // (enrichment.status === "pending"|"processing"). Give it a brief,
      // non-blocking grace — a couple of quick re-checks rather than the old
      // ~30s poll that read as a frozen screen — so a fast scrape upgrades the
      // vector. If notes still haven't landed we proceed immediately; the
      // local-profile fallback below keeps the add from failing either way.
      const POLL_INTERVAL_MS = 1000;
      const MAX_POLL_ATTEMPTS = 2; // ~2s ceiling, down from ~30s
      // Each re-check fetch can otherwise block the full engine timeout
      // (ENGINE_FETCH_TIMEOUT_MS ~20s) if the engine connects-then-stalls, turning
      // this "couple of quick re-checks" into a ~40s frozen "Fetching Intelligence…".
      // Bound each grace re-check on its own short deadline; on timeout we keep the
      // detail we already have and proceed to the local-profile fallback (the 15s
      // background self-heal loop upgrades the tile later).
      const GRACE_RECHECK_TIMEOUT_MS = 4000;
      for (
        let attempt = 0;
        attempt < MAX_POLL_ATTEMPTS &&
        !controller.signal.aborted &&
        isBackgroundEnrichmentQueued(detail.enrichment) &&
        !detailHasUsableNotes(detail);
        attempt += 1
      ) {
        await sleep(POLL_INTERVAL_MS);
        if (controller.signal.aborted) break;
        // Compose the outer abort signal with a per-attempt timeout (deliberately
        // not AbortSignal.any/timeout — older iOS Safari lacks them).
        const graceController = new AbortController();
        const graceTimer = setTimeout(() => graceController.abort(), GRACE_RECHECK_TIMEOUT_MS);
        const forwardAbort = () => graceController.abort();
        controller.signal.addEventListener('abort', forwardAbort, { once: true });
        try {
          detail = normalizeFragranceDetail(
            (await getFragranceDetails(detailsRequest, { signal: graceController.signal })) as FragranceDetail,
          );
        } catch (graceErr) {
          // A genuine outer cancellation (the whole add was aborted) must still
          // propagate; a grace-only timeout just stops the polling early.
          if (controller.signal.aborted) throw graceErr;
          break;
        } finally {
          clearTimeout(graceTimer);
          controller.signal.removeEventListener('abort', forwardAbort);
        }
      }

      const metricNotes = detail.derived_metrics?.notes;
      const rawNotes = detail.raw?.notes;
      const pyramidNotes = {
        top: firstNonEmptyNoteList(metricNotes?.top, rawNotes?.top),
        heart: firstNonEmptyNoteList(metricNotes?.heart, rawNotes?.heart),
        base: firstNonEmptyNoteList(metricNotes?.base, rawNotes?.base),
      };
      const displayNotes = firstNonEmptyNoteList(
        metricNotes?.flat,
        rawNotes?.flat,
        [...pyramidNotes.top, ...pyramidNotes.heart, ...pyramidNotes.base],
      );
      const intelligenceSeedNotes = firstNonEmptyNoteList(
        displayNotes,
        collectMainAccordDisplayRows(detail.derived_metrics?.main_accords).map((row) => row.label),
      );
      const detailName = firstString(detail.name, selected.name) ?? selected.name;
      const detailBrand =
        firstString(detail.brand, detail.house, selected.brand, selected.house) ??
        selected.brand;
      const detailHouse = firstString(detail.house, detail.brand, selected.house, selected.brand);
      const detailFamily = firstString(
        typeof detail.family === 'string' ? detail.family : undefined,
      );
      const detailPerfumer = firstString(
        typeof detail.perfumer === 'string' ? detail.perfumer : undefined,
      );
      const detailDescription =
        typeof detail.raw?.description === 'string' ? detail.raw.description : undefined;
      // The engine has already resolved a real (Decodo-crawled) bottle image for
      // this fragrance. Forward it as the pipeline's FALLBACK: the server runs
      // the scored Serper image search first (the optimal packshot) and only
      // processes this known URL when that search yields nothing — so an empty
      // Serper result can't leave the new add permanently "no image". Without
      // this passthrough the engine's image is discarded and the tile depends
      // entirely on the flaky Serper leg.
      const detailImageUrl = firstString(detail.imageUrl, detail.image_url);

      const profileRes = await fetch(SCENT_PROFILE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: detailName,
          brand: detailBrand,
          preferEngineData: intelligenceSeedNotes.length > 0,
          notes: intelligenceSeedNotes.length > 0 ? intelligenceSeedNotes : undefined,
          ...(detailFamily ? { family: detailFamily } : {}),
          ...(detailDescription ? { description: detailDescription } : {}),
          ...(detailPerfumer ? { perfumer: detailPerfumer } : {}),
          ...(detailImageUrl ? { imageUrl: detailImageUrl } : {}),
          ...(pyramidNotes.top.length || pyramidNotes.heart.length || pyramidNotes.base.length
            ? { pyramid: pyramidNotes }
            : {}),
        }),
        signal: controller.signal,
      });
      let pipelineProfile = await readJsonOrWarn<Record<string, unknown> & { error?: string }>(
        profileRes,
        'image pipeline profile',
        {},
      );
      if (!profileRes.ok) {
        throw new Error(
          typeof pipelineProfile.error === 'string' && pipelineProfile.error.trim()
            ? pipelineProfile.error
            : `Image pipeline failed: ${profileRes.status}`,
        );
      }
      if (typeof pipelineProfile.error === 'string' && pipelineProfile.error.trim()) {
        const fallbackProfile = await fetchLocalProfile(
          [detailBrand, detailName].filter(Boolean).join(' '),
          controller.signal,
        );
        if (!fallbackProfile) throw new Error(pipelineProfile.error);
        pipelineProfile = fallbackProfile;
      }

      const pipelineImageUrl = firstString(
        typeof pipelineProfile.imageUrl === 'string' ? pipelineProfile.imageUrl : undefined,
      );
      const pipelinePyramid = normalizePyramidInput(pipelineProfile.pyramid as unknown);
      const resolvedPyramid = hasTieredPyramidNotes(pyramidNotes)
        ? pyramidNotes
        : hasTieredPyramidNotes(pipelinePyramid)
          ? {
              top: pipelinePyramid.top,
              heart: pipelinePyramid.heart,
              base: pipelinePyramid.base,
            }
          : buildPyramidFromFlatNotes(displayNotes);

      const saveResult = await onAdd({
        ...detail,
        raw_engine_detail: detail,
        source_coverage: detail.source_coverage,
        derived_metrics: detail.derived_metrics ?? null,
        enrichment: detail.enrichment ?? null,
        fragranceApiId: firstString(detail.id, selected.id) ?? selected.id,
        name: (pipelineProfile.name as string | undefined) ?? detailName,
        brand: (pipelineProfile.brand as string | undefined) ?? detailBrand,
        house: detailHouse,
        product: pipelineProfile.product,
        scent_vector: pipelineProfile.scent_vector,
        performance: pipelineProfile.performance,
        context: pipelineProfile.context,
        concentration: pipelineProfile.concentration,
        accords: pipelineProfile.accords,
        family: (pipelineProfile.family as string | undefined) ?? detailFamily,
        imageUrl: pipelineImageUrl || "",
        storagePath: pipelineProfile.storagePath as string | undefined,
        imageHash: pipelineProfile.imageHash as string | null | undefined,
        storageProvider: pipelineProfile.storageProvider as string | undefined,
        id: newFragranceId(),
        season: 'Universal',
        source_url: firstString(detail.source_url, selected.source_url),
        pyramid: hasTieredPyramidNotes(resolvedPyramid) ? resolvedPyramid : undefined,
        notes: displayNotes.length > 0 ? displayNotes : undefined,
        description:
          typeof detail.raw?.description === 'string'
            ? detail.raw.description
            : undefined,
      });
      setLoadingStatus(
        saveResult?.persisted
          ? "Synced to Vault."
          : saveResult?.error
            ? `Added locally. ${saveResult.error}`
            : "Added locally. Sign in to save.",
      );
      if (saveResult?.error) {
        setErrorStatus(`Added locally, but database save failed: ${saveResult.error}`);
        setErrorPhase('sync');
        setSyncComplete(false);
        return;
      }
      setSyncComplete(true);
      // Let the complete flourish finish before the veil begins its own exit.
      await sleep(reduceMotion ? REDUCED_MOTION_SETTLE_MS : SYNC_COMPLETE_SETTLE_MS);
      resetState();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorStatus(
        isFetchNetworkError(err)
          ? 'Fragrance sync is temporarily unavailable. Check your connection and try again.'
          : (err instanceof Error && err.message) || "Fragrance detail fetch failed. Please check your connection.",
      );
      setErrorPhase('sync');
    } finally {
      if (syncAbortController.current === controller) {
        syncAbortController.current = null;
        setUploading(false);
        setLoadingSurface(null);
      }
    }
  };

  const handleRetry = () => {
    setErrorStatus(null);
    const shouldRetrySync = errorPhase === 'sync' && selectedMatch !== null;
    setErrorPhase(null);
    if (shouldRetrySync) {
      void handleConfirm();
      return;
    }
    void handleSearch();
  };

  const resetState = useCallback(() => {
    setMatches([]);
    setSelectedId(null);
    setHouseFilter(null);
    setGenderFilter(null);
    setHasSearched(false);
    setSearchQuery("");
    setErrorPhase(null);
    setSyncComplete(false);
  }, []);

  const cancelActiveSearch = useCallback(() => {
    if (loadingSurface !== 'search') return;
    searchAbortController.current?.abort();
    searchAbortController.current = null;
    setUploading(false);
    setLoadingSurface(null);
    setLoadingStatus("");
  }, [loadingSurface]);

  // Close (×) / Esc — dismiss the results surface entirely and return the user to
  // the search field. Unlike "New search" this does NOT auto-focus the input, so
  // closing on mobile doesn't pop the keyboard back open; it just clears and
  // scrolls the (now-empty) search area back into view.
  const handleDismissResults = useCallback(() => {
    cancelActiveSearch();
    resetState();
    setErrorStatus(null);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [cancelActiveSearch, resetState]);

  // Esc closes the search surface whenever it is conceptually open — results
  // showing, a completed (possibly empty) search, a typed query, or just the
  // focused field. Gating on `matches.length` alone left Esc dead before any
  // results arrived, forcing users onto the × button. Bound at the document
  // level so it works regardless of where focus currently sits.
  const searchSurfaceOpen = matches.length > 0 || hasSearched || vaultSearchActive;
  useEffect(() => {
    if (!searchSurfaceOpen || loadingSurface === 'sync') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        searchInputRef.current?.blur();
        handleDismissResults();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchSurfaceOpen, loadingSurface, handleDismissResults]);

  // Bring freshly-arrived results into view so the list isn't stranded below the
  // fold on tall mobile layouts. Runs once per result set — deferred until the
  // entrance fade has settled, because a smooth programmatic scroll running
  // concurrently with the entrance animation (and the panel's height change)
  // is exactly the compound motion that reads as jitter on iPhone PWA.
  // `block: 'nearest'` makes it a no-op when the list is already in view.
  useEffect(() => {
    if (matches.length === 0 || uploading) return;
    const id = window.setTimeout(() => {
      resultsRef.current?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'nearest',
      });
    }, reducedAddMotion ? 360 : 440);
    return () => window.clearTimeout(id);
  }, [matches.length, uploading, reduceMotion, reducedAddMotion]);

  const chipClass = (active: boolean): string =>
    `inline-flex max-w-[11rem] items-center truncate rounded-full border px-3 py-1.5 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 ${
      active
        ? 'border-scent-accent/80 bg-scent-accent/15 text-[#fff7ec]'
        : 'border-white/30 text-scent-text-muted hover:border-scent-accent/45 hover:text-[#fff7ec]'
    }`;

  const filtersActive = houseFilter !== null || genderFilter !== null;
  const showFilterBar = availableHouses.length > 1 || availableGenders.length > 1;

  // Empty-state recovery suggestions, derived from the (still-present) query so a
  // failed search offers a concrete next step instead of a dead end.
  const trimmedQuery = searchQuery.trim();
  const sanitizedQuery = sanitizeEngineQuery(trimmedQuery);
  const brandOnlyQuery = sanitizedQuery.split(' ')[0] ?? '';
  const canSanitizeQuery =
    sanitizedQuery.length > 0 && sanitizedQuery.toLowerCase() !== trimmedQuery.toLowerCase();
  const canBrandOnlyQuery =
    brandOnlyQuery.length >= 2 && brandOnlyQuery.toLowerCase() !== sanitizedQuery.toLowerCase();
  const runRecoverySearch = (query: string) => {
    setSearchQuery(query);
    void handleSearch(undefined, query);
  };

  /* Sync overlay — full-screen portal, separate from the search overlay. */
  const syncVeil = uploading && loadingSurface === 'sync' ? (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.32, ease: SCENT_EASE_OUT }}
      className="fixed inset-0 z-[130] flex flex-col items-center justify-center px-6 py-[max(2rem,env(safe-area-inset-top))]"
      style={{
        background:
          'radial-gradient(ellipse 58% 46% at 50% 36%, rgba(212,175,55,0.08), transparent 64%), radial-gradient(ellipse 88% 62% at 50% 108%, rgba(212,175,55,0.05), transparent 68%), #030201',
        boxShadow:
          'inset 0 1px 0 rgba(255,230,180,0.06), inset 0 0 120px rgba(212,175,55,0.045)',
      }}
    >
      <ScentIntelligenceLoader
        status={loadingStatus}
        complete={syncComplete}
        lightweight={loaderLightweight}
      />
    </m.div>
  ) : null;

  /* Search overlay — lives *inside* the card, positioned absolute but with
     a min-height that forces the card to expand so the orbital animation
     never clips. The card's `.glass-shell` has overflow:hidden, so if the
     overlay is shorter than the loader, the top/bottom of the orbits gets
     cut off. By setting min-height on both the overlay *and* a spacer in
     the card flow, the card grows to accommodate the full animation. */
  const SEARCH_LOADER_MIN_H = 320; // px – enough for 132px orb zone + margins + text
  const searchVeil = uploading && loadingSurface === 'search' ? (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.32, ease: SCENT_EASE_OUT }}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center p-8"
      style={{
        minHeight: SEARCH_LOADER_MIN_H,
        // No backdrop-filter: animating a blur layer in over the card is the
        // documented iOS Safari / iPad-PWA GPU-crash construct. The embedded
        // loader uses the parent panel's surface; standalone mode supplies its
        // own opaque fill.
        background: embeddedInVaultPanel
          ? 'transparent'
          : 'radial-gradient(ellipse 70% 60% at 50% 16%, rgba(212,175,55,0.06), transparent 60%), radial-gradient(ellipse 85% 55% at 50% 102%, rgba(212,175,55,0.05), transparent 64%), #030201',
        boxShadow: embeddedInVaultPanel
          ? 'none'
          : 'inset 0 1px 0 rgba(255,230,180,0.08), inset 0 0 90px rgba(212,175,55,0.05)',
      }}
    >
      <ScentIntelligenceLoader
        status={loadingStatus}
        complete={syncComplete}
        lightweight={loaderLightweight}
      />
      {/* Indeterminate progress bar — a concrete "work in progress" signal beneath
          the orbital loader so submitting a search reads as active progress rather
          than an abrupt jump to a static overlay. Reduced-motion users get a steady
          partial fill instead of the sweeping highlight. */}
      <div
        className="mt-7 h-[3px] w-44 max-w-[62%] overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-label="Searching fragrances"
      >
        {reduceMotion ? (
          <div className="h-full w-2/3 rounded-full bg-scent-accent/80" />
        ) : (
          <m.div
            className="h-full w-1/3 rounded-full bg-scent-accent/85"
            animate={{ x: ['-110%', '320%'] }}
            transition={{ duration: 1.15, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </div>
    </m.div>
  ) : null;

  /* Mobile action bar — a fixed, viewport-pinned CTA only after the user selects
     a result, keeping the unselected browsing state compact. Portaled to <body> because the
     panel root is overflow:hidden, which traps a CSS `position: sticky` bar. The
     desktop CTA stays inline (`sm:block`); this is `sm:hidden`. */
  const mobileActionBar = matches.length > 0 && hasSelectedMatch && !uploading ? (
    <m.div
      key="mobile-action-bar"
      initial={reduceMotion ? false : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
      transition={{ duration: 0.26, ease: SCENT_EASE_OUT }}
      className="fixed inset-x-0 bottom-[calc(var(--mobile-nav-offset,var(--bottomnav-h))+0.35rem)] z-[120] bg-gradient-to-t from-scent-bg via-scent-bg/95 to-transparent px-4 pb-2 pt-6 sm:hidden transition-[bottom] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
    >
      <div className="mx-auto w-full max-w-[39.75rem]">
        <button
          type="button"
          onClick={handlePrimaryAction}
          className="scent-vault-outline-button flex h-[54px] w-full cursor-pointer items-center justify-center px-4 transition-transform hover:scale-[1.01] active:scale-[0.98]"
        >
          <span className="scent-vault-outline-button-label font-serif italic text-[1.22rem] leading-tight text-center">
            {selectedInVault ? 'View in vault' : 'Add to Vault'}
          </span>
        </button>
      </div>
    </m.div>
  ) : null;

  return (
    <div className={embeddedInVaultPanel ? "relative w-full min-w-0" : "scent-vault-panel w-full min-w-0 relative overflow-hidden"}>
      <AnimatePresence>
        {searchVeil}
      </AnimatePresence>
      <div
        // transition-opacity: the interior used to snap invisible/visible in a
        // single frame when the embedded search veil took over — a hard cut
        // right at the start of the open gesture. Fading it under the veil's
        // own 0.32s fade turns the swap into one continuous cross-fade.
        className={`scent-vault-panel-inner min-w-0 transition-opacity duration-300 ease-out ${
          embeddedInVaultPanel && loadingSurface === 'search' && uploading
            ? 'pointer-events-none opacity-0'
            : ''
        }`}
        aria-hidden={embeddedInVaultPanel && loadingSurface === 'search' && uploading}
      >
        <header className="mx-auto mb-1.5 max-w-[43rem] px-1 text-center sm:mb-4">
          <p className="sr-only">
            Add perfumes to your vault. Example fragrance names rotate above the search field.
          </p>
          {/* Sized to read as an invitation, not a headline: the clamp was
              trimmed again (was 1.45–3.6rem) so this utility prompt no longer
              competes with the Scent Forecast hero below — the forecast
              fragrance, not the search prompt, is the page star. */}
          <h2 className="mx-auto max-w-[38rem] text-balance font-serif italic text-[clamp(1.3rem,4vw,2.75rem)] leading-[1.05] tracking-normal text-[#fff7ec] drop-shadow-[0_4px_14px_rgba(0,0,0,0.72)] sm:leading-[1.03]">
            Search any fragrance or brand.
          </h2>
        </header>

        <AnimatePresence>
          {errorStatus && (
            <m.div
              initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              className="mb-4 rounded-scent border border-scent-accent/40 bg-scent-accent/[0.07] p-3 text-center"
              role="status"
            >
              <div className="flex flex-col items-center gap-2 mb-2">
                <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-scent-accent/90" />
                <p className="max-w-md text-sm font-medium leading-relaxed text-scent-text-secondary">{errorStatus}</p>
              </div>
              <button
                type="button"
                onClick={handleRetry}
                className="scent-type-chip text-scent-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
              >
                Try Again
              </button>
            </m.div>
          )}
        </AnimatePresence>

        <div className="mx-auto max-w-[42.75rem] text-center">
          <form onSubmit={handleSearch} aria-busy={uploading} className="relative group">
            <input
              ref={searchInputRef}
              id="scent-add-to-vault-search"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchFocused(true); setErrorStatus(null); setErrorPhase(null); }}
              onPointerDown={(e) => {
                if (document.activeElement !== e.currentTarget) {
                  e.currentTarget.focus({ preventScroll: true });
                }
              }}
              onFocus={() => {
                if (autoFocusPendingRef.current) {
                  autoFocusPendingRef.current = false;
                  return;
                }
                setSearchFocused(true);
              }}
              onBlur={() => {
                setSearchFocused(false);
                autoFocusPendingRef.current = false;
              }}
              placeholder={searchFocused ? '' : 'Search by house or fragrance...'}
              aria-label="Look up a brand or fragrance"
              className="scent-lux-input scent-vault-search-input relative z-0 h-[56px] w-full text-center font-sans text-base font-medium text-[#fff7ec] outline-none transition-colors placeholder:text-scent-text-subtle placeholder:font-medium sm:h-[64px] scroll-mt-28 px-16 sm:px-[4.35rem]"
            />
            <m.button
              type="submit"
              disabled={uploading || !trimmedQuery}
              whileHover={uploading ? undefined : { scale: 1.06 }}
              whileTap={uploading ? undefined : { scale: 0.9 }}
              transition={{ type: "spring", stiffness: 520, damping: 22 }}
              className="absolute right-3.5 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-scent-accent shadow-none outline-none transition-colors hover:text-[#fff7ec] focus-visible:ring-2 focus-visible:ring-scent-accent/35 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-45 group-focus-within:text-scent-accent"
              aria-label="Search"
            >
              <m.span
                className="relative inline-flex"
                aria-hidden
                animate={reduceMotion || uploading ? undefined : { opacity: [0.74, 1, 0.74] }}
                transition={reduceMotion || uploading ? undefined : { duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
              >
                <Search size={18} strokeWidth={1.75} className="drop-shadow-[0_0_12px_rgba(212,175,55,0.22)]" />
              </m.span>
            </m.button>
          </form>
        </div>

        {/* Screen-reader announcement for dynamic search results */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {uploading
            ? ''
            : hasSearched
              ? matches.length > 0
                ? `${matches.length} fragrance ${matches.length === 1 ? 'result' : 'results'} loaded`
                : 'No fragrance matches found'
              : ''}
        </div>

        <AnimatePresence>
          {/* Genuine empty state — only when the search truly returned nothing.
              Suppressed while `errorStatus` is set so a technical failure shows
              the single error banner above (with its own retry) instead of also
              claiming "No Olfactory Matches", which would misattribute an engine
              outage to an absent fragrance. */}
          {hasSearched && matches.length === 0 && !uploading && !errorStatus && (
            <m.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="mt-10 py-10 border-t border-white/10 flex flex-col items-center text-center"
            >
              <p className="mb-2 font-serif text-lg italic text-scent-text-muted">No Olfactory Matches Found</p>
              <p className="max-w-[19rem] scent-type-label leading-relaxed">
                Try removing accents, symbols, or extra words. Search by brand,
                fragrance name, or a simpler spelling.
              </p>
              {(canSanitizeQuery || canBrandOnlyQuery) && (
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  {canSanitizeQuery && (
                    <button
                      type="button"
                      onClick={() => runRecoverySearch(sanitizedQuery)}
                      className="inline-flex min-h-[44px] items-center rounded-full border border-scent-accent/45 bg-scent-accent/10 px-4 py-1.5 scent-type-chip text-scent-accent transition-colors hover:border-scent-accent/70 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
                    >
                      Remove symbols
                    </button>
                  )}
                  {canBrandOnlyQuery && (
                    <button
                      type="button"
                      onClick={() => runRecoverySearch(brandOnlyQuery)}
                      className="inline-flex min-h-[44px] items-center rounded-full border border-scent-accent/45 bg-scent-accent/10 px-4 py-1.5 scent-type-chip text-scent-accent transition-colors hover:border-scent-accent/70 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
                    >
                      Brand only
                    </button>
                  )}
                </div>
              )}
            </m.div>
          )}

          {matches.length > 0 && (
            <m.div
              ref={resultsRef}
              // Calm devices (all iPhones — see useCalmMotion) get a pure
              // cross-fade: the panel's height change is instantaneous there,
              // so an extra y-translate on the content reads as two competing
              // motions (the "jagged" open). Desktop keeps the gentle rise,
              // retimed to the parent hero box's height tween (0.42s expo in
              // App.tsx) so panel and content move as one gesture.
              initial={reducedAddMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={reducedAddMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reducedAddMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: reducedAddMotion ? 0.34 : 0.42, ease: SCENT_EASE_OUT_EXPO }}
              className={`mx-auto mt-5 w-full scroll-mt-24 sm:mt-7 sm:pb-0 ${hasSelectedMatch ? 'pb-[7rem]' : 'pb-2'}`}
            >
              <div className="flex min-h-0 flex-col">
                <div
                  className="scent-vault-results-panel mx-auto w-full max-w-[50.5rem] px-3 py-4 sm:px-9 sm:py-9"
                  // The panel's CSS sets a tall min-height (≈19rem) so the loading
                  // skeleton reads as a full surface. For *real* results that reserve
                  // is wrong: a single match left the card stranded in a large void
                  // (the gap that "grows" on wider viewports via the 30vw clamp).
                  // Hug the content instead so the panel is only ever as tall as the
                  // list it holds; many results still cap + scroll via the list's
                  // own max-height below.
                  style={{ minHeight: 0 }}
                >
                  {/* Results header: a single centered masthead line — count set
                      into the card between symmetric gold hairlines (the
                      .scent-vault-results-heading flourish). Lives outside the
                      scroll area below, so it stays put while the list scrolls.
                      Dismissal is handled by Esc, and re-focusing the field is a
                      tap on the input itself — no separate "Refine" affordance. */}
                  <div className="mb-4 flex shrink-0 items-center justify-center px-1 sm:mb-5">
                    <p className="scent-vault-results-heading min-w-0 max-w-full scent-type-label text-scent-accent">
                      <span className="whitespace-nowrap">
                        Search Results
                        <span className="mx-1.5 text-scent-accent/60" aria-hidden>·</span>
                        <span className="tabular-nums tracking-[0.12em]">
                          {filtersActive
                            ? `${visibleMatches.length} of ${matches.length}`
                            : matches.length}
                        </span>
                      </span>
                    </p>
                  </div>

                  {showFilterBar && (
                    <div className="mb-5 flex shrink-0 flex-col gap-2 px-1">
                      {availableGenders.length > 1 && (
                        <div className="flex flex-wrap items-center justify-center gap-1.5">
                          <button type="button" onClick={() => setGenderFilter(null)} className={chipClass(genderFilter === null)}>
                            All
                          </button>
                          {availableGenders.map((g) => (
                            <button
                              key={g}
                              type="button"
                              onClick={() => setGenderFilter((cur) => (cur === g ? null : g))}
                              className={chipClass(genderFilter === g)}
                            >
                              {g}
                            </button>
                          ))}
                        </div>
                      )}
                      {availableHouses.length > 1 && (
                        <div className="flex flex-wrap items-center justify-center gap-1.5">
                          <button type="button" onClick={() => setHouseFilter(null)} className={chipClass(houseFilter === null)}>
                            All houses
                          </button>
                          {availableHouses.map((h) => (
                            <button
                              key={h}
                              type="button"
                              title={h}
                              onClick={() => setHouseFilter((cur) => (cur?.toLowerCase() === h.toLowerCase() ? null : h))}
                              className={chipClass(houseFilter?.toLowerCase() === h.toLowerCase())}
                            >
                              {h}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className={`flex max-h-none min-h-0 flex-1 overflow-visible overscroll-contain sm:max-h-[min(57dvh,30rem)] sm:overflow-y-auto scrollbar-hide ${visibleMatches.length === 1 ? 'items-center' : 'items-start'}`}>
                    {visibleMatches.length === 0 ? (
                      <div className="m-auto flex flex-col items-center gap-3 py-10 text-center">
                        <p className="font-serif italic text-lg text-scent-text-muted">No results match these filters</p>
                        <button
                          type="button"
                          onClick={() => { setHouseFilter(null); setGenderFilter(null); }}
                          className="scent-type-chip text-scent-accent hover:underline focus-visible:outline-none focus-visible:underline"
                        >
                          Clear filters
                        </button>
                      </div>
                    ) : (
                      <div className="grid w-full grid-cols-1 gap-2 sm:gap-3">
                        {visibleMatches.map((match) => {
                          const key = matchKey(match);
                          const isSelected = key === selectedId;
                          const inVault = matchInVault(match);
                          // When the row-end status slot (pill/check) is present, a
                          // 320px viewport can't fit disc + house + credentials +
                          // slot: the shrink-0 credentials would squeeze the house
                          // name to nothing. The credentials yield on phones there
                          // (they return at sm:); the house name never does.
                          const hasStatusSlot = inVault || isSelected;
                          return (
                            <button
                              key={key}
                              type="button"
                              // First tap selects; a second tap on the already-selected
                              // card commits via the SAME handlePrimaryAction → handleConfirm
                              // path as the bottom action bar (so error surfacing + the
                              // Express detail-fetch fallback stay identical). This keeps the
                              // add affordance on the card itself — no travel to the distant
                              // bar — without adding pointer handlers: a native button's click
                              // never fires on scroll momentum, so it can't auto-add mid-scroll.
                              onClick={() => {
                                if (key !== selectedId) {
                                  setSelectedId(key);
                                  return;
                                }
                                if (uploading) return;
                                handlePrimaryAction();
                              }}
                              className={`scent-vault-result-card group mx-auto flex w-full max-w-[39.75rem] min-h-[64px] items-center gap-3 px-3 py-2.5 text-left transition-[border-color,box-shadow] duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 sm:min-h-[74px] sm:gap-4 sm:px-4 sm:py-3 ${
                                isSelected ? 'is-selected' : ''
                              }`}
                              aria-pressed={isSelected}
                              aria-label={
                                inVault
                                  ? `${match.name} — already in your vault, tap to view`
                                  : isSelected
                                    ? `Add ${match.name} to your vault`
                                    : `Select ${match.name}`
                              }
                            >
                              {/* House-mark disc — the row's visual anchor; left-aligned so
                                  the eye lands on a consistent column instead of three
                                  centered, ragged lines. Shows the house's real mark when
                                  resolvable, monogram otherwise. Doubles as a ≥44px target. */}
                              <HouseMarkDisc house={firstString(match.brand, match.house)} monogram={matchMonogram(match)} />
                              {/* Text column — name over a single inline credential line
                                  (house · year · gender · sentiment), so secondary facts
                                  read as one quiet strip instead of extra stacked rows.
                                  Single-line truncation keeps every row the same height. */}
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span
                                    className="min-w-0 truncate font-serif text-[1.05rem] italic leading-tight text-[#fff7ec] sm:text-[1.2rem]"
                                    title={match.name}
                                  >
                                    {match.name}
                                  </span>
                                  {isVetted(match) && (
                                    <span className="shrink-0" title="Community-vetted classic">
                                      <Award size={13} strokeWidth={2.1} className="block text-scent-accent/85" aria-hidden />
                                    </span>
                                  )}
                                </span>
                                <span className="mt-1 flex min-w-0 items-center overflow-hidden">
                                  <span
                                    className="min-w-0 truncate font-sans text-[10px] font-bold uppercase tracking-[0.18em] text-[#f3dca6] sm:text-[11px] sm:tracking-[0.2em]"
                                    title={match.brand || 'House unavailable'}
                                  >
                                    {truncateMatchLine(match.brand || 'House unavailable', MATCH_LINE_MAX_CHARS)}
                                  </span>
                                  {matchMetaItems(match).map((item) => (
                                    <span
                                      key={item.key}
                                      className={`${item.hideOnMobile || hasStatusSlot ? 'hidden sm:inline-flex' : 'inline-flex'} shrink-0 items-baseline`}
                                    >
                                      <span aria-hidden className="mx-1.5 text-scent-accent/50">·</span>
                                      <span className="whitespace-nowrap font-sans text-[9px] font-semibold uppercase tracking-[0.14em] tabular-nums text-scent-text-muted sm:text-[10px]">
                                        {item.shortLabel ? (
                                          <>
                                            <span className="sm:hidden">{item.shortLabel}</span>
                                            <span className="hidden sm:inline">{item.label}</span>
                                          </>
                                        ) : (
                                          item.label
                                        )}
                                      </span>
                                    </span>
                                  ))}
                                </span>
                              </span>
                              {/* Status slot — pinned to the row end and vertically centered,
                                  so ownership ("In vault") and selection (check) never crowd
                                  the name/house column. Selection supersedes the pill: the
                                  CTA already reads "View in vault" for owned rows. */}
                              {hasStatusSlot && (
                                <span className="ml-auto flex shrink-0 items-center self-center pl-1.5">
                                  {inVault && !isSelected && (
                                    <span className="pointer-events-none inline-flex shrink-0 items-center gap-1 rounded-full border border-scent-accent/35 bg-scent-bg/70 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-scent-accent sm:px-2.5 sm:text-[10px]">
                                      <Check size={9} strokeWidth={3} aria-hidden />
                                      In vault
                                    </span>
                                  )}
                                  {isSelected && (
                                    <m.span
                                      initial={reduceMotion ? false : { scale: 0.5, opacity: 0 }}
                                      animate={{ scale: 1, opacity: 1 }}
                                      transition={{ type: 'spring', stiffness: 520, damping: 24 }}
                                      className="scent-vault-result-check pointer-events-none flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                                      aria-hidden
                                    >
                                      <Check size={16} strokeWidth={3} />
                                    </m.span>
                                  )}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                {/* Desktop action area sits inline below the panel. On mobile the
                    panel can run past the fold, so the CTA is instead rendered as a
                    fixed bottom bar (portaled to escape the panel's overflow:hidden)
                    — see `mobileActionBar`. */}
                <div ref={actionBarRef} className="mx-auto mt-5 hidden w-full max-w-[49.75rem] shrink-0 pb-[max(0.15rem,env(safe-area-inset-bottom))] sm:mt-6 sm:block">
                  <AnimatePresence>
                    {hasSelectedMatch ? (
                      <m.p
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="text-center scent-type-label text-scent-accent"
                      >
                        {selectedInVault ? 'Already in your vault' : 'Selected — ready to add'}
                      </m.p>
                    ) : null}
                  </AnimatePresence>
                  <button
                    type="button"
                    onClick={handlePrimaryAction}
                    disabled={uploading || !hasSelectedMatch}
                    className="scent-vault-outline-button mt-3 flex h-[60px] w-full items-center justify-center px-4 font-serif italic text-base transition-[color,background-color,border-color,box-shadow,opacity,transform] hover:scale-[1.01] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 sm:mt-5 sm:h-[74px] sm:text-lg disabled:pointer-events-none disabled:opacity-62"
                  >
                    <span className="scent-vault-outline-button-label font-serif italic text-[1.35rem] leading-tight text-center sm:text-[1.8rem]">
                      {selectedInVault ? 'View in vault' : hasSelectedMatch ? 'Add to Vault' : 'Select a Result'}
                    </span>
                  </button>
                </div>
              </div>
            </m.div>
          )}
        </AnimatePresence>
      </div>
      {/* Skeleton result list in the flow space below the form. It doubles as
          the height reserve that keeps the inset-0 search veil from being
          clipped by overflow:hidden (min-height matches the loader), and gives
          the list area a card-shaped loading state so results cross-fade into
          place instead of snapping in when the veil clears. Height is reserved
          instantly (no tween) so the centered loader doesn't drift as the box
          grows; on exit it collapses under the veil's fade so nothing clips. */}
      <AnimatePresence>
        {loadingSurface === 'search' && uploading && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            // Calm devices can't animate the height release (layout tweens are
            // the documented jank source there), but the old lingering opacity
            // exit held this block's reserved height for ~320ms after results
            // mounted and then dropped it in a second, separate snap. Releasing
            // it instantly instead means the panel's height changes exactly
            // once — in the same frame the results mount — under their fade.
            exit={
              reducedAddMotion
                ? { opacity: 0, transition: { duration: 0.01 } }
                : { opacity: 0, height: 0 }
            }
            transition={{ duration: 0.32, ease: SCENT_EASE_OUT }}
            aria-hidden
            style={{ pointerEvents: 'none', minHeight: SEARCH_LOADER_MIN_H }}
            className="mx-auto mt-6 w-full overflow-hidden sm:mt-7"
          >
            {!embeddedInVaultPanel ? (
              <div className="scent-vault-results-panel mx-auto w-full max-w-[50.5rem] px-4 py-7 sm:px-9 sm:py-9">
                {/* Mirrors the real results anatomy — centered masthead line,
                    then disc-anchored rows — so the cross-fade into results
                    swaps content in place instead of re-arranging the layout. */}
                <div className="mb-4 flex items-center justify-center px-1">
                  <span className="h-3.5 w-40 animate-pulse rounded-full bg-white/10" />
                </div>
                <div className="grid w-full grid-cols-1 gap-3">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="scent-vault-result-card mx-auto flex w-full max-w-[39.75rem] min-h-[64px] animate-pulse items-center gap-3 px-3 py-2.5 sm:min-h-[74px] sm:gap-4 sm:px-4 sm:py-3"
                      style={{ animationDelay: `${i * 120}ms` }}
                    >
                      <span className="h-11 w-11 shrink-0 rounded-full bg-white/10 sm:h-12 sm:w-12" />
                      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="block h-4 w-44 max-w-[70%] rounded-full bg-white/10" />
                        <span className="block h-2.5 w-28 max-w-[50%] rounded-full bg-white/5" />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </m.div>
        )}
      </AnimatePresence>
      {typeof document !== 'undefined'
        ? createPortal(
            <>
              <AnimatePresence>{syncVeil}</AnimatePresence>
              <AnimatePresence>{mobileActionBar}</AnimatePresence>
            </>,
            document.body,
          )
        : null}
    </div>
  );
};
