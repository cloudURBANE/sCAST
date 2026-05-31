import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

const EMBLEM = '/icons/transparent-emblem/scentbeam-emblem-192x192.png';
const GOLD = 'rgba(212, 175, 55,';
const SHOW_MS = 1180;

let emblemWarmPromise: Promise<void> | null = null;

function warmTransitionEmblem() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const existingPreload = document.querySelector<HTMLLinkElement>(`link[rel="preload"][href="${EMBLEM}"]`);
  if (!existingPreload) {
    const preload = document.createElement('link');
    preload.rel = 'preload';
    preload.as = 'image';
    preload.href = EMBLEM;
    document.head.appendChild(preload);
  }

  if (!emblemWarmPromise) {
    const image = new Image();
    image.decoding = 'async';
    image.src = EMBLEM;
    emblemWarmPromise = image.decode?.().catch(() => undefined) ?? Promise.resolve();
  }
}

export const PageTransitionOverlay: React.FC = () => {
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const prevPath = useRef(location.pathname);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    warmTransitionEmblem();
  }, []);

  useEffect(() => {
    if (location.pathname === prevPath.current) return;
    prevPath.current = location.pathname;

    warmTransitionEmblem();
    if (timer.current) clearTimeout(timer.current);
    setAnimKey(k => k + 1);
    setVisible(true);
    timer.current = setTimeout(() => setVisible(false), SHOW_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [location.pathname]);

  // When reduced motion is preferred, show a brief cross-fade only — no spinning or scaling.
  if (reduceMotion) {
    return (
      <AnimatePresence>
        {visible && (
          <motion.div
            key={animKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none"
            style={{
              background: `radial-gradient(ellipse 55% 50% at 50% 50%, rgba(16, 10, 2, 0.94) 0%, rgba(3, 2, 1, 0.97) 100%)`,
            }}
            aria-hidden="true"
            role="presentation"
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
              <img src={EMBLEM} alt="" draggable={false} style={{ width: 80, height: 80, userSelect: 'none' }} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={animKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.26, ease: 'easeInOut' }}
          className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none"
          style={{
            background: `radial-gradient(ellipse 55% 50% at 50% 50%, rgba(16, 10, 2, 0.96) 0%, rgba(3, 2, 1, 0.98) 100%)`,
            contain: 'layout paint',
            transform: 'translate3d(0, 0, 0)',
            willChange: 'opacity',
          }}
          aria-hidden="true"
          role="presentation"
        >
          {/* Diffuse gold bloom — expands and dissolves */}
          <motion.div
            initial={{ scale: 0.05, opacity: 0 }}
            animate={{
              scale: [0.05, 1.5, 3.2],
              opacity: [0, 0.32, 0],
            }}
            transition={{ duration: 1.18, times: [0, 0.35, 1], ease: 'easeOut' }}
            aria-hidden="true"
            style={{
              position: 'absolute',
              width: 240,
              height: 240,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${GOLD} 0.85) 0%, ${GOLD} 0.22) 45%, transparent 72%)`,
              pointerEvents: 'none',
              willChange: 'transform, opacity',
            }}
          />

          {/* Inner orbit ring — rotates outward */}
          <motion.div
            initial={{ scale: 0.18, opacity: 0, rotate: -120 }}
            animate={{
              scale: [0.18, 1.0, 1.55],
              opacity: [0, 0.45, 0],
              rotate: [-120, 60, 160],
            }}
            transition={{ duration: 1.1, times: [0, 0.42, 1], ease: [0.22, 1, 0.36, 1] }}
            aria-hidden="true"
            style={{
              position: 'absolute',
              width: 136,
              height: 136,
              borderRadius: '50%',
              border: `1px solid ${GOLD} 0.55)`,
              pointerEvents: 'none',
              willChange: 'transform, opacity',
            }}
          />

          {/* Outer orbit ring — slightly delayed, larger arc */}
          <motion.div
            initial={{ scale: 0.25, opacity: 0 }}
            animate={{
              scale: [0.25, 1.15, 2.0],
              opacity: [0, 0.22, 0],
            }}
            transition={{ duration: 1.1, delay: 0.06, times: [0, 0.4, 1], ease: 'easeOut' }}
            aria-hidden="true"
            style={{
              position: 'absolute',
              width: 172,
              height: 172,
              borderRadius: '50%',
              border: `0.5px solid ${GOLD} 0.28)`,
              pointerEvents: 'none',
              willChange: 'transform, opacity',
            }}
          />

          {/* Emblem + wordmark — centered stack */}
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 22,
            }}
          >
            <motion.img
              src={EMBLEM}
              alt=""
              draggable={false}
              initial={{ opacity: 0, scale: 0.65, rotate: 0 }}
              animate={{
                opacity: [0, 1, 1, 1],
                scale: [0.65, 1.0, 1.06, 1.0],
                rotate: [0, 360],
              }}
              exit={{ opacity: 0, scale: 0.88, transition: { duration: 0.28, ease: [0.4, 0, 1, 1] } }}
              transition={{
                opacity: { duration: 0.36, ease: 'easeOut' },
                scale: {
                  duration: 1.05,
                  times: [0, 0.18, 0.64, 1],
                  ease: 'easeInOut',
                },
                rotate: {
                  duration: 1.0,
                  ease: [0.18, 0.82, 0.28, 1],
                },
              }}
              style={{
                width: 96,
                height: 96,
                userSelect: 'none',
                filter: [
                  `drop-shadow(0 0 16px ${GOLD} 0.6))`,
                  `drop-shadow(0 0 42px ${GOLD} 0.22))`,
                  'brightness(1.2)',
                ].join(' '),
                willChange: 'transform, opacity',
              }}
            />

          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
