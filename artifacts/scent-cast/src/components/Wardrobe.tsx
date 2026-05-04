import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, ShieldCheck, Wind, RefreshCw } from 'lucide-react';

export interface ScentVector {
  freshness: number;
  sweetness: number;
  woodiness: number;
  spice: number;
  warmth: number;
  musk: number;
}

export type DestinationType = 'Staying In' | 'Going Out' | 'Work' | 'Night Out';
export type EnergyState = 'Calm' | 'Focused' | 'Confident' | 'Social' | 'Relaxed';

export interface Fragrance {
  id: string;
  name: string;
  brand: string;
  imageUrl: string;
  season: string;
  notes?: string[];
  concentration?: string;
  scent_vector?: ScentVector;
  intents?: DestinationType[];
  energies?: EnergyState[];
  family?: string;
  performance?: { sillage: number; longevity: number };
  pyramid?: { top: string[]; heart: string[]; base: string[] };
  context?: { weather: string[]; time: string[]; occasion: string[] };
  synthesized?: boolean;
  shareHidden?: boolean;
  /** Legacy ScentProfile shape — some old vault rows only have product.name/brand */
  product?: { name?: string; brand?: string; perfumer?: string };
}

/** Resolve the human-facing name/brand even if the row predates the flat shape. */
function entryName(item: Fragrance): string {
  return item?.name || item?.product?.name || "";
}
function entryBrand(item: Fragrance): string {
  return item?.brand || item?.product?.brand || "";
}

