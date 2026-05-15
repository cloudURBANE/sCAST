import React, { useState, useRef, useEffect } from 'react';
import { Search, RefreshCw, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getFragranceDetails,
  searchFragrances,
  type FragranceDetail,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Rotating vault headline — house + scent pairs for the typewriter. */
const VAULT_HEADLINE_ROTATION = [
  'Chanel Coco Mademoiselle',
  'Tom Ford Oud Wood',
  'Maison Francis Kurkdjian Baccarat Rouge 540',
  'Le Labo Santal 33',
  'Dior Sauvage',
  'Yves Saint Laurent Libre',
  'Creed Aventus',
] as const;

/** ~one line in the headline slot at max-w-lg; longer phrases truncate before "..." */
const HEADLINE_BASE_MAX_CHARS = 34;

/** These phrase indices type slightly faster (still slower than the original animation). */
const HEADLINE_FAST_INDICES = new Set([1, 3, 4, 6]);

function vaultHeadlineBase(full: string): string {
  const t = full.trim();
  if (t.length <= HEADLINE_BASE_MAX_CHARS) return t;
  return t.slice(0, HEADLINE_BASE_MAX_CHARS).trimEnd();
}

function useVaultHeadlineTypewriter(phrases: readonly string[]): string {
  const [text, setText] = useState('');
  const phrasesRef = useRef(phrases);
  phrasesRef.current = phrases;

  useEffect(() => {
    let cancelled = false;
    let idx = Math.floor(Math.random() * phrasesRef.current.length);

    const slowTypeMs = 82;
    const fastTypeMs = 58;
    const deleteMs = 34;
    const dotTypeMs = 52;
    const holdMs = 3000;
    const gapMs = 560;

    const run = async () => {
      const list = phrasesRef.current;
      while (!cancelled) {
        const raw = list[idx % list.length];
        const base = vaultHeadlineBase(raw);
        const typeMs = HEADLINE_FAST_INDICES.has(idx % list.length) ? fastTypeMs : slowTypeMs;

        for (let len = 1; len <= base.length && !cancelled; len += 1) {
          setText(base.slice(0, len));
          await sleep(typeMs);
        }
        if (cancelled) break;

        const dots = '...';
        for (let d = 1; d <= dots.length && !cancelled; d += 1) {
          setText(`${base}${dots.slice(0, d)}`);
          await sleep(dotTypeMs);
        }
        if (cancelled) break;

        await sleep(holdMs);

        const full = `${base}${dots}`;
        for (let len = full.length; len >= 0 && !cancelled; len -= 1) {
          setText(full.slice(0, len));
          await sleep(deleteMs);
        }
        if (cancelled) break;

        await sleep(gapMs);
        idx += 1;
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return text;
}

interface FragranceMatch extends FragranceSearchResult {
  name: string;
  brand: string;
  house: string;
}

/** Match list rows: keep one line each; overflow shows ellipsis in CSS */
const MATCH_LINE_MAX_CHARS = 44;

function truncateMatchLine(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export const FragranceCapture: React.FC<{
  onAdd?: (item: any) => void;
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

  const headlineText = useVaultHeadlineTypewriter(VAULT_HEADLINE_ROTATION);

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
    setHasSearched(false);

    try {
      const searchData = await searchFragrances(targetQuery, { signal: controller.signal });
      const results = Array.isArray(searchData.results) ? searchData.results : [];
      const nextMatches = results
        .map((result): FragranceMatch => {
          const house = firstString(result.house, result.brand) ?? "";
          return {
            ...result,
            name: firstString(result.name) ?? targetQuery.trim(),
            house,
            brand: house,
          };
        })
        .filter((result) => Boolean(result.id?.trim()));

      setHasSearched(true);
      setLoadingStatus(
        nextMatches.length > 0
          ? `Found: ${nextMatches[0].brand || "House unavailable"} ${nextMatches[0].name}`
          : "No fragrance match found.",
      );
      setLoadingStatus("Intelligence Collation Complete.");
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
    handleSearch();
  };

  const handleConfirm = async () => {
    if (selectedIdx === null || !matches[selectedIdx] || !onAdd) return;
    
    const selected = matches[selectedIdx];
    if (!selected.id?.trim()) {
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
    
    try {
      const detail = (await getFragranceDetails(
        { id: selected.id },
        { signal: controller.signal },
      )) as FragranceDetail;
      const metricNotes = detail.derived_metrics?.notes;
      const rawNotes = detail.raw?.notes;
      const pyramidNotes = {
        top: metricNotes?.top ?? rawNotes?.top ?? [],
        heart: metricNotes?.heart ?? rawNotes?.heart ?? [],
        base: metricNotes?.base ?? rawNotes?.base ?? [],
      };
      const flatNotes =
        metricNotes?.flat ??
        rawNotes?.flat ??
        [...pyramidNotes.top, ...pyramidNotes.heart, ...pyramidNotes.base];
      const detailName = firstString(detail.name, selected.name) ?? selected.name;
      const detailBrand =
        firstString(detail.brand, detail.house, selected.brand, selected.house) ??
        selected.brand;
      const detailHouse = firstString(detail.house, detail.brand, selected.house, selected.brand);
      const detailImageUrl = firstString(detail.imageUrl, detail.image_url) ?? "";
      const detailFamily = firstString(
        typeof detail.family === 'string' ? detail.family : undefined,
      );
      const detailPerfumer = firstString(
        typeof detail.perfumer === 'string' ? detail.perfumer : undefined,
      );
      const detailDescription =
        typeof detail.raw?.description === 'string' ? detail.raw.description : undefined;

      const profileRes = await fetch('/api/scent-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: detailName,
          brand: detailBrand,
          preferEngineData: flatNotes.length > 0,
          notes: flatNotes.length > 0 ? flatNotes : undefined,
          ...(detailFamily ? { family: detailFamily } : {}),
          ...(detailDescription ? { description: detailDescription } : {}),
          ...(detailPerfumer ? { perfumer: detailPerfumer } : {}),
          ...(pyramidNotes.top.length || pyramidNotes.heart.length || pyramidNotes.base.length
            ? { pyramid: pyramidNotes }
            : {}),
        }),
        signal: controller.signal,
      });
      const pipelineProfile = (await profileRes.json().catch(() => ({}))) as Record<string, unknown> & {
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
        throw new Error(pipelineProfile.error);
      }

      const pipelineImageUrl = firstString(
        typeof pipelineProfile.imageUrl === 'string' ? pipelineProfile.imageUrl : undefined,
      );

      onAdd({
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
        imageUrl: pipelineImageUrl || detailImageUrl,
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
        notes: flatNotes.length > 0 ? flatNotes : undefined,
        description:
          typeof detail.raw?.description === 'string'
            ? detail.raw.description
            : undefined,
      });
      resetState();
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setErrorStatus(err?.message || "Fragrance detail fetch failed. Please check your connection.");
    } finally {
      setUploading(false);
    }
  };

  const resetState = () => {
    setMatches([]);
    setSelectedIdx(null);
    setHasSearched(false);
    setSearchQuery("");
  };

  return (
    <div className="glass-shell rounded-[var(--radius-scent)] relative overflow-hidden">
      {uploading && (
        <div className="absolute inset-0 bg-black/90 backdrop-blur-xl z-50 flex flex-col items-center justify-center p-8 text-center">
          <motion.div
            animate={{ rotate: [0, 360], scale: [1, 1.1, 1] }}
            transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
            className="w-20 h-20 border-t-2 border-white/40 rounded-full mb-6"
          />
          <h3 className="font-serif italic text-xl text-white mb-2">{loadingStatus}</h3>
          <p className="text-white/30 text-[10px] uppercase tracking-[0.3em] font-sans font-bold italic animate-pulse">Processing Olfactory Data</p>
        </div>
      )}
      <div className="glass rounded-[var(--radius-scent-inner)] p-4 md:p-6">
        <header className="mb-6 px-2">
          <p className="sr-only">
            Add perfumes to your vault. Examples rotate above the search field.
          </p>
          <div className="flex flex-col items-center text-center gap-4 pt-1">
            <div className="space-y-3 w-full">
              <p className="text-[11px] uppercase tracking-[0.26em] text-scent-accent/85 font-bold">
                Add To Vault
              </p>
              <div className="mx-auto w-full max-w-lg px-1">
                <h2
                  className="flex h-[3rem] items-center justify-center gap-2 font-serif italic text-[clamp(1.25rem,4vw,1.75rem)] leading-none tracking-[0.02em] text-[#fff7ec] drop-shadow-[0_0_22px_rgba(201,139,44,0.14)]"
                  aria-hidden
                >
                  <span className="min-w-0 max-w-[calc(100%-0.75rem)] truncate bg-gradient-to-br from-[#fffbf5] via-[#fff7ec] to-[#e6d2b8]/88 bg-clip-text text-center text-transparent">
                    {headlineText}
                  </span>
                  <span
                    className="inline-block h-[1.05em] w-[2px] shrink-0 self-center rounded-full bg-gradient-to-b from-scent-accent/90 to-scent-accent/35 animate-pulse"
                    aria-hidden
                  />
                </h2>
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

        <div className="mx-auto max-w-lg text-center mt-1">
          <form onSubmit={handleSearch} className="relative group">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setErrorStatus(null); }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder=""
              aria-label="Look up a brand or fragrance"
              className="scent-lux-input relative z-0 w-full h-[58px] sm:h-[62px] px-12 text-center text-[#fff7ec] font-sans text-[15px] outline-none transition-colors group-focus-within:shadow-[inset_0_1px_0_rgba(255,226,174,0.08),0_0_0_1px_rgba(201,139,44,0.15)]"
            />
            {searchQuery === '' && !searchFocused && (
              <div
                className="pointer-events-none absolute inset-y-0 left-0 right-14 z-[1] flex items-center justify-center px-12 text-[#d9c2a4]/55"
                aria-hidden
              >
                <span className="scent-search-probe inline-flex w-[22px] shrink-0 translate-x-7 justify-between gap-1 opacity-95 sm:translate-x-9" aria-hidden>
                  <span className="scent-search-probe-dot" />
                  <span className="scent-search-probe-dot" />
                  <span className="scent-search-probe-dot" />
                </span>
              </div>
            )}
            <button
              type="submit"
              disabled={uploading}
              className="absolute right-3 top-1/2 z-10 -translate-y-1/2 p-2.5 text-scent-accent/78 hover:text-white transition-colors disabled:opacity-50"
              aria-label="Search"
            >
              {uploading ? <RefreshCw size={16} className="animate-spin" /> : <Search size={18} />}
            </button>
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
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              className="mt-8 pt-6 border-t border-white/10 mx-auto max-w-lg w-full"
            >
              <p className="text-[9px] uppercase tracking-[0.4em] text-scent-muted mb-4 font-bold text-center">Archive Matches</p>
              <div className="grid grid-cols-1 gap-2">
                {matches.map((m, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedIdx(i)}
                    className={`w-full text-left sm:text-center p-4 border transition-all cursor-pointer rounded-[var(--radius-scent)] ${selectedIdx === i ? 'border-scent-accent/52 bg-white/[0.07]' : 'border-white/10 hover:bg-white/[0.04] hover:border-white/18'}`}
                    aria-pressed={selectedIdx === i}
                  >
                    <div className="flex w-full gap-3 sm:flex-col sm:items-center sm:gap-2.5">
                      <div
                        className="flex w-5 shrink-0 justify-center pt-0.5 sm:w-auto sm:pt-0 sm:min-h-[22px] sm:items-center"
                        aria-hidden
                      >
                        {selectedIdx === i ? (
                          <Check size={16} className="text-scent-accent shrink-0" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1.5 text-left sm:text-center">
                        <p
                          className="text-[9px] uppercase tracking-[0.22em] text-scent-accent/80 font-sans font-bold truncate"
                          title={m.brand || 'House unavailable'}
                        >
                          {truncateMatchLine(m.brand || 'House unavailable', MATCH_LINE_MAX_CHARS)}
                        </p>
                        <div className="h-px w-full max-w-[10rem] bg-gradient-to-r from-transparent via-white/20 to-transparent sm:mx-auto" />
                        <p
                          className="font-serif italic text-lg leading-snug text-[#fff7ec] truncate"
                          title={m.name}
                        >
                          {truncateMatchLine(m.name, MATCH_LINE_MAX_CHARS)}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <button
                onClick={handleConfirm}
                className="scent-primary-button w-full mt-6 h-14 font-serif italic text-lg hover:scale-[1.02] active:scale-95 transition-all rounded-[var(--radius-scent)]"
              >
                Sync to Vault
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
