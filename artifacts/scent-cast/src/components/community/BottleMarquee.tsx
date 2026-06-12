import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig, motion } from 'framer-motion';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import { CommunityFragranceOverlay } from '@/components/community/CommunityFragranceOverlay';
import type { CommunityFragranceEntry } from '@/components/community/communityData';
import {
  COMMUNITY_IMAGE_LAYOUT_TRANSITION,
  COMMUNITY_IMAGE_LAYOUT_TRANSITION_LOW_RENDER,
} from '@/components/community/communityMotion';
import { isIpadSafariPerformanceMode, isLowRenderBudget } from '@/lib/platform';
import { useMarqueeSwipe } from '@/hooks/useMarqueeSwipe';

interface BottleMarqueeProps {
  items: CommunityFragranceEntry[];
  loading: boolean;
  isError?: boolean;
}

// A seamless marquee loop needs at least two copies of the track. Desktop uses a
// third copy for extra slack on ultra-wide viewports; constrained devices and
// iPad Safari render the minimum so a route tap does not triple image surfaces.
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
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const measureMarqueeRef = useRef<(() => void) | null>(null);
  const activeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [activeItem, setActiveItem] = useState<CommunityFragranceEntry | null>(null);
  const [activeImageLayoutId, setActiveImageLayoutId] = useState<string | null>(null);
  const [overlayClosing, setOverlayClosing] = useState(false);
  const lowRenderBudget = useRef(isLowRenderBudget() || isIpadSafariPerformanceMode()).current;
  const trackCopies = useRef(
    lowRenderBudget ? COMMUNITY_TRACK_COPIES_LOW : COMMUNITY_TRACK_COPIES_DEFAULT,
  ).current;
  const imageLayoutTransition = lowRenderBudget
    ? COMMUNITY_IMAGE_LAYOUT_TRANSITION_LOW_RENDER
    : COMMUNITY_IMAGE_LAYOUT_TRANSITION;
  const cardHoverMotion = lowRenderBudget ? undefined : { y: -8, scale: 1.04 };
  const cardTapMotion = lowRenderBudget ? undefined : { scale: 0.985 };
  const renderedItems = loading ? placeholderItems : items;
  const trackKey = useMemo(
    () => renderedItems.map((item) => `${item.id}:${item.imageUrl}`).join('|'),
    [renderedItems],
  );

  // The track element is keyed by trackKey, so the swipe listeners must
  // re-attach whenever it is recreated.
  useMarqueeSwipe(trackRef, {
    distanceVar: '--community-marquee-distance',
    durationVar: '--community-marquee-duration',
    resetKey: trackKey,
  });

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
  }, [trackKey]);

  // A marquee nobody can see should not burn frames: pause the CSS animation
  // while the section is scrolled out of view or the tab is backgrounded.
  useEffect(() => {
    const section = sectionRef.current;
    const track = trackRef.current;
    if (!section || !track) return;
    let offscreen = false;

    const syncPaused = () => {
      if (offscreen || document.visibilityState === 'hidden') {
        track.dataset.marqueePaused = 'true';
      } else {
        delete track.dataset.marqueePaused;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        offscreen = entries.some((entry) => !entry.isIntersecting);
        syncPaused();
      },
      { rootMargin: '160px 0px' },
    );
    observer.observe(section);
    document.addEventListener('visibilitychange', syncPaused);

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', syncPaused);
    };
  }, [trackKey]);

  const requestMarqueeMeasure = useCallback(() => {
    window.requestAnimationFrame(() => {
      measureMarqueeRef.current?.();
    });
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlayClosing(true);
    setActiveItem(null);
  }, []);

  const restoreTriggerFocus = useCallback(() => {
    const trigger = activeTriggerRef.current;
    activeTriggerRef.current = null;
    if (trigger?.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  }, []);

  const handleOverlayExitComplete = useCallback(() => {
    setOverlayClosing(false);
    setActiveImageLayoutId(null);
  }, []);

  const openItem = useCallback(
    (item: CommunityFragranceEntry, copyIndex: number, trigger: HTMLButtonElement) => {
      if (!loading && item.imageUrl) {
        activeTriggerRef.current = trigger;
        setOverlayClosing(false);
        setActiveImageLayoutId(`bottle-image-${copyIndex}-${item.id}`);
        setActiveItem(item);
      }
    },
    [loading],
  );

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
    <MotionConfig reducedMotion="user">
      <section ref={sectionRef} className="scent-community-marquee" aria-label="Community fragrance marquee">
        <div
          className="scent-community-marquee-track"
          key={trackKey}
          ref={trackRef}
          data-overlay-open={activeItem ? 'true' : undefined}
          data-overlay-settling={activeItem || overlayClosing ? 'true' : undefined}
          aria-hidden={activeItem || overlayClosing ? 'true' : undefined}
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
                    className="scent-fragrance-card scent-community-marquee-card group relative flex h-full w-full cursor-pointer flex-col p-5 sm:p-6 text-left outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
                    whileHover={cardHoverMotion}
                    whileTap={cardTapMotion}
                    transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                    onClick={(event) => openItem(item, copyIndex, event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openItem(item, copyIndex, event.currentTarget);
                      }
                    }}
                  >
                    <div className="scent-card-frame" aria-hidden="true" />
                    <div className="relative z-10 flex justify-end">
                      <span className="font-mono scent-type-label text-scent-accent">
                        {item.curator}
                      </span>
                    </div>
                    <motion.div
                      layoutId={`bottle-image-${copyIndex}-${item.id}`}
                      transition={imageLayoutTransition}
                      className="relative z-10 my-3 min-h-0 flex-1"
                    >
                      <BottleImage
                        src={item.imageUrl}
                        alt={`${item.name} by ${item.brand}`}
                        variant="card"
                        className="absolute inset-0"
                        imgClassName="scent-hover-scale brightness-[1.1] transition-transform duration-[900ms] motion-reduce:transition-none"
                        adjustment={item.imageAdjustment}
                        showFrameGuide={false}
                        isSyncing={loading}
                        onLoad={copyIndex === 0 ? requestMarqueeMeasure : undefined}
                        onError={copyIndex === 0 ? requestMarqueeMeasure : undefined}
                      />
                    </motion.div>
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

      <CommunityFragranceOverlay
        item={activeItem}
        imageLayoutId={activeImageLayoutId}
        lowRenderBudget={lowRenderBudget}
        onClose={closeOverlay}
        onExitComplete={handleOverlayExitComplete}
        restoreFocus={restoreTriggerFocus}
      />
    </MotionConfig>
  );
});
