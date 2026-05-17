import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  collectMainAccordDisplayRows,
  type DerivedMetrics,
} from '@/lib/fragranceApi';
import { NotePyramid } from './NotePyramid';

interface ScentNotesInfographicProps {
  /** Preferred: Railway `derived_metrics.notes` (+ main accords summary). */
  derivedMetrics?: DerivedMetrics | null;
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

function strengthValue(row: { score?: number; pct?: number }): number | null {
  const raw = typeof row.pct === "number" ? row.pct : typeof row.score === "number" ? row.score : null;
  if (raw === null || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, Math.round(raw)));
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

const ACCORD_ROW_EASE = [0.22, 1, 0.36, 1] as const;
const ACCORD_STAGGER_S = 0.048;
const ACCORD_ROW_DELAY_START = 0.08;

function useAccordPanelReveal(contentKey: string) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(Boolean(reduced));

  useEffect(() => {
    if (reduced) {
      setRevealed(true);
      return;
    }
    setRevealed(false);
  }, [contentKey, reduced]);

  useEffect(() => {
    if (reduced) return;
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          setRevealed(true);
          obs.disconnect();
        });
      },
      { threshold: 0.08, rootMargin: "40px 0px 14% 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [contentKey, reduced]);

  return { containerRef, revealed: Boolean(revealed || reduced), reduced: Boolean(reduced) };
}

function AccordPanel({
  rows,
  summary,
  className = "",
}: {
  rows: ReturnType<typeof collectMainAccordDisplayRows>;
  summary: string;
  className?: string;
}) {
  const accordContentKey =
    `${summary}|` +
    rows
      .slice(0, 10)
      .map((r) => `${r.label}:${strengthValue(r) ?? "_"}`)
      .join("·");

  const { containerRef, revealed, reduced } = useAccordPanelReveal(accordContentKey);

  const displayRows = rows.slice(0, 10);

  if (rows.length === 0 && !summary) {
    return (
      <Panel title="Main Accords" className={className}>
        <div className="flex flex-1 items-center justify-center px-4 py-6 text-center">
          <p className="text-sm italic text-white/45 font-serif">Accords unavailable.</p>
        </div>
      </Panel>
    );
  }

  const summaryAnimate = reduced
    ? { opacity: 1, filter: "blur(0px)", y: 0 }
    : revealed
      ? { opacity: 1, filter: "blur(0px)", y: 0 }
      : { opacity: 0.62, filter: "blur(4px)", y: 6 };

  return (
    <Panel title="Main Accords" className={className}>
      <div ref={containerRef} className="flex flex-1 flex-col justify-center space-y-4 px-4 py-5">
        {summary ? (
          <motion.p
            className="text-center text-sm italic text-white/58 font-serif leading-relaxed px-1"
            initial={false}
            animate={summaryAnimate}
            transition={{
              duration: reduced ? 0 : 0.42,
              ease: ACCORD_ROW_EASE,
              delay: reduced ? 0 : ACCORD_ROW_DELAY_START,
            }}
          >
            {summary}
          </motion.p>
        ) : null}
        <motion.div className="space-y-2.5" layout={false}>
          {displayRows.map((row, index) => {
            const value = strengthValue(row);
            const pct = value ?? 20;
            const rowDelay =
              ACCORD_ROW_DELAY_START + index * ACCORD_STAGGER_S;

            return (
              <motion.div
                key={row.label}
                className="grid grid-cols-[4.8rem_1fr_2.4rem] items-center gap-3"
                initial={false}
                animate={
                  reduced || revealed
                    ? { opacity: 1, y: 0, filter: "blur(0px)" }
                    : { opacity: 0, y: 10, filter: "blur(4px)" }
                }
                transition={{
                  duration: reduced ? 0 : 0.44,
                  ease: ACCORD_ROW_EASE,
                  delay: reduced ? 0 : rowDelay,
                }}
              >
                <p className="truncate text-xs text-white/68">{row.label}</p>
                <div className="h-px bg-white/10 overflow-hidden rounded-full">
                  <motion.div
                    className="h-px rounded-full bg-scent-accent shadow-[0_0_10px_rgba(201,139,44,0.32)]"
                    initial={false}
                    animate={{ width: reduced || revealed ? `${pct}%` : "0%" }}
                    transition={{
                      duration: reduced ? 0 : 0.58,
                      ease: ACCORD_ROW_EASE,
                      delay: reduced ? 0 : rowDelay + 0.06,
                    }}
                  />
                </div>
                <motion.p
                  className="text-right text-xs text-white/78 tabular-nums"
                  initial={false}
                  animate={{
                    opacity: reduced || revealed ? 1 : 0,
                  }}
                  transition={{
                    duration: reduced ? 0 : 0.22,
                    delay: reduced ? 0 : rowDelay + 0.18,
                  }}
                >
                  {value ?? "--"}
                </motion.p>
              </motion.div>
            );
          })}
        </motion.div>
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
  legacyPyramid,
  variant = "all",
  className = "",
}) => {
  const pyramid = normalizeDisplayPyramid(resolvePyramid(derivedMetrics, legacyPyramid));
  const accordRows = collectMainAccordDisplayRows(derivedMetrics?.main_accords);
  const accordSummary = derivedMetrics?.main_accords?.accord_summary?.trim() ?? '';
  const hasAccordVisual = accordRows.length > 0 || Boolean(accordSummary);
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
    return <AccordPanel rows={accordRows} summary={accordSummary} className={className} />;
  }

  if (variant === "notes") {
    return <NotesPanel pyramid={pyramid} className={className} />;
  }

  return (
    <div id="scent-notes-infographic" className="space-y-3 sm:space-y-4">
      <AccordPanel rows={accordRows} summary={accordSummary} />
      <NotesPanel pyramid={pyramid} />
    </div>
  );
};
