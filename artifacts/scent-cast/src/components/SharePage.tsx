import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Wind, ShoppingBag, ShieldCheck, Wind as WindIcon } from 'lucide-react';
import { LavaBackground } from './LavaBackground';
import { BottleImage } from '@/components/BottleImage';

interface ScentVector {
  freshness: number;
  sweetness: number;
  woodiness: number;
  spice: number;
  warmth: number;
  musk: number;
}

interface Fragrance {
  id: string;
  _dbId?: string;
  name: string;
  brand: string;
  imageUrl: string;
  season?: string;
  notes?: string[];
  concentration?: string;
  scent_vector?: ScentVector;
  family?: string;
  performance?: { sillage: number; longevity: number };
  pyramid?: { top: string[]; heart: string[]; base: string[] };
}

interface ShareData {
  fragrances: Fragrance[];
  hideImages: boolean;
}

interface BuyLink {
  buyUrl: string | null;
  provider: string;
  status: string;
}

export const SharePage: React.FC<{ userId: string }> = ({ userId }) => {
  const [data, setData] = useState<ShareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [buyLinks, setBuyLinks] = useState<Record<string, BuyLink>>({});

  useEffect(() => {
    setBuyLinks({});
    fetch(`/api/share/${userId}`)
      .then(async (r) => {
        return r.json();
      })
      .then(d => {
        if (d.error) throw new Error(d.error);
        setData(d);

        const fragranceIds = Array.isArray(d.fragrances)
          ? d.fragrances.map((item: Fragrance) => item._dbId ?? item.id).filter(Boolean)
          : [];

        if (fragranceIds.length) {
          Promise.all(
            fragranceIds.map(async (fragranceId: string) => {
              try {
                const response = await fetch(`/api/fragrances/${encodeURIComponent(fragranceId)}/buy-link`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const buyLink = await response.json();
                return [fragranceId, buyLink] as const;
              } catch {
                return [fragranceId, { provider: 'cj', buyUrl: null, status: 'unavailable' }] as const;
              }
            })
          ).then(entries => {
            setBuyLinks(Object.fromEntries(entries));
          }).catch(() => {});
        } else {
          setBuyLinks({});
        }
      })
      .catch(e => {
        setError(e.message || 'Failed to load vault');
      })
      .finally(() => setLoading(false));
  }, [userId]);

  return (
    <div className="min-h-[100svh] bg-black text-white relative overflow-x-hidden">
      <LavaBackground />

      <nav className="fixed top-0 left-0 right-0 h-24 border-b border-white/5 bg-black/40 backdrop-blur-2xl z-50 px-8">
        <div className="max-w-[1400px] mx-auto h-full flex items-center justify-center">
          <a
            href="/"
            aria-label="Back to dashboard"
            className="flex items-center gap-2 text-white hover:opacity-85 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-white/30 rounded-sm"
          >
            <Wind size={24} strokeWidth={1} className="text-white shrink-0" aria-hidden />
            <span className="font-serif text-2xl italic tracking-tighter uppercase">Scent Cast</span>
          </a>
        </div>
      </nav>

      <div className="pt-24" />

      <main className="px-8 max-w-[1400px] mx-auto py-24">
        {loading && (
          <div className="flex items-center justify-center py-40">
            <p className="font-serif italic text-white/30 text-3xl animate-pulse">Loading vault...</p>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center py-40">
            <p className="font-serif italic text-red-400/60 text-2xl">{error}</p>
          </div>
        )}

        {data && (
          <div className="space-y-24">
            <div className="text-center space-y-4 border-b border-white/5 pb-16">
              <p className="text-[10px] uppercase tracking-[0.6em] text-white/40 font-bold">Shared Vault</p>
              <h2 className="font-serif italic text-5xl sm:text-7xl text-white tracking-tighter">Vault of Aromas</h2>
              <p className="text-white/30 font-sans text-sm">{data.fragrances.length} fragrance{data.fragrances.length !== 1 ? 's' : ''} archived</p>
              {data.hideImages ? (
                <p className="text-[10px] uppercase tracking-[0.3em] text-amber-200/65 font-bold">
                  Owner currently hides bottle images on public view
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {data.fragrances.map((item, i) => {
                const fragranceId = item._dbId ?? item.id;
                const buyLink = buyLinks[fragranceId];
                const buyUrl = buyLink?.status === 'active' ? buyLink.buyUrl : null;

                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="group"
                  >
                  <div
                    className="glass-acrylic rounded-scent overflow-hidden cursor-pointer transition-all duration-500 hover:-translate-y-2 hover:shadow-[0_20px_50px_rgba(255,255,255,0.08)]"
                    onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                  >
                    {!data.hideImages && (
                      <div className="relative aspect-[3/4] bg-white/[0.02]">
                        {item.imageUrl ? (
                          <BottleImage
                            variant="share"
                            src={item.imageUrl}
                            alt={item.name}
                            className="absolute inset-0"
                            imgClassName="brightness-[1.05] group-hover:scale-105 transition-transform duration-700"
                          />
                        ) : (
                          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                            <p className="text-[9px] uppercase tracking-[0.5em] text-white/20 font-bold">{item.brand}</p>
                            <p className="font-serif italic text-2xl text-white leading-tight">{item.name}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {data.hideImages && (
                      <div className="aspect-[3/4] flex items-center justify-center bg-white/[0.02]">
                        <div className="text-center space-y-2 px-6">
                          <p className="text-[9px] uppercase tracking-[0.5em] text-white/20 font-bold">{item.brand}</p>
                          <p className="font-serif italic text-2xl text-white leading-tight">{item.name}</p>
                        </div>
                      </div>
                    )}

                    <div className="px-5 pb-5 space-y-3">
                      <div>
                        <p className="text-[9px] uppercase tracking-[0.4em] text-white/30 font-bold">{item.brand}</p>
                        <h3 className="font-serif italic text-xl text-white leading-tight">{item.name}</h3>
                        {item.family && (
                          <p className="text-[9px] uppercase tracking-widest text-white/20 mt-1">{item.family}</p>
                        )}
                      </div>

                      {expanded === item.id && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="space-y-4 pt-2 border-t border-white/5"
                        >
                          {item.concentration && (
                            <p className="text-[9px] uppercase tracking-widest text-scent-accent/70">{item.concentration}</p>
                          )}

                          {item.scent_vector && (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <ShieldCheck size={10} className="text-white/20" />
                                <p className="text-[8px] uppercase tracking-[0.4em] text-white/30 font-bold">Vector Signature</p>
                              </div>
                              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                {Object.entries(item.scent_vector).map(([key, value]) => (
                                  <div key={key}>
                                    <div className="flex justify-between text-[8px] uppercase tracking-widest text-white/20 mb-1 font-bold">
                                      <span>{key}</span>
                                      <span className="text-scent-accent font-mono">{value}/10</span>
                                    </div>
                                    <div className="h-px bg-white/5 w-full relative overflow-hidden">
                                      <motion.div
                                        initial={{ x: '-100%' }}
                                        animate={{ x: `${-100 + (value as number) * 10}%` }}
                                        transition={{ duration: 0.8, ease: 'circOut' }}
                                        className="h-full bg-scent-accent absolute inset-0"
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {item.pyramid && (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <WindIcon size={10} className="text-white/20" />
                                <p className="text-[8px] uppercase tracking-[0.4em] text-white/30 font-bold">Notes</p>
                              </div>
                              {(['top', 'heart', 'base'] as const).map(level => {
                                const notes = item.pyramid?.[level] || [];
                                if (!notes.length) return null;
                                return (
                                  <div key={level} className="flex gap-3 items-start">
                                    <p className="w-8 text-[8px] uppercase tracking-[0.3em] text-scent-accent font-bold pt-0.5 shrink-0">{level}</p>
                                    <p className="text-sm italic text-white/60 font-serif">{notes.join(', ')}</p>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {item.performance && (
                            <div className="grid grid-cols-2 gap-3 text-center border-t border-white/5 pt-3">
                              <div>
                                <p className="text-[8px] uppercase tracking-widest text-white/20 font-bold mb-0.5">Projection</p>
                                <p className="font-serif italic text-white text-lg">{item.performance.sillage}/10</p>
                              </div>
                              <div>
                                <p className="text-[8px] uppercase tracking-widest text-white/20 font-bold mb-0.5">Longevity</p>
                                <p className="font-serif italic text-white text-lg">{item.performance.longevity}/10</p>
                              </div>
                            </div>
                          )}
                        </motion.div>
                      )}

                      <div className="space-y-2" onClick={e => e.stopPropagation()}>
                        {buyUrl ? (
                          <a
                            href={buyUrl}
                            target="_blank"
                            rel="nofollow sponsored noopener"
                            onClick={e => e.stopPropagation()}
                            className="flex items-center justify-center gap-2 w-full py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 transition-all text-[9px] uppercase tracking-[0.35em] text-white/50 hover:text-white font-bold"
                          >
                            <ShoppingBag size={10} />
                            Buy Now
                          </a>
                        ) : (
                          <button
                            type="button"
                            disabled
                            onClick={e => e.stopPropagation()}
                            className="flex items-center justify-center gap-2 w-full py-2.5 bg-white/[0.02] border border-white/5 text-[9px] uppercase tracking-[0.28em] text-white/25 font-bold cursor-not-allowed"
                          >
                            <ShoppingBag size={10} />
                            Buying options unavailable
                          </button>
                        )}
                        <p className="text-[9px] leading-relaxed text-white/25 font-sans">
                          Scent Cast may earn a commission from purchases made through this link.
                        </p>
                      </div>
                    </div>
                  </div>
                  </motion.div>
                );
              })}
            </div>

            <div className="text-center pt-16 border-t border-white/5">
              <p className="text-[9px] uppercase tracking-[0.4em] text-white/20 font-bold mb-3">Powered by</p>
              <div className="flex items-center justify-center gap-2 text-white/30">
                <Wind size={16} strokeWidth={1} />
                <span className="font-serif italic text-lg tracking-tighter uppercase">Scent Cast</span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
