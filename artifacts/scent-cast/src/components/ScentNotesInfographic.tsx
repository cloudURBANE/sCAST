import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  type DerivedMetrics,
  type NumericScentAxes,
  normalizedAccordBarPct,
  resolveMainAccordChartRows,
} from '@/lib/fragranceApi';
import { NotePyramid } from './NotePyramid';

interface ScentNotesInfographicProps {
  /** Preferred: Railway `derived_metrics.notes` (+ main accords summary). */
  derivedMetrics?: DerivedMetrics | null;
  /** Top-level wardrobe/catalog 0–10 axes — used only when chart rows can't be inferred from metrics. */
  scentAxesFallback?: NumericScentAxes | null;
  /** Legacy wardrobe pyramid when engine notes are absent. */
  legacyPyramid?: {
    top: string[];
    heart: string[];
    base: string[];
  };
  /** Desktop modal renders accord and note panels in different columns. */
  variant?: "all" | "accords" | "notes";
  className?: string;
}

type DisplayPyramid = { top: string[]; heart: string[]; base: string[]; flat: string[] };

function resolvePyramid(
  derivedMetrics?: DerivedMetrics | null,
  legacy?: ScentNotesInfographicProps["legacyPyramid"],
): DisplayPyramid {
  const n = derivedMetrics?.notes;
  if (n) {
    return {
      top: [...(n.top ?? [])].filter(Boolean),
      heart: [...(n.heart ?? [])].filter(Boolean),
      base: [...(n.base ?? [])].filter(Boolean),
      flat: [...(n.flat ?? [])].filter(Boolean),
    };
  }
  if (legacy) {
    return {
      top: [...(legacy.top ?? [])].filter(Boolean),
      heart: [...(legacy.heart ?? [])].filter(Boolean),
      base: [...(legacy.base ?? [])].filter(Boolean),
      flat: [],
    };
  }
  return { top: [], heart: [], base: [], flat: [] };
}

function hasAnyNotes(p: DisplayPyramid): boolean {
  return p.top.length > 0 || p.heart.length > 0 || p.base.length > 0 || p.flat.length > 0;
}

