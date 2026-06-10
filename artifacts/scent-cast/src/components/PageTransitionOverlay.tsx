import React, { useEffect, useRef, type CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { isLowRenderBudget } from '@/lib/platform';

const EMBLEM = '/icons/transparent-emblem/scentbeam-emblem-192x192.png';
const GOLD = '212, 175, 55';

let emblemWarmPromise: Promise<void> | null = null;

export function warmTransitionEmblem(): Promise<void> | undefined {
  if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;

  const existingPreload = document.querySelector<HTMLLinkElement>(`link[rel="preload"][href="${EMBLEM}"]`);
  if (!existingPreload) {
    const preload = document.createElement('link');
    preload.rel = 'preload';
    preload.as = 'image';
    preload.href = EMBLEM;
    (preload as HTMLLinkElement & { fetchPriority?: 'high' }).fetchPriority = 'high';
    document.head.appendChild(preload);
  }

  if (emblemWarmPromise) return emblemWarmPromise;

  const image = new Image();
  image.decoding = 'async';
  (image as HTMLImageElement & { fetchPriority?: 'high' }).fetchPriority = 'high';

  emblemWarmPromise = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (retryNextTime = false) => {
      if (settled) return;
      settled = true;
      if (retryNextTime) emblemWarmPromise = null;
      resolve();
    };

    image.onload = () => finish();
    image.onerror = () => finish(true);
    image.src = EMBLEM;

    if (typeof image.decode === 'function') {
      image.decode().then(() => finish()).catch(() => undefined);
    }
  });

  return emblemWarmPromise;
}

interface PageTransitionOverlayProps {
  visible: boolean;
  animationKey: number;
}

interface MotionProfile {
  duration: number;
  // Cover (fade-in) must finish before App.tsx swaps the route at `coverMs`, or
  // the page change flashes through the still-translucent overlay.
  coverDuration: number;
  // Reveal (fade-out) — the new route is already painted underneath, so this is
  // a soft uncover rather than a hard cut.
  revealDuration: number;
  emblemSize: number;
  bloomSize: number;
  innerRingSize: number;
  outerRingSize: number;
  bloomScale: number[];
  bloomOpacity: number[];
  innerRingScale: number[];
  innerRingOpacity: number[];
  outerRingScale: number[];
  outerRingOpacity: number[];
  emblemRotate: number[];
  emblemScale: number[];
  showBloom: boolean;
  showOuterRing: boolean;
}

const fullMotionProfile: MotionProfile = {
  duration: 0.52,
  coverDuration: 0.08,
  revealDuration: 0.26,
  emblemSize: 92,
  bloomSize: 192,
  innerRingSize: 136,
  outerRingSize: 176,
  bloomScale: [0.28, 0.96, 1.2],
  bloomOpacity: [0, 0.12, 0],
  innerRingScale: [0.36, 1, 1.42],
  innerRingOpacity: [0, 0.42, 0],
  outerRingScale: [0.42, 1.06, 1.58],
  outerRingOpacity: [0, 0.18, 0],
  emblemRotate: [-6, 24, 0],
  emblemScale: [0.76, 1.02, 0.99, 1],
  showBloom: false,
  showOuterRing: false,
};

const compactMotionProfile: MotionProfile = {
  duration: 0.34,
  coverDuration: 0.06,
  revealDuration: 0.2,
  emblemSize: 76,
  bloomSize: 160,
  innerRingSize: 112,
  outerRingSize: 136,
  bloomScale: [0.3, 0.92, 1.24],
  bloomOpacity: [0, 0.12, 0],
  innerRingScale: [0.6, 1, 1.24],
  innerRingOpacity: [0, 0.28, 0],
  outerRingScale: [0.66, 1, 1.2],
  outerRingOpacity: [0, 0.1, 0],
  emblemRotate: [-4, 18, 0],
  emblemScale: [0.9, 1.03, 0.99, 1],
  showBloom: false,
  showOuterRing: false,
};

const overlayStyle: CSSProperties = {
  background:
    'radial-gradient(ellipse 55% 50% at 50% 50%, rgba(18, 11, 3, 0.96) 0%, rgba(3, 2, 1, 0.985) 100%)',
  contain: 'layout paint',
  isolation: 'isolate',
  transform: 'translate3d(0, 0, 0)',
  willChange: 'opacity',
};

const reducedOverlayStyle: CSSProperties = {
  background:
    'radial-gradient(ellipse 55% 50% at 50% 50%, rgba(16, 10, 2, 0.94) 0%, rgba(3, 2, 1, 0.97) 100%)',
  contain: 'layout paint',
  isolation: 'isolate',
};

