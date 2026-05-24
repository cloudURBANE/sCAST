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
  const transition = prefersReducedMotion
    ? { duration: 0.12 }
    : { duration: 0.52, ease: CYCLE_EASE };

  const initial = prefersReducedMotion
    ? { opacity: 0 }
    : { opacity: 0, y: 7, filter: 'blur(4px)', scale: 0.985 };
  const animate = prefersReducedMotion
    ? { opacity: 1 }
    : { opacity: 1, y: 0, filter: 'blur(0px)', scale: 1 };
  const exit = prefersReducedMotion
    ? { opacity: 0 }
    : { opacity: 0, y: -6, filter: 'blur(3px)', scale: 0.992 };

  return (
    <div
      className="relative grid w-full place-items-center [&>*]:col-start-1 [&>*]:row-start-1"
      aria-live="polite"
      aria-atomic="true"
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={phase}
          initial={initial}
          animate={animate}
          exit={exit}
          transition={transition}
          className="flex w-full flex-col items-center justify-center"
        >
          <p className={primaryClass}>
            <span className="block leading-tight">{current.primary}</span>
          </p>
          <p className={secondaryClass}>
            <span className="block leading-snug">{current.secondary}</span>
          </p>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
