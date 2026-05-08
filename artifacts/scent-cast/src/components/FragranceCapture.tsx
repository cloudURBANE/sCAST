import React, { useState, useRef, useEffect } from 'react';
import { Search, RefreshCw, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BottleImage } from '@/components/BottleImage';

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

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json();
    if (typeof data?.error === 'string' && data.error.trim()) return data.error;
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  } catch {
    try {
      const text = await res.text();
      if (text.trim()) return text.trim();
    } catch {
      /* fall through to fallback */
    }
  }
  return fallback;
}

interface FragranceMatch {
  name: string;
  brand: string;
  imageUrl: string;
  notes?: string[];
  family?: string;
  description?: string;
  pyramid?: unknown;
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
    searchAbortController.current = new AbortController();

    setUploading(true);
    setLoadingStatus("Researching Fragrance...");
    setMatches([]);
    setErrorStatus(null);
    setHasSearched(false);

    try {
      const res = await fetch('/api/search-scent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: targetQuery,
          concentrationHint: concentrationHint === 'any' ? undefined : concentrationHint,
        }),
        signal: searchAbortController.current.signal,
      });
      
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, `Search failed: HTTP ${res.status}`));
      }
      
      const profileData = await res.json();
      if (!profileData || profileData.error) {
        throw new Error(profileData?.error || "Search returned no fragrance match");
      }

      setHasSearched(true);
      setLoadingStatus(`Found: ${profileData.brand || "Unknown"} ${profileData.name}`);
      setLoadingStatus("Intelligence Collation Complete.");
      
      setMatches([{
        ...profileData,
        name: profileData.product?.name || profileData.name,
        brand: profileData.product?.brand || profileData.brand,
        imageUrl: profileData.imageUrl || ""
      }]);
      setSelectedIdx(0);

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
    
    const selected = matches[selectedIdx] as FragranceMatch & Record<string, unknown>;

    if (selected.scent_vector) {
      const familyStr = (selected.family as string) || '';
      onAdd({
        ...selected,
        id: newFragranceId(),
        season: familyStr.includes('Fresh') ? 'Summer' : familyStr.includes('Woody') ? 'Winter' : 'Universal'
      });
      resetState();
      return;
    }

    // Abort any in-flight syncs to prevent duplicate database writes
    if (syncAbortController.current) {
      syncAbortController.current.abort();
    }
    syncAbortController.current = new AbortController();

    setUploading(true);
    setLoadingStatus("Finalizing Neural Link...");
    
    try {
      const profileRes = await fetch('/api/scent-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: selected.name,
          brand: selected.brand,
          notes: selected.notes,
          family: selected.family,
          description: selected.description,
          pyramid: selected.pyramid,
          perfumer: selected.perfumer,
        }),
        signal: syncAbortController.current.signal,
      });

      if (!profileRes.ok) throw new Error(`HTTP ${profileRes.status}`);
      
      const data = await profileRes.json();
      
      if (data && !data.error) {
        onAdd({
          ...data,
          name: data.name || data.product?.name || selected.name,
          brand: data.brand || data.product?.brand || selected.brand,
          imageUrl: data.imageUrl || selected.imageUrl || '',
          id: newFragranceId(),
          season: 'Universal',
        });
        resetState();
      } else {
        setErrorStatus(data?.error || "Could not sync to vault. Please try again.");
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setErrorStatus("Vault sync failed. Please check your connection.");
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
                      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-sm border border-white/10 bg-white/5">
                        {m.imageUrl ? (
                          <BottleImage variant="thumb" src={m.imageUrl} alt={m.name} className="h-full w-full" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[8px] font-bold uppercase text-white/20">
                            N/A
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="font-serif italic text-lg leading-tight text-white">{m.name}</p>
                        <p className="text-[8px] uppercase text-scent-muted tracking-widest font-sans font-bold">{m.brand}</p>
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
