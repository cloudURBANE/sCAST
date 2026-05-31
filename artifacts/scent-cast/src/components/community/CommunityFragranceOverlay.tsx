import React, { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
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
          transition={{ duration: 0.35, ease: 'easeInOut' }}
          className="fixed inset-0 z-[110] bg-black/95 backdrop-blur-sm flex flex-col"
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

          <div className="flex-1 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
            <div className="flex items-center justify-center min-h-full px-5 py-6 sm:px-16 sm:py-12">
              <div className="max-w-2xl w-full text-center space-y-6 sm:space-y-12">
                <header>
                  <p className="text-[9px] uppercase tracking-[0.3em] text-scent-accent/75 mb-3">{item.curator}</p>
                  <h2 id="community-fragrance-overlay-title" className="font-serif italic text-2xl sm:text-6xl mb-4">Inside the case</h2>
                  <div className="h-px w-16 bg-white/20 mx-auto" />
                </header>
                <div className="py-6 sm:py-16 border-y border-white/10">
                  <p className="text-sm uppercase tracking-[0.2em] text-white/40 mb-2 font-serif">{item.brand}</p>
                  <h3 className="font-serif italic text-3xl sm:text-8xl text-white leading-tight">{item.name}</h3>
                  {item.family ? (
                    <p className="mt-5 text-[10px] uppercase tracking-[0.28em] text-scent-accent/80">{item.family}</p>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-5 sm:gap-7 text-left">
                  {noteRows.map(([label, key]) => (
                    <div key={label}>
                      <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">{label}</p>
                      <p className="text-sm italic text-scent-muted leading-relaxed">{formatNotes(item[key])}</p>
                    </div>
                  ))}
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