export const Wardrobe: React.FC<{
  items: Fragrance[];
  onDelete: (id: string) => void;
  onUpdateImage?: (id: string, imageUrl: string) => void;
  featuredItem?: Fragrance | null;
  onRebuild?: () => Promise<{ total: number; rebuilt: number; skipped: number } | null>;
}> = ({ items, onDelete, onUpdateImage, featuredItem, onRebuild }) => {
  const [selectedItem, setSelectedItem] = React.useState<Fragrance | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [rebuilding, setRebuilding] = React.useState(false);
  const [rebuildResult, setRebuildResult] = React.useState<string | null>(null);

  const openDetail = (item: Fragrance) => {
    setRefreshError(null);
    setSelectedItem(item);
  };

  const closeDetail = () => {
    setRefreshError(null);
    setSelectedItem(null);
  };

  const handleRebuildClick = async () => {
    if (!onRebuild || rebuilding) return;
    setRebuilding(true);
    setRebuildResult(null);
    try {
      const result = await onRebuild();
      if (result) {
        setRebuildResult(
          `Rebuilt ${result.rebuilt} of ${result.total}` +
            (result.skipped ? ` · ${result.skipped} skipped` : "")
        );
      } else {
        setRebuildResult("Rebuild failed");
      }
    } catch (err: any) {
      setRebuildResult(err?.message || "Rebuild failed");
    } finally {
      setRebuilding(false);
    }
  };

  const handleRefreshImage = async (item: Fragrance) => {
    setRefreshingId(item.id);
    setRefreshError(null);
    try {
      const res = await fetch('/api/refresh-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: entryName(item), brand: entryBrand(item) }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Refresh failed');
      onUpdateImage?.(item.id, data.imageUrl);
      // Reflect the new image in the open modal so users see the refresh take
      // effect without bouncing back to the grid.
      setSelectedItem((current) =>
        current && current.id === item.id ? { ...current, imageUrl: data.imageUrl } : current,
      );
    } catch (err: any) {
      setRefreshError(err.message || 'Image refresh failed');
    } finally {
      setRefreshingId(null);
    }
  };

  const filteredItems = items.filter(item => {
    const name = entryName(item);
    const brand = entryBrand(item);
    if (!name || !brand) return false;
    const q = searchQuery.toLowerCase();
    return (
      name.toLowerCase().includes(q) ||
      brand.toLowerCase().includes(q) ||
      item.family?.toLowerCase().includes(q) ||
      item.notes?.some(note => note?.toLowerCase().includes(q))
    );
  });

  const itemsPerShelf = 4;
  const shelves = [];
  for (let i = 0; i < filteredItems.length; i += itemsPerShelf) {
    shelves.push(filteredItems.slice(i, i + itemsPerShelf));
  }

  return (
    <div className="relative">
      <div className="space-y-32 relative z-10">
        <div className="flex flex-col items-center justify-center text-center border-b border-white/5 pb-16 gap-12">
          <div className="space-y-4">
            <p className="text-[10px] uppercase tracking-[0.6em] text-white/40 font-bold">Archives // Private Vault</p>
            <h2 className="font-serif italic text-4xl sm:text-6xl md:text-8xl text-white tracking-tighter">Vault of Aromas</h2>
          </div>
          <div className="flex flex-col items-center gap-8 w-full">
            <div className="relative w-full max-w-2xl">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search Olfactory Data..."
                className="w-full bg-white/[0.02] border border-white/5 rounded-none h-16 px-8 text-white font-sans text-sm focus:border-white/20 outline-none transition-all placeholder:text-white/10 uppercase tracking-widest"
              />
            </div>
            <span className="font-serif italic text-white/20 text-xl sm:text-3xl whitespace-nowrap">{filteredItems.length} ENTRIES</span>

            {onRebuild && (
              <div className="flex flex-col items-center gap-2">
                {!searchQuery && items.length > filteredItems.length && (
                  <p className="text-[9px] uppercase tracking-[0.35em] text-amber-300/60 font-bold">
                    {items.length - filteredItems.length} legacy {items.length - filteredItems.length === 1 ? "entry" : "entries"} need a rebuild
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleRebuildClick}
                  disabled={rebuilding || items.length === 0}
                  className="px-5 py-2.5 border border-white/10 text-[9px] uppercase tracking-[0.4em] text-white/50 hover:text-white hover:border-white/30 transition-all flex items-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <RefreshCw size={11} className={rebuilding ? "animate-spin" : ""} />
                  {rebuilding ? "Rebuilding Vault…" : "Rebuild Vault"}
                </button>
                {rebuildResult && (
                  <p className="text-[9px] uppercase tracking-[0.3em] text-white/30 font-bold">{rebuildResult}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {!searchQuery && items.length >= 10 && featuredItem && (
          <section className="space-y-16 py-24 bg-gradient-to-b from-white/[0.03] to-transparent border-y border-white/5 relative overflow-hidden">
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
            <div className="flex items-center gap-4 px-4 relative z-10">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
              <h3 className="font-serif italic text-2xl text-white/60 tracking-[0.3em] uppercase">Tactical Selection</h3>
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            </div>
            <div className="flex justify-center relative z-10">
              <div className="relative group max-w-sm w-full">
                <div className="pedestal p-1">
                  <motion.div
                    initial={{ scale: 0.98, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                    className="glass-acrylic glass-acrylic-animate rounded-scent p-20 aspect-[3/4] flex flex-col items-center justify-center relative overflow-hidden cursor-pointer"
                    onClick={() => setSelectedItem(featuredItem)}
                  >
                    <div className="absolute top-10 left-10 text-[9px] uppercase tracking-[0.6em] text-white/30 font-bold">Recommended Manifest</div>
                    <img src={featuredItem.imageUrl} alt={entryName(featuredItem)} className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-1000 brightness-[1.15] relative z-10" referrerPolicy="no-referrer" />
                    <div className="text-center mt-12 space-y-3">
                      <p className="text-[10px] uppercase text-white/50 tracking-[0.5em] font-bold font-sans">{entryBrand(featuredItem)}</p>
                      <h4 className="font-serif italic text-3xl sm:text-5xl text-white tracking-tighter">{entryName(featuredItem)}</h4>
                    </div>
                  </motion.div>
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="space-y-32 pb-40">
          {shelves.length > 0 ? shelves.map((shelfItems, shelfIndex) => (
            <div key={shelfIndex} className="relative group/shelf">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-12 gap-y-24 mb-1">
                {shelfItems.map((item, i) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }} transition={{ delay: i * 0.1 }}
                    className="group cursor-pointer relative"
                    onClick={() => openDetail(item)}
                  >
                    <div className="glass-acrylic glass-acrylic-animate rounded-scent transition-all duration-700 group-hover:-translate-y-4 group-hover:shadow-[0_30px_70px_rgba(255,255,255,0.1)] relative overflow-hidden">
                      <div className="aspect-[3/4] p-10 flex flex-col items-center justify-center relative">
                        <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/[0.01] to-white/[0.05] pointer-events-none" />
                        <div className="w-full h-full flex items-center justify-center relative z-10 group-hover:scale-110 transition-transform duration-1000">
                          <img src={item.imageUrl} alt={entryName(item)} className="max-w-full max-h-full w-auto h-auto object-contain brightness-[1.05]" style={{ maxHeight: '100%', maxWidth: '100%' }} referrerPolicy="no-referrer" />
                        </div>
                        <div className="absolute bottom-8 left-8 right-8 text-center opacity-0 group-hover:opacity-100 transition-all duration-500 translate-y-4 group-hover:translate-y-0">
                          <p className="text-[9px] uppercase tracking-widest text-white/60 mb-1 leading-tight">{entryBrand(item)}</p>
                          <h4 className="font-serif italic text-lg text-white leading-tight">{entryName(item)}</h4>
                        </div>
                      </div>
                    </div>
                    <div className="text-center mt-6 space-y-1 transition-opacity duration-500 group-hover:opacity-30">
                      <p className="text-[8px] uppercase text-white/30 tracking-[0.4em] font-bold font-sans">{entryBrand(item)}</p>
                      <h3 className="font-serif italic text-xl text-white leading-tight uppercase tracking-tighter">{entryName(item)}</h3>
                    </div>
                  </motion.div>
                ))}
                {shelfIndex === shelves.length - 1 && shelfItems.length < 4 && (
                  <div className="glass-acrylic rounded-scent aspect-[3/4] flex flex-col items-center justify-center p-8 text-center group cursor-pointer border-dashed border-white/10 hover:bg-white/5 transition-all">
                    <div className="w-12 h-12 border border-dashed border-white/20 flex items-center justify-center group-hover:rotate-90 transition-transform mb-4">
                      <span className="text-white/20 text-3xl">+</span>
                    </div>
                    <p className="font-serif italic text-white/20 text-2xl tracking-tighter uppercase">Expand Archive</p>
                  </div>
                )}
              </div>
            </div>
          )) : !searchQuery && (
            <div className="py-40 text-center border border-dashed border-white/5 rounded-scent">
              <p className="font-serif italic text-4xl text-white/10">The vault is currently vacant</p>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {selectedItem && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeDetail} className="absolute inset-0 bg-black/95 backdrop-blur-3xl" />
            <motion.div
              className="relative w-full h-full sm:h-auto sm:max-h-[88dvh] sm:max-w-4xl sm:mx-6 bg-neutral-900 shadow-2xl sm:rounded-[2rem] overflow-hidden flex flex-col border-0 sm:border border-white/5"
            >
              {/* Pinned header — always visible */}
              <div
                className="flex items-center justify-between px-5 pb-3 shrink-0 border-b border-white/5"
                style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-scent-accent animate-pulse shrink-0" />
                  <p className="text-[9px] uppercase tracking-[0.4em] text-scent-accent font-bold truncate">Intelligence Profile</p>
                </div>
                <button onClick={closeDetail} className="ml-3 shrink-0 p-2 bg-white/5 hover:bg-white/10 transition-all rounded-full border border-white/10 text-white group">
                  <X size={18} className="group-hover:rotate-90 transition-transform duration-300" />
                </button>
              </div>

              {/* Fragrance name — pinned, always readable */}
              <div className="px-5 pt-4 pb-3 shrink-0">
                <h2 className="font-serif italic text-3xl sm:text-6xl leading-tight text-white tracking-tighter uppercase">{entryName(selectedItem)}</h2>
                <p className="text-base text-white/40 font-serif italic mt-1">{entryBrand(selectedItem)}</p>
              </div>

              {/* Scrollable detail body */}
              <div
                className="flex-1 overflow-y-auto scrollbar-hide px-5 pb-4"
                style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
              >
                <div className="space-y-6 sm:space-y-10 pt-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-8 py-5 border-y border-white/5">
                    {[
                      { label: 'Concentration', value: selectedItem.concentration || 'EDP' },
                      { label: 'Environment', value: selectedItem.season },
                      { label: 'Projection', value: `${selectedItem.performance?.sillage || 5}/10` },
                      { label: 'Chronos', value: `${selectedItem.performance?.longevity || 6}/10` },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <p className="text-[9px] uppercase tracking-widest text-white/20 font-bold mb-1">{label}</p>
                        <p className="font-serif italic text-lg sm:text-2xl text-white">{value}</p>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-5">
                    <div className="flex items-center gap-3">
                      <Wind size={14} className="text-white/20 shrink-0" />
                      <p className="text-[10px] uppercase tracking-[0.4em] text-white/40 font-bold">Molecular Hierarchy</p>
                      <div className="flex-1 h-px bg-white/5" />
                    </div>
                    <div className="space-y-4">
                      {(['top', 'heart', 'base'] as const).map((level) => {
                        const notes = selectedItem.pyramid?.[level] || [];
                        if (notes.length === 0) return null;
                        return (
                          <div key={level} className="flex gap-4 items-start">
                            <p className="w-10 text-[9px] uppercase tracking-[0.3em] text-scent-accent font-bold pt-1 shrink-0">{level}</p>
                            <div className="flex flex-wrap gap-x-4 gap-y-2 flex-1">
                              {notes.map(note => (
                                <span key={note} className="text-base sm:text-2xl italic text-white/80 font-serif">{note}</span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {selectedItem.scent_vector && (
                    <div className="space-y-5">
                      <div className="flex items-center gap-3">
                        <ShieldCheck size={14} className="text-white/20 shrink-0" />
                        <p className="text-[10px] uppercase tracking-[0.4em] text-white/40 font-bold">Vector Signature</p>
                        <div className="flex-1 h-px bg-white/5" />
                      </div>
                      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                        {Object.entries(selectedItem.scent_vector).map(([key, value]) => (
                          <div key={key}>
                            <div className="flex justify-between text-[9px] uppercase tracking-widest text-white/20 mb-1.5 font-bold">
                              <span>{key}</span>
                              <span className="text-scent-accent font-mono">{value}/10</span>
                            </div>
                            <div className="h-0.5 bg-white/5 w-full relative overflow-hidden">
                              <motion.div
                                initial={{ x: '-100%' }} animate={{ x: `${-100 + (value as number) * 10}%` }}
                                transition={{ duration: 1, ease: "circOut" }}
                                className="h-full bg-scent-accent absolute inset-0"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Pinned footer — actions always visible */}
              <div
                className="px-5 pt-3 shrink-0 border-t border-white/5 flex flex-col gap-2"
                style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
              >
                {refreshError && (
                  <p className="text-[9px] text-red-400/80 text-center leading-snug px-2 py-1">{refreshError}</p>
                )}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => handleRefreshImage(selectedItem)}
                    disabled={refreshingId === selectedItem.id}
                    aria-label="Refresh bottle image"
                    className="flex-1 py-4 bg-white text-black uppercase tracking-[0.3em] text-[10px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {refreshingId === selectedItem.id ? (
                      <><RefreshCw size={12} className="animate-spin" /> Searching…</>
                    ) : (
                      <><RefreshCw size={12} /> Refresh Image</>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => { onDelete(selectedItem.id); closeDetail(); }}
                    disabled={refreshingId === selectedItem.id}
                    aria-label="Delete from vault"
                    className="px-6 py-4 bg-transparent border border-white/10 text-white/30 uppercase tracking-[0.3em] text-[10px] font-bold hover:border-red-500/50 hover:text-red-500 transition-all flex items-center justify-center gap-2 group disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={14} className="group-hover:animate-bounce" />
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
