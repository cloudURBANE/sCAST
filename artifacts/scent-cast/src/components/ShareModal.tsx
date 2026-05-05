import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Link, Check, Eye, EyeOff, ExternalLink, Search } from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';

interface FragranceItem {
  id: string;
  name: string;
  brand: string;
  imageUrl?: string;
  shareHidden?: boolean;
  /** DB row UUID, preferred for visibility PATCH (B9). */
  _dbId?: string;
}

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string | null;
  authToken: string | null;
  items: FragranceItem[];
  onToggleVisibility: (id: string, hidden: boolean) => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  isOpen,
  onClose,
  userId,
  authToken,
  items = [],
  onToggleVisibility,
}) => {
  const [copied, setCopied] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [hideImages, setHideImages] = useState(false);
  const [hideImagesBusy, setHideImagesBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const shareUrl = userId ? `${window.location.origin}/share/${userId}` : '';

  const visibleCount = items.filter(i => !i.shareHidden).length;

  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setTimeout(() => searchRef.current?.focus(), 150);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !authToken) return;
    let cancelled = false;
    fetch('/api/share-settings', {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setHideImages(Boolean(d?.hideImages));
      })
      .catch(() => {
        if (cancelled) return;
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, authToken]);

  const filtered = items.filter(item => {
    if (!item?.name || !item?.brand) return false;
    const q = search.toLowerCase();
    return (
      item.name.toLowerCase().includes(q) ||
      item.brand.toLowerCase().includes(q)
    );
  });

  const handleToggle = async (item: FragranceItem) => {
    const newHidden = !item.shareHidden;
    const apiId = item._dbId ?? item.id;
    setPendingIds(prev => new Set(prev).add(item.id));
    onToggleVisibility(item.id, newHidden);
    try {
      await fetch(`/api/wardrobe/${apiId}/visibility`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ shareHidden: newHidden }),
      });
    } catch {
    } finally {
      setPendingIds(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleToggleImagesOnSharePage = async () => {
    if (!authToken || hideImagesBusy) return;
    const next = !hideImages;
    setHideImages(next);
    setHideImagesBusy(true);
    try {
      const res = await fetch('/api/share-settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ hideImages: next }),
      });
      if (!res.ok) throw new Error('Failed to update image visibility');
    } catch {
      setHideImages(!next);
    } finally {
      setHideImagesBusy(false);
    }
  };

  const handleHideAll = async () => {
    const visible = items.filter(i => !i.shareHidden);
    for (const item of visible) {
      await handleToggle(item);
    }
  };

  const handleShowAll = async () => {
    const hidden = items.filter(i => i.shareHidden);
    for (const item of hidden) {
      await handleToggle(item);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/90 backdrop-blur-2xl"
          />
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full sm:max-w-lg mx-0 sm:mx-6 bg-neutral-950 border-t sm:border border-white/10 sm:rounded-[1.5rem] overflow-hidden shadow-2xl flex flex-col"
            style={{ maxHeight: '90dvh' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/5 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-1.5 h-1.5 rounded-full bg-scent-accent animate-pulse shrink-0" />
                <div className="min-w-0">
                  <p className="text-[9px] uppercase tracking-[0.5em] text-scent-accent font-bold">Share Vault</p>
                  <p className="text-[9px] text-white/25 mt-0.5 font-sans">
                    {visibleCount} of {items.length} visible
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 bg-white/5 hover:bg-white/10 transition-all rounded-full border border-white/10 text-white group shrink-0 ml-3"
              >
                <X size={16} className="group-hover:rotate-90 transition-transform duration-300" />
              </button>
            </div>

            {/* Link row */}
            <div className="px-6 pt-5 pb-4 shrink-0 space-y-3 border-b border-white/5">
              <div className="flex gap-2">
                <div className="flex-1 bg-white/[0.03] border border-white/10 px-4 py-3 text-[10px] text-white/40 font-mono truncate select-all">
                  {shareUrl || '—'}
                </div>
                <button
                  onClick={handleCopy}
                  className="px-4 py-3 bg-white text-black text-[9px] uppercase tracking-[0.3em] font-bold flex items-center gap-2 hover:bg-white/90 active:scale-[0.97] transition-all shrink-0"
                >
                  {copied ? <><Check size={11} /> Copied</> : <><Link size={11} /> Copy</>}
                </button>
              </div>
              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-2.5 border border-white/8 text-white/30 hover:text-white hover:border-white/20 transition-all text-[9px] uppercase tracking-[0.35em] font-bold"
              >
                <ExternalLink size={10} />
                Preview Shared Page
              </a>
              <button
                type="button"
                onClick={() => void handleToggleImagesOnSharePage()}
                disabled={!authToken || hideImagesBusy}
                className="w-full py-2.5 border border-white/8 bg-white/[0.02] disabled:opacity-45 disabled:cursor-not-allowed text-[9px] uppercase tracking-[0.3em] font-bold transition-all flex items-center justify-center gap-2 text-white/70 hover:text-white hover:border-white/20"
              >
                {hideImages ? <EyeOff size={11} /> : <Eye size={11} />}
                {hideImages ? 'Shared images hidden' : 'Shared images visible'}
              </button>
            </div>

            {/* Per-cologne controls */}
            <div className="flex flex-col min-h-0 flex-1">
              {/* Section header + search */}
              <div className="px-6 pt-4 pb-3 shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] uppercase tracking-[0.4em] text-white/30 font-bold">Cologne Visibility</p>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleShowAll}
                      className="text-[8px] uppercase tracking-[0.3em] text-white/25 hover:text-white/60 transition-colors font-bold"
                    >
                      Show All
                    </button>
                    <span className="text-white/10">·</span>
                    <button
                      onClick={handleHideAll}
                      className="text-[8px] uppercase tracking-[0.3em] text-white/25 hover:text-white/60 transition-colors font-bold"
                    >
                      Hide All
                    </button>
                  </div>
                </div>

                {items.length > 5 && (
                  <div className="relative">
                    <Search size={11} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
                    <input
                      ref={searchRef}
                      type="text"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search fragrances..."
                      className="w-full bg-white/[0.03] border border-white/10 pl-8 pr-4 py-2.5 text-[11px] text-white placeholder:text-white/15 focus:border-white/20 outline-none transition-all font-sans"
                    />
                  </div>
                )}
              </div>

              {/* Scrollable cologne list */}
              <div className="overflow-y-auto flex-1 px-6 pb-6 space-y-1.5 scrollbar-hide">
                {filtered.length === 0 && (
                  <p className="text-center text-white/20 font-serif italic text-sm py-8">No fragrances found</p>
                )}
                {filtered.map((item) => {
                  const isHidden = !!item.shareHidden;
                  const isPending = pendingIds.has(item.id);

                  return (
                    <motion.button
                      key={item.id}
                      layout
                      onClick={() => !isPending && handleToggle(item)}
                      disabled={isPending}
                      className={`w-full flex items-center gap-3 px-4 py-3 border transition-all duration-200 text-left group ${
                        isHidden
                          ? 'bg-white/[0.01] border-white/5 opacity-50 hover:opacity-70'
                          : 'bg-white/[0.04] border-white/10 hover:border-white/20'
                      } ${isPending ? 'cursor-wait' : 'cursor-pointer'}`}
                    >
                      {/* Bottle thumbnail */}
                      <div className="relative h-10 w-8 shrink-0 overflow-hidden">
                        {item.imageUrl && !isHidden ? (
                          <BottleImage
                            variant="thumb"
                            src={item.imageUrl}
                            alt={item.name}
                            className="h-full w-full"
                          />
                        ) : (
                          <div className="w-full h-full border border-white/10 flex items-center justify-center">
                            <div className="w-1 h-4 bg-white/10 rounded-full" />
                          </div>
                        )}
                      </div>

                      {/* Name */}
                      <div className="flex-1 min-w-0">
                        <p className="text-[9px] uppercase tracking-[0.3em] text-white/30 font-bold truncate">{item.brand}</p>
                        <p className={`font-serif italic text-base leading-tight truncate transition-colors ${isHidden ? 'text-white/30' : 'text-white'}`}>
                          {item.name}
                        </p>
                      </div>

                      {/* Toggle */}
                      <div className="shrink-0 ml-2">
                        {isPending ? (
                          <div className="w-4 h-4 border border-white/20 border-t-white/60 rounded-full animate-spin" />
                        ) : isHidden ? (
                          <EyeOff size={15} className="text-white/20 group-hover:text-white/50 transition-colors" />
                        ) : (
                          <Eye size={15} className="text-white/50 group-hover:text-white transition-colors" />
                        )}
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
