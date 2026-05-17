import React, { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  collectMainAccordDisplayRows,
  getFragranceDetails,
  isBackgroundEnrichmentQueued,
  isFragranceDetailEffectivelyComplete,
  isTerminalEnrichmentStatus,
  normalizeFragranceDetail,
  searchFragrances,
  type EnrichmentStatus,
  type FragranceDetail,
  type FragranceDetailRequestPayload,
  type FragranceSearchResult,
} from '@/lib/fragranceApi';

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

const DETAIL_POLL_INTERVAL_MS = 10_000;
const DETAIL_POLL_MAX_ATTEMPTS = 15;
const DETAIL_POLL_MAX_DURATION_MS = 5 * 60 * 1000;
const DETAIL_POLL_BACKOFF_MULTIPLIER = 1.18;
const DETAIL_POLL_MAX_INTERVAL_MS = 30_000;
const PARTIAL_ENRICHMENT_NOTICE = "More Fragrantica details are still being enriched.";

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function isCoverageComplete(detail: FragranceDetail | null | undefined): boolean {
  return isFragranceDetailEffectivelyComplete(detail);
}

function shouldContinueWithPartialDetail(detail: FragranceDetail | null | undefined): boolean {
  return !isCoverageComplete(detail) && isBackgroundEnrichmentQueued(detail?.enrichment);
}

