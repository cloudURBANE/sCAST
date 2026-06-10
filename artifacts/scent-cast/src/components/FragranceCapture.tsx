import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ScentIntelligenceLoader } from './ScentIntelligenceLoader';
import {
  collectMainAccordDisplayRows,
  getFragranceDetails,
  isBackgroundEnrichmentQueued,
  isFetchNetworkError,
  normalizeFragranceDetail,
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

/** Rotating vault headline — example house + scent pairs. */
const VAULT_HEADLINE_ROTATION = [
  'Chanel Coco Mademoiselle',
  'Tom Ford Oud Wood',
  'Maison Francis Kurkdjian Baccarat Rouge 540',
  'Le Labo Santal 33',
  'Dior Sauvage',
  'Yves Saint Laurent Libre',
  'Creed Aventus',
] as const;

/** ~one line in the headline slot at max-w-lg; longer phrases truncate */
const HEADLINE_BASE_MAX_CHARS = 34;

function vaultHeadlineBase(full: string): string {
  const t = full.trim();
  if (t.length <= HEADLINE_BASE_MAX_CHARS) return t;
  return t.slice(0, HEADLINE_BASE_MAX_CHARS).trimEnd();
}

function VaultHeadlineRotation({ phrases }: { phrases: readonly string[] }) {
  const reduceMotion = useReducedMotion();
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * phrases.length));

  useEffect(() => {
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % phrases.length);
    }, 5200);
    return () => window.clearInterval(id);
  }, [phrases.length]);

  const display = vaultHeadlineBase(phrases[idx]);

  if (reduceMotion) {
    return (
      <h2
        className="flex h-[3rem] items-center justify-center font-serif italic text-[clamp(1.25rem,4vw,1.75rem)] leading-none tracking-[0.0187em] text-[#fff7ec] drop-shadow-[0_0_22px_rgba(212,175,55,0.14)]"
        aria-hidden
      >
        <span className="max-w-full truncate bg-gradient-to-br from-[#fffbf5] via-[#fff7ec] to-[#e6d2b8]/88 bg-clip-text text-center text-transparent px-1">
          {display}
        </span>
      </h2>
    );
  }

  return (
    <h2
      className="flex h-[3rem] items-center justify-center font-serif italic text-[clamp(1.25rem,4vw,1.75rem)] leading-none tracking-[0.0187em] text-[#fff7ec] drop-shadow-[0_0_22px_rgba(212,175,55,0.14)]"
      aria-hidden
    >
      <span className="relative flex min-h-[1.15em] w-full min-w-0 max-w-full items-center justify-center px-1">
        <AnimatePresence mode="wait">
          <motion.span
            key={idx}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-full truncate bg-gradient-to-br from-[#fffbf5] via-[#fff7ec] to-[#e6d2b8]/88 bg-clip-text text-center text-transparent"
          >
            {display}
          </motion.span>
        </AnimatePresence>
      </span>
    </h2>
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
  /** Scroll the user to their vault — used by the "View in vault" action on duplicates. */
  onViewVault?: () => void;
}> = ({ onAdd, onVaultSearchStateChange, existingVaultKeys, onViewVault }) => {
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

  const searchAbortController = useRef<AbortController | null>(null);
  const syncAbortController = useRef<AbortController | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const actionBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      searchAbortController.current?.abort();
      syncAbortController.current?.abort();
    };
  }, []);

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
    if (selectedInVault) {
      onViewVault?.();
      return;
    }
    void handleConfirm();
  };

  // When a filter hides the selected row, fall back to the first still-visible
  // result so the "ready to add" CTA never points at something off-screen.
  useEffect(() => {
    if (visibleMatches.length === 0) return;
    if (selectedId && visibleMatches.some((m) => matchKey(m) === selectedId)) return;
    setSelectedId(matchKey(visibleMatches[0]));
  }, [visibleMatches, selectedId]);
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
    
    const targetQuery = overrideQuery !== undefined ? overrideQuery : searchQuery;
    if (!targetQuery.trim()) return;

    // Abort any in-flight searches to prevent race conditions
    if (searchAbortController.current) {
      searchAbortController.current.abort();
    }
    const controller = new AbortController();
    searchAbortController.current = controller;

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

      try {
        const searchData = await searchFragrances(targetQuery, { signal: controller.signal });
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
        } else {
          setLoadingStatus('No fragrance match found.');
        }
      }
      // On success leave loadingStatus as "Researching Fragrance..."; the overlay
      // exits via finally → setUploading(false) and the results list animates in.
      setMatches(nextMatches);
      setSelectedId(nextMatches.length > 0 ? matchKey(nextMatches[0]) : null);

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
        await sleep(420);
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

      let detail = normalizeFragranceDetail(
        (await getFragranceDetails(detailsRequest, { signal: controller.signal })) as FragranceDetail,
      );

      // A brand-new fragrance can come back as a provisional detail with no
      // notes while the backend scrapes the olfactory pyramid in the background
      // (enrichment.status === "pending"|"processing"). Give it a brief,
      // non-blocking grace — a couple of quick re-checks rather than the old
      // ~30s poll that read as a frozen screen — so a fast scrape upgrades the
      // vector. If notes still haven't landed we proceed immediately; the
      // local-profile fallback below keeps the add from failing either way.
      const POLL_INTERVAL_MS = 1000;
      const MAX_POLL_ATTEMPTS = 2; // ~2s ceiling, down from ~30s
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
        detail = normalizeFragranceDetail(
          (await getFragranceDetails(detailsRequest, { signal: controller.signal })) as FragranceDetail,
        );
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
      // Hold just long enough for the loader's ~0.5s "complete" flourish to read,
      // then return to the vault — trimmed from 620ms so the add feels snappier.
      await sleep(500);
      resetState();
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setErrorStatus(
        isFetchNetworkError(err)
          ? 'Fragrance sync is temporarily unavailable. Check your connection and try again.'
          : err?.message || "Fragrance detail fetch failed. Please check your connection.",
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

  const resetState = () => {
    setMatches([]);
    setSelectedId(null);
    setHouseFilter(null);
    setGenderFilter(null);
    setHasSearched(false);
    setSearchQuery("");
    setErrorPhase(null);
    setSyncComplete(false);
  };

  // "Back to search" — return focus to the field without discarding results or
  // the current query, so users can refine and re-run without scrolling up.
  const scrollToSearch = () => {
    searchInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    searchInputRef.current?.focus({ preventScroll: true });
  };

  // "New search" — clear the result surface but keep the user on the search
  // field so they can immediately type again (resetState empties the query too).
  const handleNewSearch = () => {
    resetState();
    setErrorStatus(null);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: false });
      searchInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  // Bring freshly-arrived results into view so the list isn't stranded below the
  // fold on tall mobile layouts. Runs once per result set, after the overlay clears.
  useEffect(() => {
    if (matches.length === 0 || uploading) return;
    const id = window.requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [matches.length, uploading]);

  const chipClass = (active: boolean): string =>
    `inline-flex max-w-[11rem] items-center truncate rounded-full border px-3 py-1.5 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 ${
      active
        ? 'border-scent-accent/80 bg-scent-accent/15 text-[#fff7ec]'
        : 'border-white/12 text-scent-text-muted hover:border-scent-accent/45 hover:text-[#fff7ec]'
    }`;

  const filtersActive = houseFilter !== null || genderFilter !== null;
  const showFilterBar = availableHouses.length > 1 || availableGenders.length > 1;

  /* Sync overlay — full-screen portal, separate from the search overlay. */
  const syncVeil = uploading && loadingSurface === 'sync' ? (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-0 z-[130] flex flex-col items-center justify-center px-6 py-[max(2rem,env(safe-area-inset-top))]"
      style={{
        background:
          'radial-gradient(ellipse 58% 46% at 50% 36%, rgba(212,175,55,0.08), transparent 64%), radial-gradient(ellipse 88% 62% at 50% 108%, rgba(212,175,55,0.05), transparent 68%), rgba(3,2,1,0.92)',
        boxShadow:
          'inset 0 1px 0 rgba(255,230,180,0.06), inset 0 0 120px rgba(212,175,55,0.045)',
      }}
    >
      <ScentIntelligenceLoader
        status={loadingStatus}
        substatus="Processing Olfactory Data"
        complete={syncComplete}
      />
    </motion.div>
  ) : null;

  /* Search overlay — lives *inside* the card, positioned absolute but with
     a min-height that forces the card to expand so the orbital animation
     never clips. The card's `.glass-shell` has overflow:hidden, so if the
     overlay is shorter than the loader, the top/bottom of the orbits gets
     cut off. By setting min-height on both the overlay *and* a spacer in
     the card flow, the card grows to accommodate the full animation. */
  const SEARCH_LOADER_MIN_H = 320; // px – enough for 132px orb zone + margins + text
  const searchVeil = uploading && loadingSurface === 'search' ? (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center p-8"
      style={{
        minHeight: SEARCH_LOADER_MIN_H,
        // No backdrop-filter: animating a blur layer in over the card is the
        // documented iOS Safari / iPad-PWA GPU-crash construct. The veil is
        // instead raised to ~0.9 opacity so the card reads as faintly-present
        // depth rather than a live frosted surface.
        background:
          'radial-gradient(ellipse 70% 60% at 50% 16%, rgba(212,175,55,0.06), transparent 60%), radial-gradient(ellipse 85% 55% at 50% 102%, rgba(212,175,55,0.05), transparent 64%), rgba(3,2,1,0.9)',
        boxShadow:
          'inset 0 1px 0 rgba(255,230,180,0.08), inset 0 0 90px rgba(212,175,55,0.05)',
      }}
    >
      <ScentIntelligenceLoader
        status={loadingStatus}
        substatus="Processing Olfactory Data"
        complete={syncComplete}
      />
    </motion.div>
  ) : null;

  /* Mobile action bar — a fixed, viewport-pinned CTA so "Add to Vault" is always
     reachable while browsing a long result list. Portaled to <body> because the
     panel root is overflow:hidden, which traps a CSS `position: sticky` bar. The
     desktop CTA stays inline (`sm:block`); this is `sm:hidden`. */
  const mobileActionBar = matches.length > 0 && !uploading ? (
    <motion.div
      key="mobile-action-bar"
      initial={reduceMotion ? false : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 bottom-0 z-[120] bg-gradient-to-t from-scent-bg via-scent-bg/95 to-transparent px-4 pb-[max(0.7rem,env(safe-area-inset-bottom))] pt-8 sm:hidden"
    >
      <div className="mx-auto w-full max-w-[39.75rem]">
        <div className="mb-2 flex justify-center">
          <button
            type="button"
            onClick={scrollToSearch}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/14 bg-scent-bg/70 px-3.5 py-1.5 scent-type-chip text-scent-accent transition-colors hover:border-scent-accent/55 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
          >
            <Search size={12} strokeWidth={2.2} aria-hidden />
            Back to search
          </button>
        </div>
        <button
          type="button"
          onClick={handlePrimaryAction}
          disabled={!hasSelectedMatch}
          className="scent-vault-outline-button flex h-[58px] w-full cursor-pointer items-center justify-center px-4 transition-transform hover:scale-[1.01] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-62"
        >
          <span className="scent-vault-outline-button-label font-serif italic text-[1.3rem] leading-tight text-center">
            {selectedInVault ? 'View in vault' : hasSelectedMatch ? 'Add to Vault' : 'Select a Result'}
          </span>
        </button>
      </div>
    </motion.div>
  ) : null;

  return (
    <div className="scent-vault-panel w-full min-w-0 relative overflow-hidden">
      <AnimatePresence>
        {searchVeil}
      </AnimatePresence>
      <div className="scent-vault-panel-inner min-w-0">
        <header className="mx-auto mb-6 max-w-[43rem] px-1 text-center sm:mb-7">
          <p className="sr-only">
            Add perfumes to your vault. Example fragrance names rotate above the search field.
          </p>
          <h2 className="mx-auto max-w-[38rem] text-balance font-serif italic text-[clamp(2.45rem,6vw,4.15rem)] leading-[1.01] tracking-normal text-[#fff7ec] drop-shadow-[0_4px_14px_rgba(0,0,0,0.72)]">
            Find your signature for the current atmosphere.
          </h2>
          <div className="mt-5 space-y-2.5 sm:mt-6">
            <p className="scent-type-label text-scent-accent">
              Recently Added Fragrances
            </p>
            <div className="mx-auto w-full max-w-lg px-1">
              <VaultHeadlineRotation phrases={VAULT_HEADLINE_ROTATION} />
            </div>
          </div>
        </header>

        <AnimatePresence>
          {errorStatus && (
            <motion.div
              initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-scent text-center"
            >
              <div className="flex flex-col items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                <p className="max-w-md text-sm font-medium leading-relaxed text-red-200">{errorStatus}</p>
              </div>
              <button onClick={handleRetry} className="scent-type-chip text-red-200 hover:underline">
                Try Again
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mx-auto max-w-[42.75rem] text-center">
          <form onSubmit={handleSearch} aria-busy={uploading} className="relative group">
            <input
              ref={searchInputRef}
              id="scent-add-to-vault-search"
              type="search"
              enterKeyHint="search"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setErrorStatus(null); setErrorPhase(null); }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search by house or fragrance..."
              aria-label="Look up a brand or fragrance"
              className="scent-lux-input scent-vault-search-input relative z-0 w-full h-[60px] pl-7 pr-16 text-left text-[#fff7ec] font-sans text-base font-medium outline-none transition-colors placeholder:text-scent-text-subtle placeholder:font-medium sm:h-[68px] sm:pl-8 sm:pr-[4.35rem] scroll-mt-28"
            />
            <motion.button
              type="submit"
              disabled={uploading}
              whileHover={uploading ? undefined : { scale: 1.06 }}
              whileTap={uploading ? undefined : { scale: 0.9 }}
              transition={{ type: "spring", stiffness: 520, damping: 22 }}
              className="absolute right-3.5 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-scent-accent shadow-none outline-none transition-colors hover:text-[#fff7ec] focus-visible:ring-2 focus-visible:ring-scent-accent/35 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-45 group-focus-within:text-scent-accent"
              aria-label="Search"
            >
              <motion.span
                className="relative inline-flex"
                aria-hidden
                animate={reduceMotion || uploading ? undefined : { opacity: [0.74, 1, 0.74] }}
                transition={reduceMotion || uploading ? undefined : { duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
              >
                <Search size={23} strokeWidth={1.6} className="drop-shadow-[0_0_12px_rgba(212,175,55,0.22)]" />
              </motion.span>
            </motion.button>
          </form>
        </div>

        <AnimatePresence>
          {hasSearched && matches.length === 0 && !uploading && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="mt-10 py-10 border-t border-white/10 flex flex-col items-center text-center"
            >
              <p className="mb-2 font-serif text-lg italic text-scent-text-muted">No Olfactory Matches Found</p>
              <p className="max-w-[200px] scent-type-label leading-relaxed">
                Try a different fragrance name or brand.
              </p>
            </motion.div>
          )}

          {matches.length > 0 && (
            <motion.div
              ref={resultsRef}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto mt-6 w-full scroll-mt-24 pb-24 sm:mt-7 sm:pb-0"
            >
              <div className="flex min-h-0 flex-col">
                <div className="scent-vault-results-panel mx-auto w-full max-w-[50.5rem] px-4 py-7 sm:px-9 sm:py-9">
                  {/* Results-nav header: count on the left, "New search" on the
                      right. Lives outside the scroll area below, so it stays put
                      while the list scrolls. */}
                  <div className="mb-4 flex shrink-0 items-center justify-between gap-3 px-1">
                    <p className="scent-type-label text-scent-accent">
                      Search Results{' '}
                      <span className="tabular-nums tracking-[0.12em] text-scent-accent">
                        {filtersActive
                          ? `${visibleMatches.length} of ${matches.length}`
                          : matches.length}
                      </span>
                    </p>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={scrollToSearch}
                        className="hidden shrink-0 items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 sm:inline-flex"
                      >
                        ↑ Back to top
                      </button>
                      <button
                        type="button"
                        onClick={handleNewSearch}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
                      >
                        <Search size={12} strokeWidth={2} aria-hidden />
                        New search
                      </button>
                    </div>
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

                  <div className={`flex max-h-[min(42dvh,24rem)] min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-hide ${visibleMatches.length === 1 ? 'items-center' : 'items-start'}`}>
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
                      <div className="grid w-full grid-cols-1 gap-3">
                        {visibleMatches.map((m) => {
                          const key = matchKey(m);
                          const isSelected = key === selectedId;
                          const inVault = matchInVault(m);
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => setSelectedId(key)}
                              className={`scent-vault-result-card group mx-auto w-full max-w-[39.75rem] min-h-[178px] px-6 py-7 text-center transition-all duration-200 cursor-pointer sm:min-h-[218px] sm:px-8 sm:py-8 ${
                                isSelected ? 'is-selected' : ''
                              }`}
                              aria-pressed={isSelected}
                            >
                              {inVault && (
                                <span className="pointer-events-none absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-scent-accent/35 bg-scent-bg/80 px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.16em] text-scent-accent sm:left-4 sm:top-4">
                                  <Check size={11} strokeWidth={3} aria-hidden />
                                  In vault
                                </span>
                              )}
                              {isSelected && (
                                <motion.span
                                  initial={reduceMotion ? false : { scale: 0.5, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1 }}
                                  transition={{ type: 'spring', stiffness: 520, damping: 24 }}
                                  className="scent-vault-result-check pointer-events-none absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full sm:right-4 sm:top-4 sm:h-8 sm:w-8"
                                  aria-hidden
                                >
                                  <Check size={16} strokeWidth={3} />
                                </motion.span>
                              )}
                              <span className="scent-vault-monogram mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full font-serif text-[1.55rem] font-semibold leading-none sm:mb-5 sm:h-[4.5rem] sm:w-[4.5rem] sm:text-[1.9rem]">
                                {matchMonogram(m)}
                              </span>
                              <span
                                className="mx-auto block max-w-full truncate font-serif text-[2rem] italic leading-none text-[#fff7ec] sm:text-[2.55rem]"
                                title={m.name}
                              >
                                {truncateMatchLine(m.name, MATCH_LINE_MAX_CHARS)}
                              </span>
                              <span
                                className="mx-auto mt-4 block max-w-full truncate font-sans text-[12.5px] font-bold uppercase tracking-[0.28em] text-[#f3dca6] sm:text-[13.5px]"
                                title={m.brand || 'House unavailable'}
                              >
                                {truncateMatchLine(m.brand || 'House unavailable', MATCH_LINE_MAX_CHARS)}
                              </span>
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
                <div className="mx-auto mt-5 hidden w-full max-w-[49.75rem] shrink-0 pb-[max(0.15rem,env(safe-area-inset-bottom))] sm:mt-6 sm:block">
                  <AnimatePresence>
                    {hasSelectedMatch ? (
                      <motion.p
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="text-center scent-type-label text-scent-accent"
                      >
                        {selectedInVault ? 'Already in your vault' : 'Selected — ready to add'}
                      </motion.p>
                    ) : null}
                  </AnimatePresence>
                  <button
                    type="button"
                    onClick={handlePrimaryAction}
                    disabled={uploading || !hasSelectedMatch}
                    className="scent-vault-outline-button mt-3 flex h-[60px] w-full items-center justify-center px-4 font-serif italic text-base transition-all hover:scale-[1.01] active:scale-[0.98] sm:mt-5 sm:h-[74px] sm:text-lg disabled:pointer-events-none disabled:opacity-62"
                  >
                    <span className="scent-vault-outline-button-label font-serif italic text-[1.35rem] leading-tight text-center sm:text-[1.8rem]">
                      {selectedInVault ? 'View in vault' : hasSelectedMatch ? 'Add to Vault' : 'Select a Result'}
                    </span>
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* Flow spacer that reserves the loader's height at the *bottom* of the
          card so the inset-0 search veil isn't clipped by overflow:hidden.
          Reserved instantly (initial === animate) rather than tweened from 0:
          animating height reflowed the document every frame and made the
          centered loader visibly drift downward as the box grew. Sitting after
          the content, the reserve grows into empty space instead of shoving the
          form down (no flash behind the fading-in veil). On exit it collapses
          under the veil's fade so nothing clips. */}
      <AnimatePresence>
        {loadingSurface === 'search' && uploading && (
          <motion.div
            initial={{ height: SEARCH_LOADER_MIN_H }}
            animate={{ height: SEARCH_LOADER_MIN_H }}
            exit={{ height: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            aria-hidden
            style={{ pointerEvents: 'none' }}
          />
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
