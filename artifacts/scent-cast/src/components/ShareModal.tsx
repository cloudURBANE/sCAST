import React, { useState, useEffect, useRef } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { SCENT_EASE_OUT_EXPO } from '@/lib/motion';
import { X, Link, Check, Eye, EyeOff, ExternalLink, Search } from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
import type { BottleImageAdjustment } from '@/lib/bottleImageAdjustment';
import { useToast } from '@/hooks/use-toast';
import { useModalBehavior } from '@/hooks/use-modal-behavior';

interface FragranceItem {
  id: string;
  name: string;
  brand: string;
  imageUrl?: string;
  imageAdjustment?: BottleImageAdjustment | null;
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
  onToggleVisibility: (rowOrItemId: string, hidden: boolean) => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  isOpen,
  onClose,
  userId,
  authToken,
  items = [],
  onToggleVisibility,
}) => {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [hideImages, setHideImages] = useState(false);
  const [hideImagesBusy, setHideImagesBusy] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const sharePathId = shareId || userId || '';
  const shareUrl = sharePathId
    ? `${window.location.origin}/share/${encodeURIComponent(sharePathId)}`
    : '';

  const visibleCount = items.filter(i => !i.shareHidden).length;

  useEffect(() => {
    if (isOpen) {
      setSearch('');
    }
  }, [isOpen]);

  useModalBehavior({
    isOpen,
    containerRef: modalRef,
    initialFocusRef: searchRef,
    onDismiss: onClose,
  });

  useEffect(() => {
    if (!isOpen || !authToken) return;
    let cancelled = false;
    fetch('/api/share-settings', {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setHideImages(Boolean(d?.hideImages));
        setShareId(typeof d?.shareId === 'string' && d.shareId.trim() ? d.shareId : null);
      })
      .catch((err) => {
        if (cancelled) return;
        toast({
          title: "Failed to load share settings",
          description: "Unable to retrieve your current sharing configuration.",
          variant: "destructive"
        });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, authToken, toast]);

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
    setPendingIds(prev => new Set(prev).add(apiId));
    onToggleVisibility(apiId, newHidden);
    try {
      const res = await fetch(`/api/wardrobe/${apiId}/visibility`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ shareHidden: newHidden }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      onToggleVisibility(apiId, !newHidden);
      toast({
        title: "Visibility Update Failed",
        description: "Could not sync fragrance visibility. Please try again.",
        variant: "destructive"
      });
    } finally {
      setPendingIds(prev => {
        const next = new Set(prev);
        next.delete(apiId);
        return next;
      });
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;

    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: 'Copy Failed',
        description: 'The share link could not be copied. Please try again or use Preview.',
        variant: 'destructive',
      });
    }
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
    } catch (err) {
      setHideImages(!next);
      toast({
        title: "Settings Update Failed",
        description: "Could not update portrait display configuration.",
        variant: "destructive"
      });
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
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/90"
          />
          <m.div
            ref={modalRef}
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ duration: 0.25, ease: SCENT_EASE_OUT_EXPO }}
            className="relative w-full sm:max-w-lg mx-0 sm:mx-6 bg-neutral-950 border-t sm:border border-white/10 sm:rounded-[1.5rem] overflow-hidden shadow-2xl flex flex-col"
            style={{ maxHeight: '90dvh' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-modal-title"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/5 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-1.5 h-1.5 rounded-full bg-scent-accent animate-pulse shrink-0" />
                <div className="min-w-0">
                  <p id="share-modal-title" className="text-[9px] uppercase tracking-[0.5em] text-scent-accent font-bold">Share Vault</p>
                  <p className="text-[9px] text-white/40 mt-0.5 font-sans">
                    {visibleCount} of {items.length} visible
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close share options"
                className="inline-flex min-h-11 min-w-11 items-center justify-center bg-white/5 hover:bg-white/10 transition-colors rounded-full border border-white/10 text-white group shrink-0 ml-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              >
                <X size={16} strokeWidth={1.75} className="group-hover:rotate-90 transition-transform duration-300" />
              </button>
            </div>

            {/* Link row */}
            <div className="px-6 py-4 shrink-0 space-y-3 border-b border-white/5">
              <div className="flex gap-2">
                <div className="flex-1 bg-white/[0.03] border border-white/10 px-4 py-3 text-[10px] text-white/40 font-mono truncate select-all">
                  {shareUrl || '—'}
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  disabled={!shareUrl}
                  className="px-4 py-3 bg-white text-black text-[9px] uppercase tracking-[0.3em] font-bold flex items-center gap-2 hover:bg-white/90 active:scale-[0.97] transition-[background-color,opacity,transform] shrink-0 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
                >
                  {copied ? <><Check size={11} strokeWidth={1.75} /> Copied</> : <><Link size={11} strokeWidth={1.75} /> Copy</>}
                </button>
              </div>
              {shareUrl ? (
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full py-2.5 border border-white/8 text-white/50 hover:text-white hover:border-white/20 transition-colors text-[9px] uppercase tracking-[0.35em] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                  <ExternalLink size={10} strokeWidth={1.75} />
                  Preview Shared Page
                </a>
              ) : (
                <span
                  aria-disabled="true"
                  className="flex items-center justify-center gap-2 w-full py-2.5 border border-white/8 text-white/25 text-[9px] uppercase tracking-[0.35em] font-bold"
                >
                  <ExternalLink size={10} strokeWidth={1.75} />
                  Preview Unavailable
                </span>
              )}
              <button
                type="button"
                onClick={() => void handleToggleImagesOnSharePage()}
                disabled={!authToken || hideImagesBusy}
                className="w-full py-2.5 border border-white/8 bg-white/[0.02] disabled:opacity-45 disabled:cursor-not-allowed text-[9px] uppercase tracking-[0.3em] font-bold transition-[color,border-color,opacity] flex items-center justify-center gap-2 text-white/70 hover:text-white hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              >
                {hideImages ? <EyeOff size={11} strokeWidth={1.75} /> : <Eye size={11} strokeWidth={1.75} />}
                {hideImages ? 'Shared images hidden' : 'Shared images visible'}
              </button>
            </div>

            {/* Per-cologne controls */}
            <div className="flex flex-col min-h-0 flex-1">
              {/* Section header + search */}
              <div className="px-6 py-4 shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] uppercase tracking-[0.4em] text-white/45 font-bold">Cologne Visibility</p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleShowAll}
                      className="-my-2 inline-flex min-h-11 items-center rounded-sm px-1 text-[9px] uppercase tracking-[0.3em] text-white/45 hover:text-white/80 transition-colors font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                    >
                      Show All
                    </button>
                    <span className="text-white/15" aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={handleHideAll}
                      className="-my-2 inline-flex min-h-11 items-center rounded-sm px-1 text-[9px] uppercase tracking-[0.3em] text-white/45 hover:text-white/80 transition-colors font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                    >
                      Hide All
                    </button>
                  </div>
                </div>

                {items.length > 5 && (
                  <div className="relative">
                    <Search size={11} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
                    <input
                      ref={searchRef}
                      type="text"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search fragrances..."
                      aria-label="Search fragrances"
                      className="w-full bg-white/[0.03] border border-white/10 pl-8 pr-4 py-2.5 text-[16px] text-white placeholder:text-white/35 focus:border-white/20 outline-none transition-colors font-sans"
                    />
                  </div>
                )}
              </div>

              {/* Scrollable cologne list */}
              {/* pb honors the home-indicator safe area — on phones this modal is
                  a bottom sheet, so the last row must not sit under the inset. */}
              <div className="overflow-y-auto flex-1 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] space-y-1.5 scrollbar-hide">
                {filtered.length === 0 && (
                  <p className="text-center text-white/45 font-serif italic text-sm py-8">No fragrances found</p>
                )}
                {filtered.map((item) => {
                  const rowOrItemId = item._dbId ?? item.id;
                  const isHidden = !!item.shareHidden;
                  const isPending = pendingIds.has(rowOrItemId);

                  return (
                    <m.button
                      key={rowOrItemId}
                      layout
                      type="button"
                      onClick={() => !isPending && handleToggle(item)}
                      disabled={isPending}
                      aria-label={
                        isHidden
                          ? `${item.name} by ${item.brand} — hidden from your shared vault. Activate to show.`
                          : `${item.name} by ${item.brand} — visible in your shared vault. Activate to hide.`
                      }
                      className={`w-full flex items-center gap-3 px-4 py-3 border transition-colors duration-200 text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40 ${
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
                            adjustment={item.imageAdjustment}
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
                          <EyeOff size={15} strokeWidth={1.75} className="text-white/20 group-hover:text-white/50 transition-colors" />
                        ) : (
                          <Eye size={15} strokeWidth={1.75} className="text-white/50 group-hover:text-white transition-colors" />
                        )}
                      </div>
                    </m.button>
                  );
                })}
              </div>
            </div>
          </m.div>
        </div>
      )}
    </AnimatePresence>
  );
};