function shouldUsePartialDetailImmediately(detail: FragranceDetail | null | undefined): boolean {
  const coverage = detail?.source_coverage;
  if (!coverage || coverage.complete !== false) return false;
  return coverage.fragrantica_linked === true && coverage.fragrantica !== true;
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitUntilVisible(signal: AbortSignal): Promise<number> {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return 0;
  if (signal.aborted) throw createAbortError();

  const hiddenAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      signal.removeEventListener('abort', onAbort);
    };

    document.addEventListener('visibilitychange', onVisibility);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  return Date.now() - hiddenAt;
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
        className="flex h-[3rem] items-center justify-center font-serif italic text-[clamp(1.25rem,4vw,1.75rem)] leading-none tracking-[0.0187em] text-[#fff7ec] drop-shadow-[0_0_22px_rgba(201,139,44,0.14)]"
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
      className="flex h-[3rem] items-center justify-center font-serif italic text-[clamp(1.25rem,4vw,1.75rem)] leading-none tracking-[0.0187em] text-[#fff7ec] drop-shadow-[0_0_22px_rgba(201,139,44,0.14)]"
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

function ScentSearchGlyph({
  active,
  reduceMotion,
  size = 'button',
}: {
  active: boolean;
  reduceMotion: boolean | null | undefined;
  size?: 'button' | 'overlay';
}) {
  const isButton = size === 'button';
  const iconSize = isButton ? 17 : 30;
  const footprint = isButton ? 'h-[1.2rem] w-[1.2rem]' : 'h-[5.25rem] w-[5.25rem]';
  const plumeOffsets = isButton ? [-0.34, 0, 0.34] : [-0.62, 0, 0.62];
  const plumeHeights = isButton ? ['0.52rem', '0.78rem', '0.6rem'] : ['1.18rem', '1.74rem', '1.34rem'];

  return (
    <span className={`relative inline-flex items-center justify-center ${footprint}`} aria-hidden>
      <motion.span
        className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_44%,rgba(239,184,99,0.28),rgba(239,184,99,0.06)_48%,transparent_76%)]"
        animate={
          reduceMotion
            ? undefined
            : active
              ? { scale: [0.96, 1.08, 0.96], opacity: [0.52, 0.95, 0.52] }
              : { opacity: [0.38, 0.72, 0.38] }
        }
        transition={
          reduceMotion
            ? undefined
            : active
              ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }
        }
      />
      <motion.span
        className="absolute inset-[10%] rounded-full border border-scent-accent/18"
        animate={
          reduceMotion
            ? undefined
            : active
              ? { scale: [0.92, 1.05, 0.92], opacity: [0.24, 0.62, 0.24] }
              : { scale: [0.98, 1.02, 0.98], opacity: [0.2, 0.38, 0.2] }
        }
        transition={
          reduceMotion
            ? undefined
            : active
              ? { duration: 1.85, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 3.6, repeat: Infinity, ease: 'easeInOut' }
        }
      />
      <motion.span
        className="absolute inset-[24%] rounded-full border border-white/8"
        animate={
          reduceMotion || !active
            ? undefined
            : { rotate: [0, 24, 0], opacity: [0.26, 0.46, 0.26] }
        }
        transition={
          reduceMotion || !active
            ? undefined
            : { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
        }
      />
      {plumeOffsets.map((offset, index) => (
        <motion.span
          key={`${size}-plume-${offset}`}
          className="absolute bottom-[56%] rounded-full bg-gradient-to-t from-scent-accent/0 via-[#f1c981]/88 to-white/92 blur-[0.6px]"
          style={{
            left: `calc(50% + ${offset}rem)`,
            height: plumeHeights[index],
            width: isButton ? '0.17rem' : '0.29rem',
            marginLeft: isButton ? '-0.085rem' : '-0.145rem',
          }}
          animate={
            reduceMotion
              ? undefined
              : active
                ? {
                    y: [0, -(isButton ? 4 + index : 8 + index * 2), 0],
                    opacity: [0.24, 0.96, 0.18],
                    scaleY: [0.78, 1.15, 0.84],
                  }
                : {
                    y: [0, -(isButton ? 2 : 4), 0],
                    opacity: [0.18, 0.5, 0.18],
                    scaleY: [0.9, 1.04, 0.9],
                  }
          }
          transition={
            reduceMotion
              ? undefined
              : active
                ? {
                    duration: isButton ? 1.16 : 1.34,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: index * 0.12,
                  }
                : {
                    duration: isButton ? 2.8 : 3.2,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: index * 0.16,
                  }
          }
        />
      ))}
      <motion.span
        className="absolute inset-[20%] rounded-full bg-[radial-gradient(circle_at_38%_34%,rgba(255,247,236,0.16),rgba(255,247,236,0)_58%)]"
        animate={
          reduceMotion || !active
            ? undefined
            : { opacity: [0.4, 0.8, 0.4] }
        }
        transition={
          reduceMotion || !active
            ? undefined
            : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
        }
      />
      <motion.span
        className="relative z-10 inline-flex"
        animate={
          reduceMotion
            ? undefined
            : active
              ? { opacity: [0.82, 1, 0.82], scale: [0.98, 1.03, 0.98] }
              : { opacity: [0.72, 1, 0.72] }
        }
        transition={
          reduceMotion
            ? undefined
            : active
              ? { duration: 1.45, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 3.4, repeat: Infinity, ease: 'easeInOut' }
        }
      >
        <Search
          size={iconSize}
          strokeWidth={isButton ? 1.75 : 1.6}
          className="text-[#fff7ec] drop-shadow-[0_0_14px_rgba(201,139,44,0.24)]"
        />
      </motion.span>
    </span>
  );
}

