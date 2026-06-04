import React, { useEffect, useRef, type CSSProperties } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { isIpadStandalone } from '@/lib/platform';

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
  exitDuration: number;
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
  emblemGlow: string;
  showOuterRing: boolean;
}

const fullMotionProfile: MotionProfile = {
  duration: 1.28,
  exitDuration: 0.3,
  emblemSize: 96,
  bloomSize: 250,
  innerRingSize: 142,
  outerRingSize: 188,
  bloomScale: [0.18, 1.25, 2.5],
  bloomOpacity: [0, 0.34, 0],
  innerRingScale: [0.28, 1.02, 1.62],
  innerRingOpacity: [0, 0.48, 0],
  outerRingScale: [0.34, 1.12, 1.95],
  outerRingOpacity: [0, 0.24, 0],
  emblemRotate: [-10, 260, 360],
  emblemScale: [0.72, 1.02, 0.98, 1],
  emblemGlow: [
    `drop-shadow(0 0 16px rgba(${GOLD}, 0.56))`,
    `drop-shadow(0 0 42px rgba(${GOLD}, 0.2))`,
    'brightness(1.18)',
  ].join(' '),
  showOuterRing: true,
};

const compactMotionProfile: MotionProfile = {
  duration: 1.16,
  exitDuration: 0.24,
  emblemSize: 84,
  bloomSize: 194,
  innerRingSize: 126,
  outerRingSize: 164,
  bloomScale: [0.22, 1.05, 1.84],
  bloomOpacity: [0, 0.22, 0],
  innerRingScale: [0.36, 0.96, 1.34],
  innerRingOpacity: [0, 0.36, 0],
  outerRingScale: [0.46, 1.05, 1.52],
  outerRingOpacity: [0, 0.16, 0],
  emblemRotate: [-6, 170, 360],
  emblemScale: [0.78, 1, 0.97, 1],
  emblemGlow: `drop-shadow(0 0 18px rgba(${GOLD}, 0.28)) brightness(1.1)`,
  showOuterRing: true,
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
};

export const PageTransitionOverlay: React.FC<PageTransitionOverlayProps> = ({
  visible,
  animationKey,
}) => {
  const reduceMotion = useReducedMotion();
  const ipadStandalone = useRef(isIpadStandalone()).current;
  const profile = ipadStandalone ? compactMotionProfile : fullMotionProfile;

  useEffect(() => {
    warmTransitionEmblem();
  }, []);

  useEffect(() => {
    if (visible) warmTransitionEmblem();
  }, [visible]);

  if (reduceMotion) {
    return (
      <AnimatePresence initial={false}>
        {visible && (
          <motion.div
            key={animationKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none"
            style={reducedOverlayStyle}
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
        )}
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key={animationKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: profile.exitDuration, ease: 'easeInOut' }}
          className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none"
          style={overlayStyle}
          aria-hidden="true"
          role="presentation"
        >
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
            exit={{ opacity: 0, scale: 0.96, transition: { duration: profile.exitDuration, ease: [0.4, 0, 1, 1] } }}
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
                filter: profile.emblemGlow,
                transform: 'translate3d(0, 0, 0)',
                willChange: 'transform, opacity',
              }}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
