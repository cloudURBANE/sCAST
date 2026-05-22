import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
import type { CommunityFragranceEntry } from '@/components/community/communityData';

interface BottleMarqueeProps {
  items: CommunityFragranceEntry[];
  loading: boolean;
}

const COMMUNITY_TRACK_COPIES = 3;
const COMMUNITY_SCROLL_PIXELS_PER_SECOND = 6;
const COMMUNITY_SCROLL_MIN_SECONDS = 140;
const COMMUNITY_SCROLL_MAX_SECONDS = 320;
const COMMUNITY_SCROLL_REDUCED_MOTION_SECONDS = 640;

const placeholderItems: CommunityFragranceEntry[] = [...Array(8)].map((_, index) => ({
  id: `placeholder:${index}`,
  name: 'Loading fragrance',
  brand: 'Community',
  imageUrl: '',
  curator: '@community',
}));

const noteRows = [
  ['Top', 'topNotes'],
  ['Heart', 'heartNotes'],
  ['Base', 'baseNotes'],
] as const;

function formatNotes(notes: string[] | undefined): string {
  return notes && notes.length > 0 ? notes.join(', ') : 'Notes pending curation';
}

export const BottleMarquee: React.FC<BottleMarqueeProps> = ({ items, loading }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const measureMarqueeRef = useRef<(() => void) | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeTriggerIdRef = useRef<string | null>(null);
  const [activeItem, setActiveItem] = useState<CommunityFragranceEntry | null>(null);
  const renderedItems = loading || items.length === 0 ? placeholderItems : items;

  useLayoutEffect(() => {
    const track = trackRef.current;
    const group = groupRef.current;
    if (!track || !group) return;
    let cancelled = false;
    let animationFrame = 0;

    const updateDistance = (ready = true) => {
      if (cancelled) return;
      const distance = group.getBoundingClientRect().width;
      if (distance <= 0) return;

      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = prefersReducedMotion
        ? COMMUNITY_SCROLL_REDUCED_MOTION_SECONDS
        : Math.min(
            COMMUNITY_SCROLL_MAX_SECONDS,
            Math.max(COMMUNITY_SCROLL_MIN_SECONDS, distance / COMMUNITY_SCROLL_PIXELS_PER_SECOND),
          );

      track.style.setProperty('--community-marquee-distance', `${distance}px`);
      track.style.setProperty('--community-marquee-duration', `${duration}s`);
      if (ready) {
        track.dataset.marqueeReady = 'true';
      }
    };
    measureMarqueeRef.current = () => updateDistance(track.dataset.marqueeReady === 'true');

    track.dataset.marqueeReady = 'false';

    const startWhenFontsSettle = () => {
      animationFrame = window.requestAnimationFrame(() => updateDistance(true));
    };

    if (document.fonts?.ready) {
      document.fonts.ready.then(startWhenFontsSettle);
    } else {
      startWhenFontsSettle();
    }

    const handleResize = () => updateDistance(track.dataset.marqueeReady === 'true');
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(group);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelled = true;
      measureMarqueeRef.current = null;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const requestMarqueeMeasure = useCallback(() => {
    window.requestAnimationFrame(() => {
      measureMarqueeRef.current?.();
    });
  }, []);

  useLayoutEffect(() => {
    requestMarqueeMeasure();
  }, [renderedItems, requestMarqueeMeasure]);

  const closeOverlay = useCallback(() => {
    const triggerId = activeTriggerIdRef.current;
    setActiveItem(null);
    window.requestAnimationFrame(() => {
      if (triggerId) {
        triggerRefs.current.get(triggerId)?.focus();
      }
      activeTriggerIdRef.current = null;
    });
  }, []);

  useEffect(() => {
    if (!activeItem) return;
    closeButtonRef.current?.focus();
  }, [activeItem]);

  useEffect(() => {
    if (!activeItem) return;

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
  }, [activeItem, closeOverlay]);

  return (
    <>
      <section className="scent-community-marquee" aria-label="Community fragrance marquee">
        <div className="scent-community-marquee-track" ref={trackRef}>
          {[...Array(COMMUNITY_TRACK_COPIES)].map((_, copyIndex) => (
            <div
              className="scent-community-marquee-group"
              key={copyIndex}
              ref={copyIndex === 0 ? groupRef : undefined}
              aria-hidden={copyIndex > 0}
            >
              {renderedItems.map((item) => (
                <div key={`${copyIndex}:${item.id}`} className="scent-community-marquee-cell">
                  <motion.button
                    type="button"
                    aria-label={`${item.name} by ${item.brand}, curated by ${item.curator}`}
                    tabIndex={copyIndex > 0 ? -1 : 0}
                    ref={(node) => {
                      if (copyIndex > 0) return;
                      if (node) {
                        triggerRefs.current.set(item.id, node);
                      } else {
                        triggerRefs.current.delete(item.id);
                      }
                    }}
                    className="pedestal relative h-full w-full cursor-pointer rounded-[var(--radius-scent)] border border-white/8 bg-black/25 p-3 text-left shadow-[0_24px_60px_-36px_rgba(0,0,0,0.95)] outline-none transition-colors hover:border-white/16 focus-visible:border-white/24 focus-visible:ring-2 focus-visible:ring-scent-accent/40"
                    whileHover={{ y: -8, scale: 1.04 }}
                    transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                    onClick={() => {
                      if (!loading && item.imageUrl) {
                        activeTriggerIdRef.current = item.id;
                        setActiveItem(item);
                      }
                    }}
                  >
                    <div className="absolute inset-x-5 bottom-4 h-px bg-gradient-to-r from-transparent via-scent-accent/35 to-transparent" aria-hidden="true" />
                    <BottleImage
                      src={item.imageUrl}
                      alt={`${item.name} by ${item.brand}`}
                      variant="display"
                      className="absolute inset-3"
                      adjustment={item.imageAdjustment}
                      showFrameGuide={false}
                      onLoad={copyIndex === 0 ? requestMarqueeMeasure : undefined}
                      onError={copyIndex === 0 ? requestMarqueeMeasure : undefined}
                    />
                    <span className="absolute left-4 top-4 font-mono text-[8px] uppercase tracking-[0.24em] text-scent-accent/75">
                      {item.curator}
                    </span>
                  </motion.button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <AnimatePresence mode="wait">
        {activeItem ? (
          <motion.div
            key="community-fragrance-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeInOut' }}
            className="fixed inset-0 z-[110] bg-black/95 backdrop-blur-3xl flex flex-col"
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
                    <p className="text-[9px] uppercase tracking-[0.3em] text-scent-accent/75 mb-3">{activeItem.curator}</p>
                    <h2 id="community-fragrance-overlay-title" className="font-serif italic text-2xl sm:text-6xl mb-4">Inside the case</h2>
                    <div className="h-px w-16 bg-white/20 mx-auto" />
                  </header>
                  <div className="py-6 sm:py-16 border-y border-white/10">
                    <p className="text-sm uppercase tracking-[0.2em] text-white/40 mb-2 font-serif">{activeItem.brand}</p>
                    <h3 className="font-serif italic text-3xl sm:text-8xl text-white leading-tight">{activeItem.name}</h3>
                    {activeItem.family ? (
                      <p className="mt-5 text-[10px] uppercase tracking-[0.28em] text-scent-accent/80">{activeItem.family}</p>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-1 gap-5 sm:gap-7 text-left">
                    {noteRows.map(([label, key]) => (
                      <div key={label}>
                        <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">{label}</p>
                        <p className="text-sm italic text-scent-muted leading-relaxed">{formatNotes(activeItem[key])}</p>
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
    </>
  );
};