interface FragranceMatch extends FragranceSearchResult {
  name: string;
  brand: string;
  house: string;
  scent_vector?: unknown;
  family?: unknown;
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?.trim()
  .replace(/\/+$/, "");
const SCENT_PROFILE_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/scent-profile`
  : "/api/scent-profile";
const SEARCH_SCENT_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/search-scent`
  : "/api/search-scent";
const ENRICHMENT_STATUS_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/enrichment/status`
  : "/api/enrichment/status";

/** Match list rows: keep one line each; overflow shows ellipsis in CSS */
const MATCH_LINE_MAX_CHARS = 44;

function truncateMatchLine(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function profileToFallbackMatch(profile: Record<string, unknown>, query: string): FragranceMatch | null {
  const product = profile.product as Record<string, unknown> | undefined;
  const name = firstString(
    typeof product?.name === 'string' ? product.name : undefined,
    typeof profile.name === 'string' ? profile.name : undefined,
    query,
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

  const profile = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
  };

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

  const profile = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
  };

  if (!res.ok || (typeof profile.error === 'string' && profile.error.trim())) {
    return null;
  }

  return profile;
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

type EnrichmentStatusResponse = {
  status?: EnrichmentStatus;
  requested_count?: number;
  last_requested_at?: string;
  job_key?: string;
  message?: string;
};

async function fetchEnrichmentStatus(
  fgUrl: string | undefined,
  signal: AbortSignal,
): Promise<EnrichmentStatusResponse | null> {
  if (!fgUrl) return null;

  const url = `${ENRICHMENT_STATUS_ENDPOINT}?fg_url=${encodeURIComponent(fgUrl)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;

  const data = (await res.json().catch(() => null)) as EnrichmentStatusResponse | null;
  if (!data || typeof data !== 'object') return null;
  return data;
}

function withEnrichmentStatus(
  detail: FragranceDetail,
  status: EnrichmentStatusResponse | null,
): FragranceDetail {
  if (!status?.status) return normalizeFragranceDetail(detail);

  return normalizeFragranceDetail({
    ...detail,
    enrichment: {
      ...(detail.enrichment ?? {}),
      status: status.status,
      ...(typeof status.requested_count === 'number'
        ? { requested_count: status.requested_count }
        : {}),
      ...(typeof status.last_requested_at === 'string'
        ? { last_requested_at: status.last_requested_at }
        : {}),
      ...(typeof status.message === 'string' ? { message: status.message } : {}),
    },
  });
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
  const [hasSearched, setHasSearched] = useState(false);
  const [syncComplete, setSyncComplete] = useState(false);
  const [isDetailsPolling, setIsDetailsPolling] = useState(false);
  const [pollingNotice, setPollingNotice] = useState<string | null>(null);
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
    setLoadingStatus("Researching Fragrance...");
    setMatches([]);
    setErrorStatus(null);
    setPollingNotice(null);
    setHasSearched(false);
    setSyncComplete(false);

    try {
      let nextMatches: FragranceMatch[] = [];

      try {
        const searchData = await searchFragrances(targetQuery, { signal: controller.signal });
        const results = Array.isArray(searchData.results) ? searchData.results : [];
        nextMatches = results
          .map((result): FragranceMatch => {
            const house = firstString(result.house, result.brand) ?? "";
            const id = firstString(result.id) ?? "";
            return {
              ...result,
              id,
              name: firstString(result.name) ?? targetQuery.trim(),
              house,
              brand: house,
              origin: result.origin ?? 'srt',
            };
          })
          .filter((result) => Boolean((result.id || firstString(result.source_url)) && result.brand));
      } catch (err: any) {
        if (err.name === 'AbortError') return;
      }

      if (nextMatches.length === 0) {
        const fallbackMatch = await searchLocalFallback(targetQuery, controller.signal);
        if (fallbackMatch) nextMatches = [fallbackMatch];
      }

      setHasSearched(true);
      setLoadingStatus(
        nextMatches.length > 0
          ? "Intelligence Collation Complete."
          : "No fragrance match found.",
      );
      setMatches(nextMatches);
      setSelectedIdx(nextMatches.length > 0 ? 0 : null);

    } catch (err: any) {
      if (err.name === 'AbortError') return; // Ignore expected aborts
      setErrorStatus(err?.message || "Search failed.");
    } finally {
      setUploading(false);
    }
  };

  const handleRetry = () => {
    setErrorStatus(null);
    setPollingNotice(null);
    handleSearch();
  };

