import React from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

/**
 * Premium loading state for the fragrance search / add-to-vault flow.
 * Replaces the generic border spinner with ScentCast's black-glass + gold
 * "orbital intelligence" language (see PageTransitionOverlay for the reference
 * vocabulary). Lives INSIDE the FragranceCapture search card, not full-screen.
 *
 * Motion contract:
 *  - Orbiting dots rotate continuously; on `complete` we fade them out — we
 *    NEVER tween `rotate` back to a fixed angle (that caused the old backward
 *    snap when syncComplete flipped).
 *  - Reduced motion: static gold mark, text cross-fades only.
 */

const EMBLEM = '/icons/transparent-emblem/scentbeam-emblem-96x96.png';
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Brand gold (the `--scent-gold-rgb` token, 212 175 55) at a given alpha.
 * Kept as a literal `rgba(...)` rather than `rgb(var(--scent-gold-rgb) / a)`
 * on purpose: the emblem's `filter` below is interpolated by framer-motion,
 * which cannot tween across a CSS custom property — a var() there would snap
 * instead of fade. Plain numbers keep the transition buttery.
 */
const gold = (alpha: number): string => `rgba(212, 175, 55, ${alpha})`;

export type ScentIntelligenceLoaderProps = {
  status: string;
  substatus?: string;
  complete?: boolean;
};

/** A gold dot that orbits a circular path of the given diameter. */
const Orbit: React.FC<{
  diameter: number;
  dotSize: number;
  duration: number;
  reverse?: boolean;
  spin: boolean; // false = reduced motion (no rotation)
  fade: boolean; // true = completion → dissolve the orbit
}> = ({ diameter, dotSize, duration, reverse = false, spin, fade }) => (
  <motion.div
    aria-hidden
    className="absolute"
    style={{ width: diameter, height: diameter, borderRadius: '50%', willChange: 'transform' }}
    animate={{ rotate: spin ? (reverse ? -360 : 360) : 0, opacity: fade ? 0 : 1 }}
    transition={{
      rotate: spin ? { duration, repeat: Infinity, ease: 'linear' } : { duration: 0 },
      opacity: { duration: 0.45, ease: EASE_OUT },
    }}
  >
    <span
      className="absolute left-1/2 top-0"
      style={{
        width: dotSize,
        height: dotSize,
        marginLeft: -dotSize / 2,
        marginTop: -dotSize / 2,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${gold(0.95)} 0%, ${gold(0.5)} 45%, transparent 72%)`,
        boxShadow: `0 0 ${Math.round(dotSize * 1.7)}px ${gold(0.5)}`,
      }}
    />
  </motion.div>
);

function emblemFilter(complete: boolean): string {
  return complete
    ? `drop-shadow(0 0 22px ${gold(0.6)}) brightness(1.5)`
    : `drop-shadow(0 0 14px ${gold(0.5)}) brightness(1.12)`;
}

export const ScentIntelligenceLoader: React.FC<ScentIntelligenceLoaderProps> = ({
  status,
  substatus,
  complete = false,
}) => {
  const reduceMotion = useReducedMotion();
  const spin = !reduceMotion;

  return (
    <div className="flex flex-col items-center justify-center text-center">
      {/* Orbital zone */}
      <div className="relative mb-7 grid h-[132px] w-[132px] place-items-center overflow-visible">
        {/* Radial warmth */}
        <motion.div
          aria-hidden
          className="absolute"
          style={{
            width: 150,
            height: 150,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${gold(0.16)} 0%, ${gold(0.05)} 42%, transparent 70%)`,
            filter: 'blur(6px)',
          }}
          animate={reduceMotion ? { opacity: 0.75 } : { opacity: complete ? [0.75, 1, 0.85] : [0.5, 0.78, 0.5] }}
          transition={
            reduceMotion
              ? { duration: 0.3 }
              : complete
                ? { duration: 0.5, ease: EASE_OUT }
                : { duration: 3.6, repeat: Infinity, ease: 'easeInOut' }
          }
        />

        {/* Static thin gold rings (brighten on complete; no rotation = no snap) */}
        <motion.div
          aria-hidden
          className="absolute"
          style={{ width: 118, height: 118, borderRadius: '50%', border: `1px solid ${gold(0.16)}` }}
          animate={{ opacity: complete ? 0.5 : 0.28 }}
          transition={{ duration: 0.5, ease: EASE_OUT }}
        />
        <motion.div
          aria-hidden
          className="absolute"
          style={{ width: 82, height: 82, borderRadius: '50%', border: `1px solid ${gold(0.22)}` }}
          animate={{ opacity: complete ? 0.6 : 0.34 }}
          transition={{ duration: 0.5, ease: EASE_OUT }}
        />

        {/* Orbiting dots carry the motion */}
        <Orbit diameter={118} dotSize={6} duration={4.6} spin={spin} fade={complete} />
        <Orbit diameter={82} dotSize={5} duration={3.0} reverse spin={spin} fade={complete} />

        {/* One-shot completion bloom */}
        <AnimatePresence>
          {complete && !reduceMotion && (
            <motion.div
              key="bloom"
              aria-hidden
              className="absolute"
              style={{ width: 84, height: 84, borderRadius: '50%', border: `1px solid ${gold(0.5)}` }}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: [0.6, 1.9], opacity: [0.55, 0] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.72, ease: 'easeOut' }}
            />
          )}
        </AnimatePresence>

        {/* Center emblem — gentle breathing, soft settle on complete */}
        <motion.img
          src={EMBLEM}
          alt=""
          aria-hidden
          draggable={false}
          initial={{ opacity: 0, scale: 0.72 }}
          animate={
            reduceMotion
              ? { opacity: 1, scale: 1, filter: emblemFilter(complete) }
              : complete
                ? { opacity: 1, scale: [1, 1.14, 1.0], filter: emblemFilter(true) }
                : { opacity: 1, scale: [1, 1.05, 1], filter: emblemFilter(false) }
          }
          transition={
            reduceMotion
              ? { duration: 0.3, ease: EASE_OUT }
              : complete
                ? { duration: 0.5, ease: EASE_OUT }
                : {
                    scale: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' },
                    opacity: { duration: 0.4 },
                    filter: { duration: 0.4 },
                  }
          }
          style={{ width: 46, height: 46, userSelect: 'none', pointerEvents: 'none', willChange: 'transform' }}
        />
      </div>

      {/* Status — cross-fades, fixed min-height kills the width/height jolt.
          This is the single polite live region for the overlay; the veil in
          FragranceCapture deliberately carries no role to avoid double-announce. */}
      <div className="flex min-h-[2.1rem] items-center justify-center px-4" aria-live="polite" aria-atomic="true">
        <AnimatePresence mode="wait">
          <motion.h3
            key={status}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
            className="font-serif italic text-xl text-[#fff7ec] drop-shadow-[0_0_22px_rgba(212,175,55,0.16)]"
          >
            {status}
          </motion.h3>
        </AnimatePresence>
      </div>

      {/* Substatus — hidden during the success settle */}
      <div className="mt-2 flex min-h-[0.9rem] items-center justify-center">
        <AnimatePresence>
          {substatus && !complete && (
            <motion.p
              key="substatus"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: reduceMotion ? 0.5 : [0.32, 0.6, 0.32] }}
              exit={{ opacity: 0 }}
              transition={reduceMotion ? { duration: 0.3 } : { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
              className="text-[10px] uppercase tracking-[0.3em] font-sans font-bold italic text-scent-accent/45"
            >
              {substatus}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