function dedupeNotes(notes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const note of notes) {
    const clean = note.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function normalizeDisplayPyramid(pyramid: DisplayPyramid): DisplayPyramid {
  return {
    top: dedupeNotes(pyramid.top),
    heart: dedupeNotes(pyramid.heart),
    base: dedupeNotes(pyramid.base),
    flat: dedupeNotes(pyramid.flat),
  };
}

function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col border border-white/10 bg-white/[0.025] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] ${className}`}>
      <div className="border-b border-white/[0.07] px-4 py-3 text-center">
        <p className="text-[10px] uppercase tracking-[0.34em] text-white/70 font-bold">
          {title}
        </p>
      </div>
      {children}
    </section>
  );
}

const ACCORD_ROW_EASE = [0.2, 0.92, 0.18, 1] as const;
const ACCORD_STAGGER_S = 0.12;
const ACCORD_ROW_DELAY_START = 0.2;
const ACCORD_REVEAL_FALLBACK_MS = 1100;

function nearestOverflowScrollAncestor(start: HTMLElement | null): HTMLElement | null {
  if (typeof window === "undefined") return null;
  let cur: HTMLElement | null = start?.parentElement ?? null;
  while (cur && cur !== document.body) {
    const st = window.getComputedStyle(cur);
    const oy = st.overflowY;
    const ox = st.overflowX;
    const eligibleY = oy === "auto" || oy === "scroll" || oy === "overlay";
    const eligibleX = ox === "auto" || ox === "scroll" || ox === "overlay";
    const scrollish = (eligibleY || eligibleX) && (cur.scrollHeight > cur.clientHeight + 2 || cur.scrollWidth > cur.clientWidth + 2);
    if (scrollish) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function useAccordPanelReveal(contentKey: string) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(reduced);

  useEffect(() => {
    setRevealed(reduced);
  }, [contentKey, reduced]);

  useEffect(() => {
    if (reduced) {
      setRevealed(true);
      return;
    }

    let obs: IntersectionObserver | undefined;
    let fallbackTimer = 0;
    let cancelRaf = 0;

    const arm = () => {
      const el = containerRef.current;
      if (!el) return;
      const root = nearestOverflowScrollAncestor(el);

      obs = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const visible = entry.isIntersecting && entry.intersectionRatio > 0;
            if (!visible) return;
            setRevealed(true);
            obs?.disconnect();
            window.clearTimeout(fallbackTimer);
          });
        },
        {
          root,
          threshold: [0, 0.01, 0.08],
          rootMargin: "100px 0px 260px 0px",
        },
      );

      obs.observe(el);

      fallbackTimer = window.setTimeout(() => {
        setRevealed(true);
        obs?.disconnect();
      }, ACCORD_REVEAL_FALLBACK_MS);
    };

    cancelRaf = window.requestAnimationFrame(() => arm());

    return () => {
      window.cancelAnimationFrame(cancelRaf);
      window.clearTimeout(fallbackTimer);
      obs?.disconnect();
    };
  }, [contentKey, reduced]);

  return { containerRef, revealed: revealed || reduced, reduced };
}

function AccordPanel({
  rows,
  className = "",
}: {
  rows: ReturnType<typeof resolveMainAccordChartRows>;
  className?: string;
}) {
  const accordContentKey =
    rows
      .slice(0, 10)
      .map((r, i) => `${r.label}:${normalizedAccordBarPct(r, i, Math.max(1, rows.length))}`)
      .join("·");

  const { containerRef, revealed, reduced } = useAccordPanelReveal(accordContentKey);

  const displayRows = rows.slice(0, 10);

  if (rows.length === 0) {
    return (
      <Panel title="Main Accords" className={className}>
        <div className="flex flex-1 items-center justify-center px-4 py-6 text-center">
          <p className="text-sm italic text-white/45 font-serif">Accords unavailable.</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Main Accords" className={className}>
      <div
        ref={containerRef}
        className="flex flex-1 flex-col justify-center px-4 py-5 sm:px-5 sm:py-6"
        style={{ contain: "layout paint" }}
      >
        <motion.ul
          className="flex flex-col gap-y-2.5 sm:gap-y-3"
          layout={false}
          role="list"
        >
          {displayRows.map((row, index) => {
            const fillPct = normalizedAccordBarPct(row, index, displayRows.length);
            const rowDelay = ACCORD_ROW_DELAY_START + index * ACCORD_STAGGER_S;

            return (
              <motion.li
                key={`${row.label}:${index}`}
                className="grid items-center gap-x-3 sm:gap-x-4"
                style={{
                  gridTemplateColumns:
                    "clamp(4.5rem, 30%, 6.75rem) minmax(0, 1fr) 2.25rem",
                }}
                initial={false}
                animate={
                  reduced || revealed
                    ? { opacity: 1, y: 0 }
                    : { opacity: 0.22, y: 8 }
                }
                transition={{
                  duration: reduced ? 0 : 0.78,
                  ease: ACCORD_ROW_EASE,
                  delay: reduced ? 0 : rowDelay,
                }}
              >
                <p
                  className="min-w-0 truncate text-[10px] sm:text-[11px] uppercase tracking-[0.14em] leading-tight text-white/75"
                  title={row.label}
                >
                  {row.label}
                </p>
                <div className="relative h-2 sm:h-[9px] overflow-hidden rounded-full bg-white/[0.05] ring-1 ring-inset ring-white/[0.06] shadow-[inset_0_1px_2px_rgba(0,0,0,0.55)]">
                  <motion.div
                    className="relative h-full min-w-[3px] rounded-full bg-gradient-to-r from-[#b07a24] via-scent-accent to-[#ecd49d] shadow-[0_0_18px_rgba(201,139,44,0.32)]"
                    initial={false}
                    animate={{
                      width: reduced || revealed ? `${fillPct}%` : "2%",
                      opacity: reduced || revealed ? 1 : 0.32,
                    }}
                    transition={{
                      width: {
                        duration: reduced ? 0 : 1.08,
                        ease: ACCORD_ROW_EASE,
                        delay: reduced ? 0 : rowDelay + 0.14,
                      },
                      opacity: {
                        duration: reduced ? 0 : 0.55,
                        ease: ACCORD_ROW_EASE,
                        delay: reduced ? 0 : rowDelay + 0.08,
                      },
                    }}
                  >
                    <span
                      className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/30"
                      aria-hidden
                    />
                    <span
                      className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-white/25 to-transparent"
                      aria-hidden
                    />
                  </motion.div>
                </div>
                <motion.p
                  className="text-right text-[11px] sm:text-[12px] leading-none text-white/85 tabular-nums tracking-tight"
                  initial={false}
                  animate={{
                    opacity: reduced || revealed ? 1 : 0,
                  }}
                  transition={{
                    duration: reduced ? 0 : 0.45,
                    delay: reduced ? 0 : rowDelay + 0.28,
                  }}
                  aria-label={`${fillPct} percent`}
                >
                  {fillPct}
                </motion.p>
              </motion.li>
            );
          })}
        </motion.ul>
      </div>
    </Panel>
  );
}

function NotesPanel({
  pyramid,
  className = "",
}: {
  pyramid: DisplayPyramid;
  className?: string;
}) {
  return (
    <Panel title="Note Pyramid" className={`overflow-hidden ${className}`}>
      <NotePyramid
        topNotes={pyramid.top}
        heartNotes={pyramid.heart}
        baseNotes={pyramid.base}
      />
    </Panel>
  );
}

export const ScentNotesInfographic: React.FC<ScentNotesInfographicProps> = ({
  derivedMetrics,
  scentAxesFallback,
  legacyPyramid,
  variant = "all",
  className = "",
}) => {
  const pyramid = normalizeDisplayPyramid(resolvePyramid(derivedMetrics, legacyPyramid));
  const accordRows = resolveMainAccordChartRows(
    derivedMetrics?.main_accords,
    scentAxesFallback,
  );
  const hasAccordVisual = accordRows.length > 0;
  const hasPyramid = hasAnyNotes(pyramid);

  if (!hasPyramid && !hasAccordVisual && variant !== "notes") {
    return (
      <Panel title={variant === "accords" ? "Main Accords" : "Notes"} className={className}>
        <div className="flex flex-1 items-center justify-center px-4 py-6 text-center">
          <p className="text-sm italic text-white/45 font-serif">Notes unavailable for this fragrance.</p>
        </div>
      </Panel>
    );
  }

  if (variant === "accords") {
    return <AccordPanel rows={accordRows} className={className} />;
  }

  if (variant === "notes") {
    return <NotesPanel pyramid={pyramid} className={className} />;
  }

  return (
    <div id="scent-notes-infographic" className="space-y-3 sm:space-y-4">
      {accordRows.length > 0 ? <AccordPanel rows={accordRows} /> : null}
      <NotesPanel pyramid={pyramid} />
    </div>
  );
};