  const pollForCompleteDetail = async (
    detailsRequest: FragranceDetailRequestPayload,
    signal: AbortSignal,
  ): Promise<FragranceDetail> => {
    let detail = normalizeFragranceDetail(
      (await getFragranceDetails(detailsRequest, { signal })) as FragranceDetail,
    );
    if (isCoverageComplete(detail)) {
      return detail;
    }
    if (shouldContinueWithPartialDetail(detail)) {
      setPollingNotice(PARTIAL_ENRICHMENT_NOTICE);
      return detail;
    }
    if (shouldUsePartialDetailImmediately(detail)) {
      setPollingNotice(PARTIAL_ENRICHMENT_NOTICE);
      return detail;
    }

    const requestFgUrl = "source_url" in detailsRequest ? detailsRequest.source_url : undefined;
    const detailFgUrl = firstString(
      requestFgUrl,
      detail.source_url,
      detail.raw?.source_urls?.frag_url,
    );

    const applyLatestEnrichmentStatus = async (): Promise<boolean> => {
      let status: EnrichmentStatusResponse | null = null;
      try {
        status = await fetchEnrichmentStatus(detailFgUrl, signal);
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        return false;
      }

      if (!status || status.status === 'not_found') return false;

      if (status.status === 'completed' || status.status === 'not_needed') {
        try {
          const refreshed = normalizeFragranceDetail(
            (await getFragranceDetails(detailsRequest, { signal })) as FragranceDetail,
          );
          detail = withEnrichmentStatus(refreshed, status);
        } catch (err: any) {
          if (err?.name === 'AbortError') throw err;
          detail = withEnrichmentStatus(detail, status);
        }
      } else {
        detail = withEnrichmentStatus(detail, status);
      }

      if (isCoverageComplete(detail)) {
        setPollingNotice(null);
        return true;
      }

      if (status.status && isTerminalEnrichmentStatus(status.status)) {
        setPollingNotice(status.message ?? null);
        return true;
      }

      if (shouldContinueWithPartialDetail(detail)) {
        setPollingNotice(PARTIAL_ENRICHMENT_NOTICE);
        return true;
      }

      return false;
    };

    if (await applyLatestEnrichmentStatus()) {
      return detail;
    }

    setIsDetailsPolling(true);
    setLoadingStatus('Enriching fragrance details...');
    setPollingNotice('Enriching fragrance details...');

    let attempt = 1;
    let delayMs = DETAIL_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    let pausedForHiddenMs = 0;

    while (attempt < DETAIL_POLL_MAX_ATTEMPTS) {
      const elapsedMs = Date.now() - startedAt - pausedForHiddenMs;
      if (elapsedMs >= DETAIL_POLL_MAX_DURATION_MS) break;

      pausedForHiddenMs += await waitUntilVisible(signal);

      const remainingMs = DETAIL_POLL_MAX_DURATION_MS - (Date.now() - startedAt - pausedForHiddenMs);
      if (remainingMs <= 0) break;

      await sleepWithAbort(Math.min(delayMs, remainingMs), signal);
      pausedForHiddenMs += await waitUntilVisible(signal);

      attempt += 1;
      setLoadingStatus(`Enriching fragrance details... (${attempt}/${DETAIL_POLL_MAX_ATTEMPTS})`);
      setPollingNotice(`Enriching fragrance details... (${attempt}/${DETAIL_POLL_MAX_ATTEMPTS})`);

      try {
        detail = normalizeFragranceDetail(
          (await getFragranceDetails(detailsRequest, { signal })) as FragranceDetail,
        );
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        setPollingNotice("Couldn't fetch full details right now.");
        return detail;
      }

      if (isCoverageComplete(detail)) {
        setPollingNotice(null);
        return detail;
      }

      if (await applyLatestEnrichmentStatus()) {
        return detail;
      }

      delayMs = Math.min(
        Math.round(delayMs * DETAIL_POLL_BACKOFF_MULTIPLIER),
        DETAIL_POLL_MAX_INTERVAL_MS,
      );
    }

    setPollingNotice("Couldn't fetch full details right now.");
    return detail;
  };

