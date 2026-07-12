import React from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';

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
  /**
   * Phone-class / iPad-Safari render budget (computed by the parent from the
   * app's budget signals, not OS reduced-motion). When true, the loader drops
   * the offscreen-surface effects — the blurred warmth halo, the emblem's
   * drop-shadow, and the per-dot glow — that allocate a fresh IOSurface per
   * frame and flood WebKit's compositor budget on iOS. The orbital rotation,
   * warmth pulse, and emblem breathe (pure transform/opacity keyframes) KEEP
   * running so the loader still visibly animates on iPhone/iPad. Only OS
   * reduced-motion freezes the motion entirely.
   */
  lightweight?: boolean;
};

/** A gold dot that orbits a circular path of the given diameter. */
const Orbit: React.FC<{
  diameter: number;
  dotSize: number;
  duration: number;
  reverse?: boolean;
  spin: boolean; // false = reduced motion (no rotation)
  fade: boolean; // true = completion → dissolve the orbit
  glow: boolean; // false = low render budget (no blurred boxShadow halo)
}> = ({ diameter, dotSize, duration, reverse = false, spin, fade, glow }) => (
  <m.div
    aria-hidden
    className="absolute"
    style={{ width: diameter, height: diameter, borderRadius: '50%', willChange: 'transform' }}
    animate={{ rotate: spin ? (reverse ? -360 : 360) : 0, opacity: fade ? 0 : 1 }}
    transition={{
      rotate: spin ? { duration, repeat: Infinity, ease: 'linear' } : { duration: 0 },
      // Slightly longer than the old 0.45 so the orbit melts into the completion
      // bloom instead of snapping out before it — the dissolve reads as a settle.
      opacity: { duration: 0.6, ease: EASE_OUT },
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
        boxShadow: glow ? `0 0 ${Math.round(dotSize * 1.7)}px ${gold(0.5)}` : 'none',
      }}
    />
  </m.div>
);

function emblemFilter(complete: boolean, lightweight: boolean): string {
  if (lightweight) {
    // No drop-shadow: a blurred drop-shadow filter allocates an offscreen
    // surface that WebKit re-rasterizes per frame during the brightness/scale
    // settle. Brightness alone carries the gold "lift" with no extra layer.
    return complete ? 'brightness(1.4)' : 'brightness(1.12)';
  }
  return complete
    ? `drop-shadow(0 0 22px ${gold(0.6)}) brightness(1.5)`
    : `drop-shadow(0 0 14px ${gold(0.5)}) brightness(1.12)`;
}

