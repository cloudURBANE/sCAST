import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

export type CyclingPart = { primary: string; secondary: string };

const CYCLE_EASE: [number, number, number, number] = [0.33, 1, 0.68, 1];
const CYCLE_MS = 4500;

type CyclingTilePairProps = {
  parts: CyclingPart[];
  primaryClass: string;
  secondaryClass: string;
};

function CyclingTileContent({
  part,
  primaryClass,
  secondaryClass,
}: {
  part: CyclingPart;
  primaryClass: string;
  secondaryClass: string;
}) {
  return (
    <>
      <p className={primaryClass}>
        <span className="block leading-tight">{part.primary}</span>
      </p>
      <p className={secondaryClass}>
        <span className="block leading-snug">{part.secondary}</span>
      </p>
    </>
  );
}

/** Synced primary+secondary pair that crossfades through `parts` (e.g. Spring → Summer → Day). */
export function CyclingTilePair({ parts, primaryClass, secondaryClass }: CyclingTilePairProps) {
  const [phase, setPhase] = React.useState(0);
  const prefersReducedMotion = useReducedMotion();

  React.useEffect(() => {
    if (parts.length <= 1) return;
    const id = window.setInterval(() => setPhase((p) => (p + 1) % parts.length), CYCLE_MS);
    return () => window.clearInterval(id);
  }, [parts.length]);

  if (parts.length === 0) return null;

  const current = parts[phase % parts.length];

  if (parts.length === 1) {
    return (
      <CyclingTileContent part={current} primaryClass={primaryClass} secondaryClass={secondaryClass} />
    );
  }

  // Opacity + transform only — filter blur breaks on iOS Safari and can leave text invisible.
  const transition = prefersReducedMotion
    ? { duration: 0.28, ease: CYCLE_EASE }
    : { duration: 0.52, ease: CYCLE_EASE };

  const initial = prefersReducedMotion
    ? { opacity: 0 }
    : { opacity: 0, y: 8, scale: 0.985 };
  const animate = prefersReducedMotion
    ? { opacity: 1, y: 0, scale: 1 }
    : { opacity: 1, y: 0, scale: 1 };
  const exit = prefersReducedMotion
    ? { opacity: 0 }
    : { opacity: 0, y: -6, scale: 0.992 };

  return (
    <div className="relative w-full" aria-live="polite" aria-atomic="true">
      {/* Invisible sizer keeps tile height stable while absolute layers crossfade (Safari grid fix). */}
      <div className="invisible pointer-events-none flex w-full flex-col items-center justify-center" aria-hidden="true">
        <CyclingTileContent part={current} primaryClass={primaryClass} secondaryClass={secondaryClass} />
      </div>

      <div className="absolute inset-0 flex items-center justify-center overflow-visible">
        <AnimatePresence initial={false}>
          <motion.div
            key={phase}
            initial={initial}
            animate={animate}
            exit={exit}
            transition={transition}
            className="absolute inset-0 flex w-full flex-col items-center justify-center motion-safe:[transform:translateZ(0)] motion-safe:[backface-visibility:hidden] motion-safe:[will-change:transform,opacity]"
          >
            <CyclingTileContent part={current} primaryClass={primaryClass} secondaryClass={secondaryClass} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
