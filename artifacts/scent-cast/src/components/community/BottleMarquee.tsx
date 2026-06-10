import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import { CommunityFragranceOverlay } from '@/components/community/CommunityFragranceOverlay';
import type { CommunityFragranceEntry } from '@/components/community/communityData';
import { isLowRenderBudget } from '@/lib/platform';

interface BottleMarqueeProps {
  items: CommunityFragranceEntry[];
  loading: boolean;
  isError?: boolean;
}

// A seamless marquee loop needs at least two copies of the track. Desktop uses a
// third copy for extra slack on ultra-wide viewports; a constrained iPad PWA
// renders the minimum so a route tap doesn't triple the bottle-image surfaces.
const COMMUNITY_TRACK_COPIES_DEFAULT = 3;
const COMMUNITY_TRACK_COPIES_LOW = 2;
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

export const BottleMarquee: React.FC<BottleMarqueeProps> = React.memo(({ items, loading, isError = false }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const measureMarqueeRef = useRef<(() => void) | null>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeTriggerIdRef = useRef<string | null>(null);
  const [activeItem, setActiveItem] = useState<CommunityFragranceEntry | null>(null);
  const trackCopies = useRef(
    isLowRenderBudget() ? COMMUNITY_TRACK_COPIES_LOW : COMMUNITY_TRACK_COPIES_DEFAULT,
  ).current;
  const renderedItems = loading ? placeholderItems : items;
  const trackKey = useMemo(
    () => renderedItems.map((item) => `${item.id}:${item.imageUrl}`).join('|'),
    [renderedItems],
  );

  useEffect(() => {
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
  }, [trackKey]);

  const requestMarqueeMeasure = useCallback(() => {
    window.requestAnimationFrame(() => {
      measureMarqueeRef.current?.();
    });
  }, []);

  const closeOverlay = useCallback(() => {
    setActiveItem(null);
  }, []);

  const restoreTriggerFocus = useCallback(() => {
    const triggerId = activeTriggerIdRef.current;
    if (triggerId) {
      triggerRefs.current.get(triggerId)?.focus();
    }
    activeTriggerIdRef.current = null;
  }, []);

  if (!loading && (isError || items.length === 0)) {
    return (
      <section className="scent-community-marquee" aria-label="Community fragrance marquee">
        <div className="flex items-center justify-center py-14">
          <p className="scent-type-label">
            {isError ? 'Community unavailable' : 'No community fragrances yet'}
          </p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="scent-community-marquee" aria-label="Community fragrance marquee">
        <div
          className="scent-community-marquee-track"
          key={trackKey}
          ref={trackRef}
          data-overlay-open={activeItem ? 'true' : undefined}
          aria-hidden={activeItem ? 'true' : undefined}
        >
          {[...Array(trackCopies)].map((_, copyIndex) => (
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
                    className="scent-fragrance-card scent-community-marquee-card group relative flex h-full w-full cursor-pointer flex-col p-5 sm:p-6 text-left outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
                    whileHover={{ y: -8, scale: 1.04 }}
                    transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                    onClick={() => {
                      if (!loading && item.imageUrl) {
                        activeTriggerIdRef.current = item.id;
                        setActiveItem(item);
                      }
                    }}
                  >
                    <div className="scent-card-frame" aria-hidden="true" />
                    <div className="relative z-10 flex justify-end">
                      <span className="font-mono scent-type-label text-scent-accent">
                        {item.curator}
                      </span>
                    </div>
                    <div className="relative z-10 my-3 min-h-0 flex-1">
                      <BottleImage
                        src={item.imageUrl}
                        alt={`${item.name} by ${item.brand}`}
                        variant="card"
                        className="absolute inset-0"
                        imgClassName="scent-hover-scale brightness-[1.1] transition-transform duration-[900ms] motion-reduce:transition-none"
                        adjustment={item.imageAdjustment}
                        showFrameGuide={false}
                        onLoad={copyIndex === 0 ? requestMarqueeMeasure : undefined}
                        onError={copyIndex === 0 ? requestMarqueeMeasure : undefined}
                      />
                    </div>
                    <div className="relative z-10 mt-2 text-center">
                      <BrandGoldLabel as="span" brand={item.brand} className="scent-card-brand block" />
                    </div>
                    <div className="scent-card-title-row relative z-10 mt-2">
                      <h3 className="scent-card-title" title={item.name}>{item.name}</h3>
                    </div>
                  </motion.button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <CommunityFragranceOverlay item={activeItem} onClose={closeOverlay} restoreFocus={restoreTriggerFocus} />
    </>
  );
});