export const ScentIntelligenceLoader: React.FC<ScentIntelligenceLoaderProps> = ({
  status,
  substatus,
  complete = false,
  lightweight = false,
}) => {
  const reduceMotion = useReducedMotion();
  // "calm" = honor the OS reduced-motion preference ONLY: fully static
  // end-states, no infinite animation. The render-budget `lightweight` flag must
  // NOT force calm — that was the regression that froze the orbital loader on
  // every iPhone and iPad. Orbital rotation, the warmth pulse, and the emblem
  // breathe are GPU-cheap transform/opacity keyframes that are safe on iOS.
  // `lightweight` keeps stripping only the offscreen-surface effects (blur halo,
  // emblem drop-shadow, per-dot box-shadow glow) that allocate a fresh IOSurface
  // per frame — the actual WebKit compositor-budget hazard.
  const calm = Boolean(reduceMotion);
  const spin = !calm;

  return (
    <div className="flex flex-col items-center justify-center text-center">
      {/* Orbital zone */}
      <div className="relative mb-7 grid h-[132px] w-[132px] place-items-center overflow-visible">
        {/* Radial warmth */}
        <m.div
          aria-hidden
          className="absolute"
          style={{
            width: 150,
            height: 150,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${gold(0.16)} 0%, ${gold(0.05)} 42%, transparent 70%)`,
            // The blurred halo is a full offscreen surface; drop it under a
            // constrained budget and let the soft radial gradient stand alone.
            filter: lightweight ? undefined : 'blur(6px)',
          }}
          animate={calm ? { opacity: 0.75 } : { opacity: complete ? [0.75, 1, 0.85] : [0.5, 0.78, 0.5] }}
          transition={
            calm
              ? { duration: 0.42, ease: EASE_OUT }
              : complete
                ? { duration: 0.62, ease: EASE_OUT }
                : { duration: 3.6, repeat: Infinity, ease: 'easeInOut' }
          }
        />

        {/* Static thin gold rings (brighten on complete; no rotation = no snap) */}
        <m.div
          aria-hidden
          className="absolute"
          style={{ width: 118, height: 118, borderRadius: '50%', border: `1px solid ${gold(0.16)}` }}
          animate={{ opacity: complete ? 0.5 : 0.28 }}
          transition={{ duration: 0.5, ease: EASE_OUT }}
        />
        <m.div
          aria-hidden
          className="absolute"
          style={{ width: 82, height: 82, borderRadius: '50%', border: `1px solid ${gold(0.22)}` }}
          animate={{ opacity: complete ? 0.6 : 0.34 }}
          transition={{ duration: 0.5, ease: EASE_OUT }}
        />

        {/* Orbiting dots carry the motion */}
        <Orbit diameter={118} dotSize={6} duration={4.6} spin={spin} fade={complete} glow={!lightweight} />
        <Orbit diameter={82} dotSize={5} duration={3.0} reverse spin={spin} fade={complete} glow={!lightweight} />

        {/* One-shot completion bloom */}
        <AnimatePresence>
          {complete && !calm && (
            <m.div
              key="bloom"
              aria-hidden
              className="absolute"
              style={{ width: 84, height: 84, borderRadius: '50%', border: `1px solid ${gold(0.5)}` }}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: [0.6, 1.9], opacity: [0.55, 0] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.78, ease: 'easeOut' }}
            />
          )}
        </AnimatePresence>

        {/* Center emblem — gentle breathing, soft settle on complete.
            The mount scale-in lives on an OUTER wrapper so it doesn't fight the
            inner breathing keyframes: Framer evaluates a keyframe array from
            index 0, so putting `scale: [1, 1.05, 1]` directly on the element
            with `initial={{ scale: 0.72 }}` made it jump 0.72 -> 1 instantly
            instead of easing in. Splitting the two motions keeps the reveal
            smooth. */}
        <m.div
          className="absolute flex items-center justify-center"
          initial={{ opacity: 0, scale: 0.72 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: calm ? 0.3 : 0.7, ease: EASE_OUT }}
        >
          <m.img
            src={EMBLEM}
            alt=""
            aria-hidden
            draggable={false}
            animate={
              calm
                ? { scale: 1, filter: emblemFilter(complete, lightweight) }
                : complete
                  ? { scale: [1, 1.14, 1.0], filter: emblemFilter(true, lightweight) }
                  : { scale: [1, 1.05, 1], filter: emblemFilter(false, lightweight) }
            }
            transition={
              calm
                ? { duration: 0.42, ease: EASE_OUT }
                : complete
                  ? { duration: 0.62, ease: EASE_OUT, times: [0, 0.4, 1] }
                  : {
                      scale: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' },
                      filter: { duration: 0.4 },
                    }
            }
            style={{ width: 46, height: 46, userSelect: 'none', pointerEvents: 'none', willChange: 'transform' }}
          />
        </m.div>
      </div>

      {/* Status — cross-fades, fixed min-height kills the width/height jolt.
          This is the single polite live region for the overlay; the veil in
          FragranceCapture deliberately carries no role to avoid double-announce. */}
      <div className="flex min-h-[2.1rem] items-center justify-center px-4" aria-live="polite" aria-atomic="true">
        <AnimatePresence mode="wait">
          <m.h3
            key={status}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
            className="font-serif italic text-xl text-foreground drop-shadow-[0_0_22px_rgba(212,175,55,0.16)]"
          >
            {status}
          </m.h3>
        </AnimatePresence>
      </div>

      {/* Substatus — hidden during the success settle */}
      <div className="mt-2 flex min-h-[0.9rem] items-center justify-center">
        <AnimatePresence>
          {substatus && !complete && (
            <m.p
              key="substatus"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: calm ? 0.5 : [0.32, 0.6, 0.32] }}
              exit={{ opacity: 0 }}
              transition={calm ? { duration: 0.3 } : { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
              className="text-[10px] uppercase tracking-[0.3em] font-sans font-bold italic text-scent-accent/45"
            >
              {substatus}
            </m.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
