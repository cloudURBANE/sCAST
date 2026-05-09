import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, ShieldCheck, Wind, RefreshCw, Undo2, HelpCircle, Eraser, Check, Maximize2, ChevronDown, Search, Star } from 'lucide-react';
import { bottleFeaturedSlotClass } from '@/lib/bottleImageFrame';
import { BottleImage } from '@/components/BottleImage';
import {
  WARDROBE_CLARIFY_SOLVERS,
  WARDROBE_REFRESH_COUNT_STORAGE_KEY,
  type WardrobeImageSolverId,
} from '@/lib/imageRefreshSolvers';
import {
  buildWardrobeSearchSuggestions,
  matchesWardrobeQuery,
  type WardrobeSearchSuggestion,
} from '@/lib/wardrobeSearchSuggest';

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
  /** Postgres row UUID — surfaced by GET /wardrobe; preferred for delete/patch (B9). */
  _dbId?: string;
}

/** Resolve the human-facing name/brand even if the row predates the flat shape. */
function entryName(item: {
  name?: string;
  product?: { name?: string };
}): string {
  return item?.name || item?.product?.name || "";
}
function entryBrand(item: {
  brand?: string;
  product?: { brand?: string };
}): string {
  return item?.brand || item?.product?.brand || "";
}

function entryType(item: Fragrance): string {
  return item.concentration || item.family || "Fragrance";
}

