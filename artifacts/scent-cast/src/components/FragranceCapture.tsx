import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ScentIntelligenceLoader } from './ScentIntelligenceLoader';
import {
  collectMainAccordDisplayRows,
  getFragranceDetails,
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
}> = ({ onAdd, onVaultSearchStateChange }) => {
  const [uploading, setUploading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [matches, setMatches] = useState<FragranceMatch[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
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

  useEffect(() => {
    return () => {
      searchAbortController.current?.abort();
      syncAbortController.current?.abort();
    };
  }, []);

  const vaultSearchActive = searchFocused || searchQuery.trim().length > 0;
  const hasSelectedMatch = selectedIdx !== null;
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
      setSelectedIdx(nextMatches.length > 0 ? 0 : null);

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
    if (selectedIdx === null || !matches[selectedIdx] || !onAdd) return;
    
    const selected = matches[selectedIdx];
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

    const selectedId = firstString(selected.id);
    const selectedSourceUrl = firstString(selected.source_url);
    if (!selectedId && !selectedSourceUrl) {
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
      const syntheticSourceUrl = selectedId?.startsWith('source:')
        ? firstString(selectedId.slice('source:'.length))
        : undefined;
      const detailSourceUrl = firstString(selectedSourceUrl, syntheticSourceUrl);
      const selectedOrigin = syntheticSourceUrl
        ? 'app'
        : selected.origin ??
          (
            selectedId?.startsWith('catalog:') ||
            selectedId?.startsWith('dataset:') ||
            selectedId?.startsWith('local:')
              ? 'app'
              : 'srt'
          );
      const detailsRequest: FragranceDetailRequestPayload =
        selectedOrigin === 'app' && detailSourceUrl
          ? { source_url: detailSourceUrl, origin: 'app' }
          : selectedOrigin === 'app' && selectedId
            ? { id: selectedId, origin: 'app' }
            : selectedId
          ? {
              id: selectedId,
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

      const detail = normalizeFragranceDetail(
        (await getFragranceDetails(detailsRequest, { signal: controller.signal })) as FragranceDetail,
      );
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
      await sleep(620);
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
    const shouldRetrySync = errorPhase === 'sync' && selectedIdx !== null && matches[selectedIdx];
    setErrorPhase(null);
    if (shouldRetrySync) {
      void handleConfirm();
      return;
    }
    void handleSearch();
  };

  const resetState = () => {
    setMatches([]);
    setSelectedIdx(null);
    setHasSearched(false);
    setSearchQuery("");
    setErrorPhase(null);
    setSyncComplete(false);
  };

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
            <p className="text-[11px] font-bold uppercase tracking-[0.34em] text-scent-accent/90">
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
                <p className="text-[10px] text-red-500/90 font-medium leading-relaxed max-w-md">{errorStatus}</p>
              </div>
              <button onClick={handleRetry} className="text-[9px] uppercase tracking-widest text-red-500 font-bold hover:underline">
                Try Again
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mx-auto max-w-[42.75rem] text-center">
          <form onSubmit={handleSearch} aria-busy={uploading} className="relative group">
            <input
              id="scent-add-to-vault-search"
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setErrorStatus(null); setErrorPhase(null); }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search by house or fragrance..."
              aria-label="Look up a brand or fragrance"
              className="scent-lux-input scent-vault-search-input relative z-0 w-full h-[60px] pl-7 pr-16 text-left text-[#fff7ec] font-sans text-[15px] font-medium outline-none transition-colors placeholder:text-[#c9a97a]/48 placeholder:font-medium sm:h-[68px] sm:pl-8 sm:pr-[4.35rem] scroll-mt-28"
            />
            <motion.button
              type="submit"
              disabled={uploading}
              whileHover={uploading ? undefined : { scale: 1.06 }}
              whileTap={uploading ? undefined : { scale: 0.9 }}
              transition={{ type: "spring", stiffness: 520, damping: 22 }}
              className="absolute right-3.5 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-scent-accent/86 shadow-none outline-none transition-colors hover:text-[#fff7ec] focus-visible:ring-2 focus-visible:ring-scent-accent/35 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-45 group-focus-within:text-scent-accent"
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
              <p className="font-serif italic text-lg text-white/40 mb-2">No Olfactory Matches Found</p>
              <p className="text-[10px] uppercase tracking-widest text-scent-muted max-w-[200px] leading-relaxed">
                Try a different fragrance name or brand.
              </p>
            </motion.div>
          )}

          {matches.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto mt-6 w-full sm:mt-7"
            >
              <div className="flex min-h-0 flex-col">
                <div className="scent-vault-results-panel mx-auto w-full max-w-[50.5rem] px-4 py-7 sm:px-9 sm:py-9">
                  <div className="mb-6 flex shrink-0 justify-center px-1">
                    <p className="scent-vault-results-heading text-[10px] font-bold uppercase tracking-[0.34em] text-scent-accent/92">
                      Search Results{' '}
                      <span className="tabular-nums tracking-[0.12em]">
                        ({matches.length})
                      </span>
                    </p>
                  </div>
                  <div className={`flex max-h-[min(42dvh,24rem)] min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-hide ${matches.length === 1 ? 'items-center' : 'items-start'}`}>
                    <div className="grid w-full grid-cols-1 gap-3">
                      {matches.map((m, i) => (
                        <button
                          key={m.id || m.source_url || `match-${i}`}
                          type="button"
                          onClick={() => setSelectedIdx(i)}
                          className={`scent-vault-result-card group mx-auto w-full max-w-[39.75rem] min-h-[178px] px-6 py-7 text-center transition-all duration-200 cursor-pointer sm:min-h-[218px] sm:px-8 sm:py-8 ${
                            selectedIdx === i ? 'is-selected' : ''
                          }`}
                          aria-pressed={selectedIdx === i}
                        >
                          <span className="scent-vault-monogram mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full font-serif text-[1.55rem] font-semibold leading-none sm:mb-5 sm:h-[4.5rem] sm:w-[4.5rem] sm:text-[1.9rem]">
                            {matchMonogram(m)}
                          </span>
                          <span
                            className="mx-auto block max-w-full truncate font-serif text-[2rem] italic leading-none text-[#fff7ec] sm:text-[2.55rem]"
                            title={m.name}
                          >
                            {truncateMatchLine(m.name.toLocaleLowerCase(), MATCH_LINE_MAX_CHARS)}
                          </span>
                          <span
                            className="mx-auto mt-4 block max-w-full truncate font-sans text-[11px] font-bold uppercase tracking-[0.3em] text-scent-accent/92 sm:text-[12px]"
                            title={m.brand || 'House unavailable'}
                          >
                            {truncateMatchLine(m.brand || 'House unavailable', MATCH_LINE_MAX_CHARS)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mx-auto mt-5 w-full max-w-[49.75rem] shrink-0 pb-[max(0.15rem,env(safe-area-inset-bottom))] sm:mt-6">
                  <AnimatePresence>
                    {selectedIdx !== null ? (
                      <motion.p
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="text-center text-[11px] uppercase tracking-[0.28em] text-scent-accent/82 font-bold"
                      >
                        Selected — ready to add
                      </motion.p>
                    ) : null}
                  </AnimatePresence>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={uploading || !hasSelectedMatch}
                    className="scent-vault-outline-button mt-3 flex h-[60px] w-full items-center justify-center px-4 font-serif italic text-base transition-all hover:scale-[1.01] active:scale-[0.98] sm:mt-5 sm:h-[74px] sm:text-lg disabled:pointer-events-none disabled:opacity-62"
                  >
                    <span className="scent-vault-outline-button-label font-serif italic text-[1.35rem] leading-tight text-center sm:text-[1.8rem]">
                      {hasSelectedMatch ? 'Add to Vault' : 'Select a Result'}
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
            <AnimatePresence>{syncVeil}</AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  );
};