  const handleConfirm = async () => {
    if (selectedIdx === null || !matches[selectedIdx] || !onAdd) return;
    
    const selected = matches[selectedIdx];
    if (selected.scent_vector) {
      setUploading(true);
      setSyncComplete(true);
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
          setSyncComplete(false);
          return;
        }
        await sleep(420);
        resetState();
      } catch (err: any) {
        setErrorStatus(err?.message || "Vault sync failed. Please try again.");
        setSyncComplete(false);
      } finally {
        setUploading(false);
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
    setLoadingStatus("Fetching Fragrance Intelligence...");
    setSyncComplete(false);
    setPollingNotice(null);
    setIsDetailsPolling(false);
    
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

      const detail = await pollForCompleteDetail(detailsRequest, controller.signal);
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
      let pipelineProfile = (await profileRes.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: string;
      };
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
        pyramid:
          pyramidNotes.top.length || pyramidNotes.heart.length || pyramidNotes.base.length
            ? pyramidNotes
            : undefined,
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
        setSyncComplete(false);
        return;
      }
      setSyncComplete(true);
      await sleep(620);
      resetState();
      if (shouldContinueWithPartialDetail(detail)) {
        setPollingNotice(PARTIAL_ENRICHMENT_NOTICE);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setErrorStatus(err?.message || "Fragrance detail fetch failed. Please check your connection.");
    } finally {
      setIsDetailsPolling(false);
      setUploading(false);
    }
  };

  const resetState = () => {
    setMatches([]);
    setSelectedIdx(null);
    setHasSearched(false);
    setSearchQuery("");
    setSyncComplete(false);
    setPollingNotice(null);
    setIsDetailsPolling(false);
  };

  return (
    <div className="glass-shell rounded-[var(--radius-scent)] relative overflow-hidden">
      <AnimatePresence>
        {uploading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-8 text-center backdrop-blur-xl"
          >
            <motion.div
              animate={
                syncComplete
                  ? { scale: [1, 1.06, 1] }
                  : { y: [0, -3, 0], scale: [1, 1.03, 1] }
              }
              transition={
                syncComplete
                  ? { duration: 0.46, ease: 'easeOut' }
                  : { duration: 2.1, repeat: Infinity, ease: 'easeInOut' }
              }
              className="mb-6"
            >
              <ScentSearchGlyph active={!syncComplete} reduceMotion={reduceMotion} size="overlay" />
            </motion.div>
            <h3 className="mb-2 font-serif text-xl italic text-white">{loadingStatus}</h3>
            <p className="animate-pulse text-[10px] font-bold italic uppercase tracking-[0.3em] text-white/30 font-sans">
              Processing Olfactory Data
            </p>
            {isDetailsPolling ? (
              <p className="mt-3 animate-pulse text-[10px] font-bold uppercase tracking-[0.22em] text-scent-accent/80">
                Enriching...
              </p>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="glass rounded-[var(--radius-scent-inner)] p-4 md:p-6">
        <header className="mb-[1.41rem] px-2 -translate-y-px">
          <p className="sr-only">
            Add perfumes to your vault. Example fragrance names rotate above the search field.
          </p>
          <div className="flex flex-col items-center text-center gap-[0.94rem] pt-px">
            <div className="space-y-[0.7rem] w-full -translate-y-px">
              <p className="text-[11px] uppercase tracking-[0.26em] text-scent-accent/85 font-bold">
                Add To Vault
              </p>
              <div className="mx-auto w-full max-w-lg px-1">
                <VaultHeadlineRotation phrases={VAULT_HEADLINE_ROTATION} />
              </div>
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
        <AnimatePresence>
          {pollingNotice && !isDetailsPolling && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-scent text-center"
            >
              <p className="text-[10px] text-amber-300/90 font-medium leading-relaxed">{pollingNotice}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mx-auto max-w-lg text-center -mt-0.5">
          <form
            onSubmit={handleSearch}
            className="relative group rounded-[var(--radius-scent)] transition-[filter] duration-300 ease-out group-focus-within:drop-shadow-[0_0_28px_rgba(201,139,44,0.14)]"
          >
            <input
              id="scent-add-to-vault-search"
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setErrorStatus(null); }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search by house or fragrance..."
              aria-label="Look up a brand or fragrance"
              className="scent-lux-input relative z-0 w-full h-[58px] sm:h-[62px] min-h-[48px] pl-12 pr-[3.4rem] sm:pr-14 text-center text-[#fff7ec] font-sans text-[15px] font-medium leading-snug tracking-[0.02em] outline-none transition-[border-color,box-shadow,background-color,color] duration-200 ease-out caret-[#e8b456] selection:bg-scent-accent/90 selection:text-[#0a0705] placeholder:text-[#d9c2a4]/52 placeholder:font-normal placeholder:tracking-[0.04em] hover:border-[rgba(235,188,108,0.52)] scroll-mt-28"
            />
            <motion.button
              type="submit"
              disabled={uploading}
              whileHover={uploading ? undefined : { scale: 1.06 }}
              whileTap={uploading ? undefined : { scale: 0.9 }}
              transition={{ type: "spring", stiffness: 520, damping: 22 }}
              className="absolute right-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/[0.09] bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.02))] p-0 text-scent-accent/82 shadow-[inset_0_1px_0_rgba(255,235,198,0.08),0_10px_18px_-14px_rgba(0,0,0,0.92)] outline-none transition-[border-color,background-color,transform,opacity] duration-200 ease-out hover:border-scent-accent/32 hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-scent-accent/35 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-45 group-focus-within:border-scent-accent/22"
              aria-label="Search"
            >
              <ScentSearchGlyph active={uploading} reduceMotion={reduceMotion} />
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
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0, y: -8 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="mt-8 pt-6 border-t border-white/10 mx-auto max-w-lg w-full"
            >
              <div className="flex max-h-[min(47dvh,26rem)] min-h-0 flex-col sm:max-h-[min(48dvh,28rem)] md:max-h-[min(44dvh,29rem)]">
                <div className="mb-5 flex shrink-0 justify-center px-1">
                  <p className="text-[9px] uppercase tracking-[0.34em] text-scent-muted font-bold">
                    Archive Matches{' '}
                    <span className="tabular-nums text-scent-accent/75 tracking-[0.12em]">
                      ({matches.length})
                    </span>
                  </p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 scrollbar-hide">
                  <div className="grid grid-cols-1 gap-2.5">
                    {matches.map((m, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setSelectedIdx(i)}
                        className={`group w-full min-h-[76px] px-5 py-4 text-center border transition-all duration-200 cursor-pointer rounded-[var(--radius-scent)] ${
                          selectedIdx === i
                            ? 'border-scent-accent/45 bg-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_0_1px_rgba(201,139,44,0.12)]'
                            : 'border-white/10 hover:bg-white/[0.035] hover:border-white/16'
                        }`}
                        aria-pressed={selectedIdx === i}
                      >
                        <div className="mx-auto flex min-w-0 max-w-full flex-col items-center gap-1">
                          <p
                            className="font-serif italic text-[1.12rem] leading-snug text-[#fff7ec] max-w-full truncate px-1"
                            title={m.name}
                          >
                            {truncateMatchLine(m.name, MATCH_LINE_MAX_CHARS)}
                          </p>
                          <p
                            className="text-[11px] uppercase tracking-[0.16em] text-scent-accent/80 font-sans font-bold max-w-full truncate px-1"
                            title={m.brand || 'House unavailable'}
                          >
                            {truncateMatchLine(m.brand || 'House unavailable', MATCH_LINE_MAX_CHARS)}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 bg-[linear-gradient(180deg,rgba(5,4,3,0)_0%,rgba(5,4,3,0.76)_20%,rgba(5,4,3,0.96)_100%)] pt-4 pb-[max(0.15rem,env(safe-area-inset-bottom))]">
                  <AnimatePresence>
                    {selectedIdx !== null ? (
                      <motion.p
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="text-center text-[10px] uppercase tracking-[0.24em] text-scent-accent/72 font-bold"
                      >
                        Ready for Vault Sync
                      </motion.p>
                    ) : null}
                  </AnimatePresence>
                  <button
                    onClick={handleConfirm}
                    className="scent-primary-button mt-4 h-12 w-full rounded-[var(--radius-scent)] px-4 font-serif italic text-base transition-all hover:scale-[1.02] active:scale-95 sm:mt-5 sm:h-14 sm:text-lg"
                  >
                    Sync to Vault
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