function entryNotes(item: Fragrance): string {
  const notes = item.notes?.filter(Boolean);
  if (notes && notes.length > 0) return notes.join(" • ");
  const pyramidNotes = [
    ...(item.pyramid?.top ?? []),
    ...(item.pyramid?.heart ?? []),
    ...(item.pyramid?.base ?? []),
  ].filter(Boolean);
  return pyramidNotes.length > 0 ? pyramidNotes.slice(0, 5).join(" • ") : "Not specified";
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?.trim()
  .replace(/\/+$/, "");
const REFRESH_IMAGE_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/refresh-image`
  : "/api/refresh-image";

function concentrationHintFromValue(
  value?: string,
): "edt" | "edp" | "parfum" | "extrait" | "elixir" | undefined {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("eau de toilette") || normalized.includes("edt")) return "edt";
  if (normalized.includes("eau de parfum") || normalized.includes("edp")) return "edp";
  if (normalized.includes("extrait") || normalized.includes("extract")) return "extrait";
  if (normalized.includes("elixir")) return "elixir";
  if (normalized.includes("parfum")) return "parfum";
  return undefined;
}

function suggestionPrimaryLine(s: WardrobeSearchSuggestion): string {
  if (s.kind === 'fragrance') return `${entryName(s.item)} — ${entryBrand(s.item)}`;
  return s.label;
}

function SuggestionTypingLabel({ text, animate }: { text: string; animate: boolean }) {
  const [n, setN] = React.useState(animate ? 0 : text.length);
  React.useEffect(() => {
    if (!animate) {
      setN(text.length);
      return;
    }
    setN(0);
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setN(Math.min(i, text.length));
      if (i >= text.length) window.clearInterval(id);
    }, 16);
    return () => window.clearInterval(id);
  }, [text, animate]);
  const slice = text.slice(0, n);
  return (
    <span className="font-sans">
      {slice}
      {animate && n < text.length ? (
        <span
          className="inline-block w-px h-[1cap] ml-px bg-white/55 animate-pulse align-middle translate-y-[-0.06em]"
          aria-hidden
        />
      ) : null}
    </span>
  );
}

export const Wardrobe: React.FC<{
  items: Fragrance[];
  onDelete: (item: Fragrance) => void;
  /** Persist the preview image to the vault row (authenticated). */
  onPersistWardrobeImage?: (item: Fragrance, imageUrl?: string) => Promise<Fragrance | null>;
  featuredItem?: Fragrance | null;
  /** Restore in-memory snapshot after an automatic legacy wardrobe rebuild (this tab only). */
  onRevertWardrobe?: () => void;
  fixWardrobeBusy?: boolean;
  revertAvailable?: boolean;
  wardrobeFixHint?: string | null;
}> = ({
  items,
  onDelete,
  onPersistWardrobeImage,
  featuredItem,
  onRevertWardrobe,
  fixWardrobeBusy,
  revertAvailable,
  wardrobeFixHint,
}) => {
  const [selectedItem, setSelectedItem] = React.useState<Fragrance | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const deferredSearchQuery = React.useDeferredValue(searchQuery);
  
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [refreshCounts, setRefreshCounts] = React.useState<Record<string, number>>(() => {
    if (typeof sessionStorage === 'undefined') return {};
    try {
      const raw = sessionStorage.getItem(WARDROBE_REFRESH_COUNT_STORAGE_KEY);
      if (!raw) return {};
      const o = JSON.parse(raw) as unknown;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
      }
      return out;
    } catch {
      return {};
    }
  });
  const [clarifySolverId, setClarifySolverId] = React.useState<WardrobeImageSolverId | ''>('');
  const [pendingPreview, setPendingPreview] = React.useState<{ itemId: string; url: string } | null>(null);
  const [stripBgBusy, setStripBgBusy] = React.useState(false);
  const [persistBusy, setPersistBusy] = React.useState(false);
  const [vaultSolverBanner, setVaultSolverBanner] = React.useState<string | null>(null);
  const [searchFocused, setSearchFocused] = React.useState(false);
  const [searchHighlightIndex, setSearchHighlightIndex] = React.useState(0);
  const [enlargeOpen, setEnlargeOpen] = React.useState(false);
  const [bottleImageToolsOpen, setBottleImageToolsOpen] = React.useState(false);
  const solverPrefillRef = React.useRef<WardrobeImageSolverId | null>(null);
  const searchBlurTimerRef = React.useRef<number | null>(null);

  const openDetail = React.useCallback((item: Fragrance) => {
    setRefreshError(null);
    setPendingPreview(null);
    setSelectedItem(item);
  }, []);

  const closeDetail = React.useCallback(() => {
    setRefreshError(null);
    setPendingPreview(null);
    setSelectedItem(null);
    setEnlargeOpen(false);
    setBottleImageToolsOpen(false);
  }, []);

  // Modal scroll lock + Escape (enlarge closes first)
  React.useEffect(() => {
    if (!selectedItem) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (enlargeOpen) {
        setEnlargeOpen(false);
        e.preventDefault();
      } else {
        closeDetail();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [selectedItem, enlargeOpen, closeDetail]);

  React.useEffect(() => {
    if (!selectedItem?.id) return;
    const pre = solverPrefillRef.current;
    if (pre) {
      setClarifySolverId(pre);
      solverPrefillRef.current = null;
      setVaultSolverBanner(null);
    } else {
      setClarifySolverId('');
    }
  }, [selectedItem?.id]);

  const handleRefreshImage = async (item: Fragrance, solverId?: WardrobeImageSolverId) => {
    const prev = refreshCounts[item.id] ?? 0;
    if (!solverId && prev > 2) {
      setRefreshError('Too many automatic tries. Choose what looks wrong, then search with a fix.');
      return;
    }
    const nextCount = prev + 1;
    setRefreshCounts((p) => {
      const next = { ...p, [item.id]: nextCount };
      try {
        sessionStorage.setItem(WARDROBE_REFRESH_COUNT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota / privacy mode */
      }
      return next;
    });

    setRefreshingId(item.id);
    setRefreshError(null);
    try {
      const res = await fetch(REFRESH_IMAGE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: entryName(item),
          brand: entryBrand(item),
          concentrationHint: concentrationHintFromValue(item.concentration),
          refreshCount: nextCount,
          ...(solverId ? { solverId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Refresh failed');
      setPendingPreview({ itemId: item.id, url: data.imageUrl });
    } catch (err: any) {
      setRefreshError(err.message || 'Image refresh failed');
    } finally {
      setRefreshingId(null);
    }
  };

  const handleStripBackground = async (item: Fragrance) => {
    const src =
      pendingPreview?.itemId === item.id ? pendingPreview.url : item.imageUrl;
    if (!src?.trim()) {
      setRefreshError('No image to process.');
      return;
    }
    setStripBgBusy(true);
    setRefreshError(null);
    try {
      const res = await fetch(REFRESH_IMAGE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: entryName(item),
          brand: entryBrand(item),
          concentrationHint: concentrationHintFromValue(item.concentration),
          stripBgOnly: true,
          imageUrl: src,
          poofOptions: { type: 'product' },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Background removal failed');
      setPendingPreview({ itemId: item.id, url: data.imageUrl });
    } catch (err: any) {
      setRefreshError(err.message || 'Background removal failed');
    } finally {
      setStripBgBusy(false);
    }
  };

  const handleSavePreviewToVault = async () => {
    if (!selectedItem || !pendingPreview || pendingPreview.itemId !== selectedItem.id) return;
    if (!onPersistWardrobeImage) {
      setRefreshError('Sign in to save this image to your vault.');
      return;
    }
    setPersistBusy(true);
    setRefreshError(null);
    try {
      const merged = await onPersistWardrobeImage(selectedItem, pendingPreview.url);
      if (!merged) throw new Error('Could not save — try again or check your connection.');
      closeDetail();
    } catch (err: any) {
      setRefreshError(err.message || 'Save failed');
    } finally {
      setPersistBusy(false);
    }
  };

  // Performance Optimization: Memoize computationally heavy filter operations
  const filteredItems = React.useMemo(() => {
    const q = deferredSearchQuery.trim();
    if (!q) return items;
    return items.filter(item => {
      const name = entryName(item);
      const brand = entryBrand(item);
      if (!name || !brand) return false;

      return matchesWardrobeQuery(item, q);
    });
  }, [items, deferredSearchQuery]);

  const searchSuggestions = React.useMemo(
    () => buildWardrobeSearchSuggestions(items, deferredSearchQuery),
    [items, deferredSearchQuery],
  );

  React.useEffect(() => {
    setSearchHighlightIndex(0);
  }, [searchQuery, searchSuggestions.length]);

  const applySearchSuggestion = React.useCallback((s: WardrobeSearchSuggestion) => {
    if (s.kind === 'fragrance') {
      const nm = entryName(s.item);
      const br = entryBrand(s.item);
      setSearchQuery(`${br} ${nm}`.trim());
      setSearchFocused(false);
      setRefreshError(null);
      setPendingPreview(null);
      setSelectedItem(s.item as Fragrance);
    } else {
      solverPrefillRef.current = s.id;
      setVaultSolverBanner(`Next profile: image hint — ${s.label}`);
      setSearchQuery('');
      setSearchFocused(false);
    }
  }, []);

  // Performance Optimization: Memoize shelf chunking
  const shelves = React.useMemo(() => {
    const itemsPerShelf = 4;
    const chunked = [];
    for (let i = 0; i < filteredItems.length; i += itemsPerShelf) {
      chunked.push(filteredItems.slice(i, i + itemsPerShelf));
    }
    return chunked;
  }, [filteredItems]);

  const detailNeedsClarify =
    selectedItem !== null && (refreshCounts[selectedItem.id] ?? 0) > 2;

  const detailBottleUrl =
    selectedItem && pendingPreview?.itemId === selectedItem.id
      ? pendingPreview.url
      : selectedItem?.imageUrl ?? '';

  const imageToolbarBusy =
    !!selectedItem &&
    (refreshingId === selectedItem.id || stripBgBusy || persistBusy);

  const hasPendingPreview =
    !!selectedItem && !!pendingPreview && pendingPreview.itemId === selectedItem.id;

  React.useEffect(() => {
    setBottleImageToolsOpen(false);
  }, [selectedItem?.id]);

  React.useEffect(() => {
    if (hasPendingPreview) setBottleImageToolsOpen(true);
  }, [hasPendingPreview]);

  const searchDropdownOpen =
    searchFocused && searchQuery.trim().length > 0 && searchSuggestions.length > 0;

  const cancelSearchBlur = () => {
    if (searchBlurTimerRef.current !== null) {
      window.clearTimeout(searchBlurTimerRef.current);
      searchBlurTimerRef.current = null;
    }
  };

  const scheduleSearchBlur = () => {
    cancelSearchBlur();
    searchBlurTimerRef.current = window.setTimeout(() => {
      setSearchFocused(false);
      searchBlurTimerRef.current = null;
    }, 160);
  };

  return (
    <div className="relative">
      <div className="space-y-12 sm:space-y-16 relative z-10">
        <div className="flex flex-col items-center justify-center text-center gap-7 sm:gap-8">
          <div className="space-y-3">
            <p className="text-[11px] uppercase tracking-[0.28em] text-scent-accent/82 font-bold">Archives // Private Vault</p>
            <h2 className="font-serif italic text-[clamp(2.65rem,8vw,5.35rem)] text-[#fff7ec] tracking-normal leading-none">Vault of Aromas</h2>
          </div>
          <div className="flex flex-col items-center gap-6 w-full">
            {(wardrobeFixHint || revertAvailable || fixWardrobeBusy) && (
              <div className="flex flex-col items-center gap-3 w-full max-w-2xl">
                {onRevertWardrobe ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={onRevertWardrobe}
                      disabled={!revertAvailable || !!fixWardrobeBusy}
                      title="Restore the vault list from before the last automatic rebuild (this tab only)"
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 bg-white/[0.04] text-white/70 text-[10px] uppercase tracking-[0.2em] font-bold hover:bg-white/[0.08] hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Undo2 size={14} />
                      Revert
                    </button>
                  </div>
                ) : null}
                {fixWardrobeBusy ? (
                  <p className="text-[11px] text-amber-100/70 font-sans text-center leading-snug max-w-xl px-2">
                    Rebuilding wardrobe…
                  </p>
                ) : null}
                {wardrobeFixHint ? (
                  <p className="text-[11px] text-white/45 font-sans text-center leading-snug max-w-xl px-2">
                    {wardrobeFixHint}
                  </p>
                ) : null}
              </div>
            )}
            <div className="relative w-full max-w-[56rem] z-20">
              <label htmlFor="wardrobe-vault-search" className="sr-only">
                Search vault fragrances and image hints
              </label>
              <Search size={23} strokeWidth={1.5} className="pointer-events-none absolute left-5 sm:left-6 top-1/2 z-10 -translate-y-1/2 text-scent-accent/82" />
              <input
                id="wardrobe-vault-search"
                type="text"
                role="combobox"
                aria-expanded={searchDropdownOpen}
                aria-controls="wardrobe-search-suggestions"
                aria-autocomplete="list"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => {
                  cancelSearchBlur();
                  setSearchFocused(true);
                }}
                onBlur={scheduleSearchBlur}
                onKeyDown={(e) => {
                  if (!searchDropdownOpen) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSearchHighlightIndex((i) =>
                      Math.min(i + 1, Math.max(0, searchSuggestions.length - 1)),
                    );
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSearchHighlightIndex((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const pick = searchSuggestions[searchHighlightIndex];
                    if (pick) applySearchSuggestion(pick);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearchFocused(false);
                  }
                }}
                placeholder="Search vault or image hint (e.g. watermark, sauvage)…"
                autoComplete="off"
                className="scent-lux-input w-full h-[58px] sm:h-[68px] pl-14 sm:pl-16 pr-5 sm:pr-6 text-[#fff7ec] font-sans text-[15px] sm:text-base outline-none transition-all placeholder:text-[#d9c2a4]/58"
              />
              <AnimatePresence>
                {searchDropdownOpen ? (
                  <motion.ul
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18 }}
                    id="wardrobe-search-suggestions"
                    role="listbox"
                    className="absolute left-0 right-0 top-full mt-2 max-h-[min(320px,50vh)] overflow-y-auto rounded-[var(--radius-scent)] border border-scent-accent/32 bg-neutral-950/98 shadow-[0_24px_48px_rgba(0,0,0,0.78)] backdrop-blur-xl scrollbar-hide z-30"
                  >
                    <li className="px-3 py-2 border-b border-white/8 pointer-events-none">
                      <p className="text-[8px] uppercase tracking-[0.35em] text-white/35 font-bold font-sans">
                        Matches
                      </p>
                    </li>
                    {searchSuggestions.map((sug, idx) => {
                      const active = idx === searchHighlightIndex;
                      const primary = suggestionPrimaryLine(sug);
                      const sub =
                        sug.kind === 'solver'
                          ? 'Image search tuning — Find image uses this hint'
                          : [sug.item.family, ...(sug.item.notes ?? []).slice(0, 2)]
                              .filter(Boolean)
                              .join(' · ');
                      return (
                        <li key={`${sug.kind}-${sug.kind === 'fragrance' ? sug.item.id : sug.id}`} role="none">
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`w-full text-left px-3 py-2.5 transition-colors border-b border-white/[0.06] last:border-b-0 ${
                              active ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'
                            }`}
                            onMouseEnter={() => setSearchHighlightIndex(idx)}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              cancelSearchBlur();
                              applySearchSuggestion(sug);
                            }}
                          >
                            <div className="text-[13px] text-white/92 leading-snug">
                              <SuggestionTypingLabel text={primary} animate={active} />
                            </div>
                            {sub ? (
                              <div className="text-[10px] text-white/40 mt-0.5 font-sans truncate">{sub}</div>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </motion.ul>
                ) : null}
              </AnimatePresence>
              {vaultSolverBanner ? (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-scent-accent/35 bg-scent-accent/10 px-3 py-2.5 text-left">
                  <p className="flex-1 text-[11px] text-white/80 font-sans leading-snug">{vaultSolverBanner}</p>
                  <button
                    type="button"
                    onClick={() => setVaultSolverBanner(null)}
                    className="shrink-0 text-[10px] uppercase tracking-widest text-white/45 hover:text-white px-1"
                    aria-label="Dismiss hint"
                  >
                    ✕
                  </button>
                </div>
              ) : null}
            </div>
            <div className="scent-entry-count font-serif italic text-xl sm:text-2xl whitespace-nowrap">
              <span>{filteredItems.length} Entries</span>
            </div>
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
                    className="glass-acrylic glass-acrylic-animate rounded-scent p-20 aspect-[3/4] flex flex-col items-center relative overflow-hidden cursor-pointer"
                    onClick={() => setSelectedItem(featuredItem)}
                  >
                    <div className="absolute top-10 left-10 text-[9px] uppercase tracking-[0.6em] text-white/30 font-bold z-20 pointer-events-none">Recommended Manifest</div>
                    <div className={bottleFeaturedSlotClass()}>
                      <BottleImage
                        variant="featured"
                        src={featuredItem.imageUrl}
                        alt={entryName(featuredItem)}
                        className="min-h-0 w-full flex-1"
                        imgClassName="group-hover:scale-105 transition-transform duration-1000 brightness-[1.15]"
                        loading="eager"
                      />
                    </div>
                    <div className="text-center mt-4 mb-2 space-y-3 shrink-0 px-2">
                      <p className="text-[10px] uppercase text-white/50 tracking-[0.5em] font-bold font-sans">{entryBrand(featuredItem)}</p>
                      <h4 className="font-serif italic text-3xl sm:text-5xl text-white tracking-tighter">{entryName(featuredItem)}</h4>
                    </div>
                  </motion.div>
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="space-y-8 pb-28 sm:pb-36">
          {shelves.length > 0 ? shelves.map((shelfItems, shelfIndex) => (
            <div key={shelfIndex} className="relative group/shelf">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 lg:gap-6 mb-1">
                {shelfItems.map((item, i) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }} transition={{ delay: i * 0.1 }}
                    className="group cursor-pointer relative h-full"
                    onClick={() => openDetail(item)}
                  >
                    <div className="scent-fragrance-card h-full min-h-[31rem] transition-transform duration-500 group-hover:-translate-y-1.5 relative overflow-hidden p-4 sm:p-5 flex flex-col">
                      <div className="scent-card-star absolute right-4 top-4 z-20 flex h-9 w-9 items-center justify-center rounded-full" aria-hidden>
                        <Star size={20} strokeWidth={1.45} />
                      </div>
                      <div className="aspect-[1.08/1] relative mb-5 overflow-hidden rounded-[calc(var(--radius-scent)-8px)]">
                        <div className="scent-bottle-stage absolute inset-0 pointer-events-none" />
                        <BottleImage
                          variant="grid"
                          src={item.imageUrl}
                          alt={entryName(item)}
                          className="absolute inset-0 z-10"
                          imgClassName="brightness-[1.08] group-hover:scale-[1.035] transition-transform duration-700"
                        />
                      </div>
                      <div className="space-y-2 px-1 pb-1 flex flex-1 flex-col">
                        <p className="scent-card-brand">{entryBrand(item)}</p>
                        <h3 className="scent-card-title">{entryName(item)}</h3>
                        <p className="scent-card-type">{entryType(item)}</p>
                        <div className="h-px w-full bg-scent-accent/18 my-4" />
                        <p className="scent-card-notes">
                          <span className="font-semibold text-amber-200/85">Notes:</span> {entryNotes(item)}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                ))}
                {shelfIndex === shelves.length - 1 && shelfItems.length < 4 && (
                  <div className="scent-fragrance-card min-h-[28rem] flex flex-col items-center justify-center p-8 text-center group cursor-pointer border-dashed border-scent-accent/26 hover:bg-white/5 transition-all">
                    <div className="w-12 h-12 border border-dashed border-scent-accent/35 flex items-center justify-center group-hover:rotate-90 transition-transform mb-4 rounded-full">
                      <span className="text-scent-accent/55 text-3xl">+</span>
                    </div>
                    <p className="font-serif italic text-scent-accent/45 text-2xl tracking-tighter uppercase">Expand Archive</p>
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
          <div 
            className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fragrance-detail-title"
          >
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
                <button 
                  onClick={closeDetail} 
                  aria-label="Close profile"
                  className="ml-3 shrink-0 p-2 bg-white/5 hover:bg-white/10 transition-all rounded-full border border-white/10 text-white group"
                >
                  <X size={18} className="group-hover:rotate-90 transition-transform duration-300" />
                </button>
              </div>

              {/* Fragrance name — pinned, always readable */}
              <div className="px-5 pt-4 pb-3 shrink-0">
                <h2 id="fragrance-detail-title" className="font-serif italic text-3xl sm:text-6xl leading-tight text-white tracking-tighter uppercase">{entryName(selectedItem)}</h2>
                <p className="text-base text-white/40 font-serif italic mt-1">{entryBrand(selectedItem)}</p>
              </div>

              {/* Scrollable detail body */}
              <div
                className="flex-1 overflow-y-auto scrollbar-hide px-5 pb-4"
                style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
              >
                <div className="space-y-6 sm:space-y-10 pt-2">
                    <div className="border border-white/10 bg-white/[0.02] p-4 sm:p-6">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <p className="text-[9px] uppercase tracking-[0.35em] text-white/30 font-bold">Bottle Visual</p>
                      {detailBottleUrl ? (
                        <button
                          type="button"
                          onClick={() => setEnlargeOpen(true)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-white/12 bg-white/[0.06] text-[9px] uppercase tracking-[0.2em] font-bold text-white/65 hover:bg-white/[0.1] hover:text-white transition-colors"
                          aria-label="Enlarge bottle image"
                        >
                          <Maximize2 size={13} strokeWidth={2} />
                          Enlarge
                        </button>
                      ) : null}
                    </div>
                    <div className="relative h-48 sm:h-64 overflow-hidden rounded-sm">
                      <BottleImage
                        key={detailBottleUrl || 'missing-image'}
                        variant="detail"
                        src={detailBottleUrl}
                        alt={entryName(selectedItem)}
                        className="absolute inset-0"
                        imgClassName="transition-all duration-300"
                      />
                    </div>
                  </div>

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

              {/* Pinned footer — bottle tools + delete */}
              <div
                className="px-5 pt-3 shrink-0 border-t border-white/5 flex flex-col gap-3"
                style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
              >
                {refreshError && (
                  <p className="text-[9px] text-red-400/80 text-center leading-snug px-2 py-1">{refreshError}</p>
                )}

                <div
                  className={`rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 ${bottleImageToolsOpen ? 'space-y-3' : ''}`}
                >
                  <button
                    type="button"
                    id="wardrobe-bottle-tools-trigger"
                    aria-expanded={bottleImageToolsOpen}
                    aria-controls="wardrobe-bottle-tools-panel"
                    onClick={() => setBottleImageToolsOpen((o) => !o)}
                    className="w-full flex items-start gap-2 text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-white/[0.04] transition-colors"
                  >
                    <HelpCircle size={14} className="text-white/35 shrink-0 mt-0.5" aria-hidden />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-[9px] uppercase tracking-[0.28em] text-white/45 font-bold">Bottle image</p>
                      {!bottleImageToolsOpen ? (
                        <p
                          className={`text-[10px] leading-snug font-sans ${
                            detailNeedsClarify ? 'text-amber-200/75' : 'text-white/40'
                          }`}
                        >
                          {detailNeedsClarify
                            ? 'Automatic search paused — expand to pick a hint or strip the background.'
                            : 'Expand to find a new image, remove background, or save a preview.'}
                        </p>
                      ) : null}
                    </div>
                    <ChevronDown
                      size={16}
                      className={`text-white/35 shrink-0 mt-0.5 transition-transform duration-200 ${
                        bottleImageToolsOpen ? 'rotate-180' : ''
                      }`}
                      aria-hidden
                    />
                  </button>

                  {bottleImageToolsOpen ? (
                    <div
                      id="wardrobe-bottle-tools-panel"
                      role="region"
                      aria-labelledby="wardrobe-bottle-tools-trigger"
                      className="space-y-3"
                    >
                      {detailNeedsClarify ? (
                        <p className="text-[10px] text-amber-200/75 leading-snug font-sans">
                          Automatic search paused after several tries — pick what looks wrong, then search again or strip the background.
                        </p>
                      ) : (
                        <p className="text-[10px] text-white/40 leading-snug font-sans">
                          Search with an optional issue hint; remove background on the preview; save when it looks right.
                        </p>
                      )}

                      <label htmlFor="wardrobe-clarify-solver" className="sr-only">
                        Search tuning for bottle image
                      </label>
                      <select
                        id="wardrobe-clarify-solver"
                        value={clarifySolverId}
                        onChange={(e) =>
                          setClarifySolverId((e.target.value || '') as WardrobeImageSolverId | '')
                        }
                        disabled={imageToolbarBusy}
                        className="w-full bg-black/45 border border-white/12 text-white text-[11px] py-2.5 px-2 rounded-lg font-sans outline-none focus:border-scent-accent/50 disabled:opacity-40"
                      >
                        {!detailNeedsClarify ? (
                          <option value="">Automatic search</option>
                        ) : (
                          <option value="">Choose what looks wrong…</option>
                        )}
                        {WARDROBE_CLARIFY_SOLVERS.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void handleRefreshImage(selectedItem, clarifySolverId || undefined)
                          }
                          disabled={
                            imageToolbarBusy ||
                            (detailNeedsClarify && !clarifySolverId)
                          }
                          title={
                            detailNeedsClarify && !clarifySolverId
                              ? 'Select an issue first'
                              : undefined
                          }
                          className="flex-1 min-h-[44px] py-3 bg-white text-black uppercase tracking-[0.22em] text-[10px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-45 disabled:cursor-not-allowed rounded-lg"
                        >
                          {refreshingId === selectedItem.id ? (
                            <>
                              <RefreshCw size={12} className="animate-spin" /> Searching…
                            </>
                          ) : (
                            <>
                              <RefreshCw size={12} /> Find image
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleStripBackground(selectedItem)}
                          disabled={
                            imageToolbarBusy || !detailBottleUrl?.trim()
                          }
                          title={
                            !detailBottleUrl?.trim()
                              ? 'Need an image first'
                              : 'Run AI background removal on the preview'
                          }
                          className="flex-1 min-h-[44px] py-3 bg-white/[0.06] text-white uppercase tracking-[0.18em] text-[10px] font-bold border border-white/15 hover:bg-white/[0.1] active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-35 disabled:cursor-not-allowed rounded-lg"
                        >
                          {stripBgBusy ? (
                            <>
                              <RefreshCw size={12} className="animate-spin" /> Stripping…
                            </>
                          ) : (
                            <>
                              <Eraser size={12} /> Remove BG
                            </>
                          )}
                        </button>
                      </div>

                      {hasPendingPreview && (
                        <div className="flex flex-col gap-2 pt-1 border-t border-white/8">
                          {!onPersistWardrobeImage ? (
                            <p className="text-[10px] text-amber-200/75 text-center font-sans leading-snug px-1">
                              Sign in to save this preview to your vault.
                            </p>
                          ) : null}
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSavePreviewToVault()}
                              disabled={persistBusy || !onPersistWardrobeImage}
                              title={
                                !onPersistWardrobeImage
                                  ? 'Sign in to save to your vault'
                                  : undefined
                              }
                              className="flex-1 min-h-[44px] py-3 bg-scent-accent text-black uppercase tracking-[0.2em] text-[10px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg"
                            >
                              {persistBusy ? (
                                <>
                                  <RefreshCw size={12} className="animate-spin" /> Saving…
                                </>
                              ) : (
                                <>
                                  <Check size={12} /> Save to vault
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingPreview(null)}
                              disabled={persistBusy}
                              className="flex-1 min-h-[44px] py-3 bg-transparent text-white/50 uppercase tracking-[0.18em] text-[10px] font-bold border border-white/12 hover:bg-white/[0.05] hover:text-white/80 rounded-lg disabled:opacity-30"
                            >
                              Discard preview
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    onDelete(selectedItem);
                    closeDetail();
                  }}
                  disabled={imageToolbarBusy}
                  aria-label="Delete from vault"
                  className="w-full py-3.5 bg-transparent border border-white/10 text-white/35 uppercase tracking-[0.28em] text-[10px] font-bold hover:border-red-500/45 hover:text-red-400 transition-all flex items-center justify-center gap-2 group disabled:opacity-25 disabled:cursor-not-allowed rounded-lg"
                >
                  <Trash2 size={14} className="group-hover:animate-bounce" />
                  Delete from vault
                </button>
              </div>
            </motion.div>
            <AnimatePresence>
              {enlargeOpen && detailBottleUrl ? (
                <motion.div
                  key="bottle-enlarge"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Enlarged bottle image"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="fixed inset-0 z-[130] flex flex-col items-center justify-center bg-black/93 px-4 py-12"
                  onClick={() => setEnlargeOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => setEnlargeOpen(false)}
                    className="absolute top-4 right-4 z-10 p-2 rounded-full border border-white/15 bg-white/10 text-white hover:bg-white/20 transition-colors"
                    aria-label="Close enlarged view"
                  >
                    <X size={22} />
                  </button>
                  <div
                    className="relative w-full max-w-[min(100%,28rem)] aspect-[3/4] max-h-[78dvh] min-h-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <BottleImage
                      variant="grid"
                      src={detailBottleUrl}
                      alt={entryName(selectedItem)}
                      className="absolute inset-0"
                      imgClassName="brightness-[1.08] scale-[1.02]"
                      loading="eager"
                    />
                  </div>
                  <p className="mt-5 text-[10px] uppercase tracking-[0.35em] text-white/35 font-bold font-sans">
                    Tap outside or Esc to close
                  </p>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
