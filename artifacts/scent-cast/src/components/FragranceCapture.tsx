import React, { useState } from 'react';
import { Search, RefreshCw, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface FragranceMatch {
  name: string;
  brand: string;
  imageUrl: string;
  notes?: string[];
  family?: string;
  description?: string;
  pyramid?: any;
}

export const FragranceCapture: React.FC<{ onAdd?: (item: any) => void }> = ({ onAdd }) => {
  const [uploading, setUploading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [matches, setMatches] = useState<FragranceMatch[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;
    setUploading(true);
    setLoadingStatus("Researching Fragrance...");
    setMatches([]);
    setErrorStatus(null);
    setHasSearched(false);
    try {
      const res = await fetch('/api/search-scent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
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
    if (selectedIdx !== null && matches[selectedIdx] && onAdd) {
      const selected = matches[selectedIdx];
      if ((selected as any).scent_vector) {
        onAdd({
          ...selected,
          id: Math.random().toString(36).substr(2, 9),
          season: (selected as any).family?.includes('Fresh') ? 'Summer' : (selected as any).family?.includes('Woody') ? 'Winter' : 'Universal'
        });
      } else {
        setUploading(true);
        setLoadingStatus("Finalizing Neural Link...");
        try {
          const profileRes = await fetch('/api/scent-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Pass all known AI-identified data so buildProfile can construct
            // a full profile even for fragrances not in the local dataset.
            body: JSON.stringify({
              name: selected.name,
              brand: selected.brand,
              notes: (selected as any).notes,
              family: (selected as any).family,
              description: (selected as any).description,
              pyramid: (selected as any).pyramid,
              perfumer: (selected as any).perfumer,
            })
          });
          if (!profileRes.ok) throw new Error(`HTTP ${profileRes.status}`);
          const data = await profileRes.json();
          if (data && !data.error) {
            onAdd({ ...data, id: Math.random().toString(36).substr(2, 9), season: 'Universal' });
          } else {
            setErrorStatus(data?.error || "Could not sync to vault. Please try again.");
            return;
          }
        } catch (err) {
          setErrorStatus("Vault sync failed. Please check your connection.");
          return;
        } finally {
          setUploading(false);
        }
      }
      setMatches([]);
      setSelectedIdx(null);
      setHasSearched(false);
      setSearchQuery("");
    }
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
      <div className="glass rounded-[var(--radius-scent-inner)] p-4 md:p-5">
        <div className="flex flex-col items-center text-center mb-8 px-2 gap-6">
          <div>
            <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted font-bold mb-1">Add To Vault</p>
            <h2 className="font-serif italic text-2xl text-white tracking-tighter">Capture Essence</h2>
          </div>
          <p className="text-[9px] uppercase tracking-widest text-scent-muted font-bold">Search Mode</p>
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

        <div className="space-y-4">
          <form onSubmit={handleSearch} className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setErrorStatus(null); }}
              placeholder="Enter Fragrance Name..."
              className="w-full bg-white/[0.03] border border-white/10 rounded-[1.25rem] h-14 px-6 text-white font-sans text-sm outline-none focus:border-white/30 transition-colors placeholder:text-white/20"
            />
            <button
              type="submit"
              disabled={uploading}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 text-scent-muted hover:text-white transition-colors disabled:opacity-50"
            >
              {uploading ? <RefreshCw size={16} className="animate-spin" /> : <Search size={18} />}
            </button>
          </form>
          <div className="flex flex-wrap gap-2 justify-center">
            {['Aventus', 'Rouge 540', 'Santal 33'].map(tag => (
              <button
                key={tag}
                onClick={() => { setSearchQuery(tag); setTimeout(() => handleSearch(), 100); }}
                className="px-3 py-1 bg-white/5 rounded-full text-[8px] uppercase tracking-widest text-scent-muted hover:text-white hover:bg-white/10 transition-all border border-white/5"
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
                      <div className="w-10 h-10 bg-white/5 p-1 rounded-sm overflow-hidden flex items-center justify-center border border-white/10">
                        {m.imageUrl ? (
                          <img
                            src={m.imageUrl}
                            alt={m.name}
                            className="w-full h-full object-contain"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                            }}
                          />
                        ) : (
                          <div className="text-[8px] text-white/20 font-bold uppercase text-center">N/A</div>
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
                className="w-full mt-6 h-14 bg-white text-scent-bg font-serif italic text-lg hover:scale-[1.02] active:scale-95 transition-all rounded-[1.25rem] shadow-lg"
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