export const PageTransitionOverlay: React.FC<PageTransitionOverlayProps> = ({
  visible,
  animationKey,
}) => {
  const reduceMotion = useReducedMotion();
  const lowRenderBudget = useRef(isLowRenderBudget()).current;
  const profile = lowRenderBudget ? compactMotionProfile : fullMotionProfile;

  useEffect(() => {
    warmTransitionEmblem();
  }, []);

  useEffect(() => {
    if (visible) warmTransitionEmblem();
  }, [visible]);

  const reducedContent = (
    <motion.div
      key={animationKey}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, pointerEvents: 'none', transition: { duration: 0.18, ease: 'easeInOut' } }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-auto"
      style={reducedOverlayStyle}
      data-page-transition-overlay="true"
      aria-hidden="true"
      role="presentation"
    >
      <img
        src={EMBLEM}
        alt=""
        draggable={false}
        decoding="async"
        fetchPriority="high"
        style={{ width: 78, height: 78, userSelect: 'none' }}
      />
    </motion.div>
  );

  const fullContent = (
    <motion.div
      key={animationKey}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, pointerEvents: 'none', transition: { duration: profile.revealDuration, ease: 'easeInOut' } }}
      transition={{ duration: profile.coverDuration, ease: 'easeOut' }}
      className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-auto"
      style={overlayStyle}
      data-page-transition-overlay="true"
      aria-hidden="true"
      role="presentation"
    >
          {profile.showBloom ? (
            <motion.div
              initial={{ scale: profile.bloomScale[0], opacity: 0 }}
              animate={{
                scale: profile.bloomScale,
                opacity: profile.bloomOpacity,
              }}
              transition={{ duration: profile.duration, times: [0, 0.38, 1], ease: 'easeOut' }}
              aria-hidden="true"
              style={{
                position: 'absolute',
                width: profile.bloomSize,
                height: profile.bloomSize,
                borderRadius: '50%',
                background: `radial-gradient(circle, rgba(${GOLD}, 0.72) 0%, rgba(${GOLD}, 0.2) 42%, transparent 72%)`,
                pointerEvents: 'none',
                transform: 'translate3d(0, 0, 0)',
                willChange: 'transform, opacity',
              }}
            />
          ) : null}

          <motion.div
            initial={{ scale: profile.innerRingScale[0], opacity: 0, rotate: -96 }}
            animate={{
              scale: profile.innerRingScale,
              opacity: profile.innerRingOpacity,
              rotate: [-96, 48, 156],
            }}
            transition={{ duration: profile.duration, times: [0, 0.46, 1], ease: [0.22, 1, 0.36, 1] }}
            aria-hidden="true"
            style={{
              position: 'absolute',
              width: profile.innerRingSize,
              height: profile.innerRingSize,
              borderRadius: '50%',
              border: `1px solid rgba(${GOLD}, 0.54)`,
              borderLeftColor: `rgba(${GOLD}, 0.16)`,
              borderBottomColor: `rgba(${GOLD}, 0.12)`,
              pointerEvents: 'none',
              transform: 'translate3d(0, 0, 0)',
              willChange: 'transform, opacity',
            }}
          />

          {profile.showOuterRing ? (
            <motion.div
              initial={{ scale: profile.outerRingScale[0], opacity: 0, rotate: 34 }}
              animate={{
                scale: profile.outerRingScale,
                opacity: profile.outerRingOpacity,
                rotate: [34, -42, -108],
              }}
              transition={{ duration: profile.duration, delay: 0.04, times: [0, 0.42, 1], ease: 'easeOut' }}
              aria-hidden="true"
              style={{
                position: 'absolute',
                width: profile.outerRingSize,
                height: profile.outerRingSize,
                borderRadius: '50%',
                border: `0.5px solid rgba(${GOLD}, 0.26)`,
                borderRightColor: `rgba(${GOLD}, 0.08)`,
                pointerEvents: 'none',
                transform: 'translate3d(0, 0, 0)',
                willChange: 'transform, opacity',
              }}
            />
          ) : null}

          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: [0, 1, 1], scale: [0.92, 1.01, 1] }}
            transition={{ duration: profile.duration, times: [0, 0.24, 1], ease: [0.22, 1, 0.36, 1] }}
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'grid',
              placeItems: 'center',
              width: profile.emblemSize + 30,
              height: profile.emblemSize + 30,
              borderRadius: '50%',
              background: `radial-gradient(circle, rgba(${GOLD}, 0.12) 0%, rgba(${GOLD}, 0.04) 46%, transparent 70%)`,
              transform: 'translate3d(0, 0, 0)',
              willChange: 'transform, opacity',
            }}
          >
            <motion.img
              src={EMBLEM}
              alt=""
              draggable={false}
              decoding="async"
              fetchPriority="high"
              initial={{ opacity: 0, scale: profile.emblemScale[0], rotate: profile.emblemRotate[0] }}
              animate={{
                opacity: [0, 1, 1, 0.98],
                scale: profile.emblemScale,
                rotate: profile.emblemRotate,
              }}
              transition={{
                opacity: { duration: 0.34, ease: 'easeOut' },
                scale: {
                  duration: profile.duration,
                  times: [0, 0.2, 0.68, 1],
                  ease: 'easeInOut',
                },
                rotate: {
                  duration: profile.duration - 0.12,
                  ease: [0.18, 0.82, 0.28, 1],
                },
              }}
              style={{
                width: profile.emblemSize,
                height: profile.emblemSize,
                userSelect: 'none',
                transform: 'translate3d(0, 0, 0)',
                willChange: 'transform, opacity',
              }}
            />
          </motion.div>
    </motion.div>
  );

  return (
    <AnimatePresence>
      {visible ? (reduceMotion ? reducedContent : fullContent) : null}
    </AnimatePresence>
  );
};
