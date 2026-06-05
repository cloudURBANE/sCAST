import React, { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import type { CommunityFragranceEntry } from '@/components/community/communityData';

interface CommunityFragranceOverlayProps {
  item: CommunityFragranceEntry | null;
  onClose: () => void;
  restoreFocus?: () => void;
}

const noteRows = [
  ['Top', 'topNotes'],
  ['Heart', 'heartNotes'],
  ['Base', 'baseNotes'],
] as const;

function formatNotes(notes: string[] | undefined): string {
  return notes && notes.length > 0 ? notes.join(', ') : 'Notes pending curation';
}

export const CommunityFragranceOverlay: React.FC<CommunityFragranceOverlayProps> = ({
  item,
  onClose,
  restoreFocus,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const closeOverlay = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => {
      restoreFocus?.();
    });
  }, [onClose, restoreFocus]);

  useEffect(() => {
    if (!item) return;
    closeButtonRef.current?.focus();
  }, [item]);

  useEffect(() => {
    if (!item) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOverlay();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        overlayRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');

      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [item, closeOverlay]);

  return (
    <AnimatePresence mode="wait">
      {item ? (
        <motion.div
          key="community-fragrance-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
          className="fixed inset-0 z-[110] flex flex-col bg-[#020202]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="community-fragrance-overlay-title"
          ref={overlayRef}
        >
          <div
            className="flex items-center justify-between px-5 pb-4 shrink-0"
            style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}
          >
            <p className="text-[9px] uppercase tracking-[0.4em] text-scent-accent font-bold">Community Wardrobe</p>
            <button
              type="button"
              onClick={closeOverlay}
              className="p-2 text-white/40 hover:text-white hover:bg-white/10 transition-all active:scale-95"
              aria-label="Close fragrance details"
              ref={closeButtonRef}
            >
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center px-5 py-6 sm:px-10 sm:py-10 lg:px-16">
              <div className="grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)] lg:items-center lg:gap-14">
                <div className="scent-fragrance-card relative mx-auto flex aspect-[3/4.6] w-full max-w-[20rem] flex-col p-5 sm:max-w-[24rem] sm:p-6">
                  <div className="scent-card-frame" aria-hidden="true" />
                  <div className="relative z-10 flex justify-end">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-scent-accent/80">
                      {item.curator}
                    </span>
                  </div>
                  <div className="relative z-10 my-3 min-h-0 flex-1">
                    <BottleImage
                      src={item.imageUrl}
                      alt={`${item.name} by ${item.brand}`}
                      variant="card"
                      className="absolute inset-0"
                      imgClassName="brightness-[1.1]"
                      adjustment={item.imageAdjustment}
                    />
                  </div>
                  <div className="relative z-10 mt-2 text-center">
                    <BrandGoldLabel as="span" brand={item.brand} className="scent-card-brand block" />
                  </div>
                  <div className="scent-card-title-row relative z-10 mt-2">
                    <h3 className="scent-card-title" title={item.name}>{item.name}</h3>
                  </div>
                </div>

                <div className="space-y-8 text-left">
                  <header className="space-y-5">
                    <p className="text-[9px] font-bold uppercase tracking-[0.36em] text-scent-accent/80">
                      Community Wardrobe
                    </p>
                    <div className="space-y-3">
                      <BrandGoldLabel as="p" brand={item.brand} className="font-serif text-sm uppercase tracking-[0.24em]" />
                      <h2
                        id="community-fragrance-overlay-title"
                        className="font-serif text-4xl italic leading-none text-[#fff7ec] sm:text-6xl lg:text-7xl"
                      >
                        {item.name}
                      </h2>
                    </div>
                    {item.family ? (
                      <p className="text-[10px] uppercase tracking-[0.28em] text-scent-muted">
                        {item.family}
                      </p>
                    ) : null}
                  </header>

                  <div className="h-px w-full bg-gradient-to-r from-scent-accent/40 via-white/10 to-transparent" />

                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-6">
                    {noteRows.map(([label, key]) => (
                      <div key={label} className="border-l border-white/10 pl-4">
                        <p className="mb-2 text-[8px] font-bold uppercase tracking-[0.3em] text-scent-accent/70">
                          {label}
                        </p>
                        <p className="font-serif text-base italic leading-relaxed text-scent-muted">
                          {formatNotes(item[key])}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            className="px-5 pt-3 shrink-0 border-t border-white/5"
            style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
          >
            <button
              type="button"
              onClick={closeOverlay}
              className="scent-primary-button w-full py-4 rounded-[var(--radius-scent)]"
            >
              Close
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};
