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

interface FragranceMatch extends FragranceSearchResult {
  name: string;
  brand: string;
  house: string;
}

type ConcentrationHint = 'any' | 'edt' | 'edp' | 'parfum' | 'extrait' | 'elixir';

// Static Hoisting: Prevent memory reallocation on every render cycle
const QUICK_SEARCH_TAGS = ['Aventus', 'Rouge 540', 'Santal 33'];
const CONCENTRATION_OPTIONS: { id: ConcentrationHint; label: string }[] = [
  { id: 'any', label: 'Any' },
  { id: 'edt', label: 'EDT' },
  { id: 'edp', label: 'EDP' },
  { id: 'parfum', label: 'Parfum' },
  { id: 'extrait', label: 'Extrait' },
  { id: 'elixir', label: 'Elixir' },
];

export const FragranceCapture: React.FC<{ onAdd?: (item: any) => void }> = ({ onAdd }) => {
  const [uploading, setUploading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [matches, setMatches] = useState<FragranceMatch[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [concentrationHint, setConcentrationHint] = useState<ConcentrationHint>('any');
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Network lifecycle management
  const searchAbortController = useRef<AbortController | null>(null);
  const syncAbortController = useRef<AbortController | null>(null);

  // Cleanup pending requests on component unmount
  useEffect(() => {
    return () => {
      searchAbortController.current?.abort();
      syncAbortController.current?.abort();
    };
  }, []);

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
        <div className="flex flex-col items-center text-center mb-7 px-2 gap-5">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-scent-accent/82 font-bold mb-1">Add To Vault</p>
            <h2 className="font-serif italic text-2xl text-[#fff7ec] tracking-normal">Capture Essence</h2>
          </div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-[#d6c2a8]/78 font-bold">Search Mode</p>
        </div>

        <AnimatePresence>
          {errorStatus && (
            <motion.div
              initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-scent"
            >
              <div className="flex items-start gap-3 mb-2">
                <div className="mt-0.5 w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                <p className="text-[10px] text-red-500/90 font-medium leading-relaxed">{errorStatus}</p>
              </div>
              <button onClick={handleRetry} className="text-[9px] uppercase tracking-widest text-red-500 font-bold hover:underline ml-4">
                Try Again
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-5">
          <form onSubmit={handleSearch} className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setErrorStatus(null); }}
              placeholder="Enter Fragrance Name..."
              className="scent-lux-input w-full h-[58px] sm:h-[62px] px-12 text-center text-[#fff7ec] font-sans text-[15px] outline-none transition-colors placeholder:text-[#d9c2a4]/56"
            />
            <button
              type="submit"
              disabled={uploading}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 text-scent-accent/78 hover:text-white transition-colors disabled:opacity-50"
            >
              {uploading ? <RefreshCw size={16} className="animate-spin" /> : <Search size={18} />}
            </button>
          </form>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <span className="text-[10px] uppercase tracking-[0.24em] text-[#d6c2a8]/68 font-bold">Concentration</span>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {CONCENTRATION_OPTIONS.map((option) => {
                const selected = concentrationHint === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setConcentrationHint(option.id)}
                    className={`min-h-7 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.16em] border font-bold transition-all ${
                      selected
                        ? 'bg-scent-accent text-black border-scent-accent shadow-[0_0_18px_rgba(201,139,44,0.18)]'
                        : 'bg-black/28 text-[#d6c2a8]/72 border-scent-accent/24 hover:text-white hover:border-scent-accent/52 hover:bg-white/[0.07]'
                    }`}
                    aria-pressed={selected}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            {QUICK_SEARCH_TAGS.map(tag => (
              <button
                key={tag}
                type="button"
                onClick={() => { 
                  setSearchQuery(tag); 
                  handleSearch(undefined, tag); 
                }}
                className="min-h-7 px-3 py-1 bg-black/24 rounded-full text-[10px] uppercase tracking-[0.16em] text-[#d6c2a8]/70 hover:text-white hover:bg-white/[0.08] transition-all border border-scent-accent/18"
              >
                {tag}
              </button>
            ))}
          </div>
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
              className="mt-8 pt-6 border-t border-white/10"
            >
              <p className="text-[9px] uppercase tracking-[0.4em] text-scent-muted mb-4 font-bold text-center">Archive Matches</p>
              <div className="grid grid-cols-1 gap-2">
                {matches.map((m, i) => (
                  <div
                    key={i}
                    onClick={() => setSelectedIdx(i)}
                    className={`flex items-center justify-between p-3 border transition-all cursor-pointer rounded-[1.25rem] ${selectedIdx === i ? 'border-white bg-white/10' : 'border-white/10 hover:bg-white/5'}`}
                  >
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-serif italic text-lg leading-tight text-white">{m.name}</p>
                        <p className="text-[8px] uppercase text-scent-muted tracking-widest font-sans font-bold">
                          {m.brand || "House unavailable"}
                        </p>
                      </div>
                    </div>
                    {selectedIdx === i && <Check size={16} className="text-white" />}
                  </div>
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
