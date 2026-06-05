import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  type DerivedMetrics,
  type MainAccordDisplayRow,
  type NumericScentAxes,
  normalizedAccordBarPct,
  resolveMainAccordChartRows,
} from '@/lib/fragranceApi';
import {
  collectLinkableMainAccordRows,
  normalizeAccordLabel,
  resolveNoteAccordLinks,
} from '@/lib/noteAccordLinks';
import { resolveDisplayPyramid } from '@/lib/fragranceNotes';
import { NotePyramid } from './NotePyramid';

interface ScentNotesInfographicProps {
  /** Preferred: Railway `derived_metrics.notes` (+ main accords summary). */
  derivedMetrics?: DerivedMetrics | null;
  /** Top-level wardrobe/catalog 0-10 axes - used only when chart rows can't be inferred from metrics. */
  scentAxesFallback?: NumericScentAxes | null;
  /** Legacy wardrobe pyramid when engine notes are absent. */
  legacyPyramid?: {
    top: string[];
    heart: string[];
    base: string[];
  };
  /** Desktop modal renders accord and note panels in different columns. */
  variant?: "all" | "accords" | "notes";
  /** Constrained touch devices get a static, low-cost note visual. */
  renderMode?: "full" | "constrained";
  className?: string;
}

type DisplayPyramid = { top: string[]; heart: string[]; base: string[]; flat: string[] };
type NoteLayerKey = "top" | "heart" | "base";
type ActiveNotesListener = () => void;

const EMPTY_ACTIVE_NOTES: string[] = [];
const activeNotesByScope = new Map<string, string[]>();
const activeNotesListeners = new Map<string, Set<ActiveNotesListener>>();

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

function pyramidScopeKey(pyramid: DisplayPyramid): string {
  return [pyramid.top, pyramid.heart, pyramid.base, pyramid.flat]
    .map((notes) => notes.map((note) => note.toLowerCase()).join(","))
    .join("|");
}

function sameNotes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((note, index) => note === b[index]);
}

function getActiveNotesSnapshot(scopeKey: string): string[] {
  return activeNotesByScope.get(scopeKey) ?? EMPTY_ACTIVE_NOTES;
}

function subscribeActiveNotes(scopeKey: string, listener: ActiveNotesListener): () => void {
  let listeners = activeNotesListeners.get(scopeKey);
  if (!listeners) {
    listeners = new Set<ActiveNotesListener>();
    activeNotesListeners.set(scopeKey, listeners);
  }

  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) activeNotesListeners.delete(scopeKey);
  };
}

function setActiveNotesSnapshot(scopeKey: string, notes: string[]) {
  const next = notes.length > 0 ? dedupeNotes(notes) : EMPTY_ACTIVE_NOTES;
  const current = getActiveNotesSnapshot(scopeKey);
  if (sameNotes(current, next)) return;

  if (next.length > 0) {
    activeNotesByScope.set(scopeKey, next);
  } else {
    activeNotesByScope.delete(scopeKey);
  }

  activeNotesListeners.get(scopeKey)?.forEach((listener) => listener());
}

function useActivePyramidNotes(scopeKey: string): string[] {
  return React.useSyncExternalStore(
    React.useCallback((listener) => subscribeActiveNotes(scopeKey, listener), [scopeKey]),
    React.useCallback(() => getActiveNotesSnapshot(scopeKey), [scopeKey]),
    () => EMPTY_ACTIVE_NOTES,
  );
}

function Panel({
  title,
  children,
  className = "",
  headerClassName = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
}) {
  return (
    <section className={`flex flex-col border border-white/[0.04] bg-gradient-to-b from-white/[0.018] to-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] ${className}`}>
      <div className={`border-b border-white/[0.05] px-4 py-3 text-center ${headerClassName}`}>
        <p className="text-[11px] uppercase tracking-[0.34em] text-white/70 font-bold">
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

function useAccordPanelReveal(contentKey: string, forceStatic = false) {
  const reducedMotion = useReducedMotion();
  const reduced = Boolean(reducedMotion || forceStatic);
  const containerRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(reduced);

  useEffect(() => {
    if (reduced) setRevealed(true);
  }, [reduced]);

  useEffect(() => {
    if (revealed) return;

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
  }, [contentKey, reduced, revealed]);

  return { containerRef, revealed: revealed || Boolean(reduced), reduced: Boolean(reduced) };
}

type AccordDensity = "relaxed" | "balanced" | "compact";

interface AccordDensityStyle {
  /** Vertical padding applied to the inner panel body. */
  bodyPadding: string;
  /** Track (bar) height. */
  trackHeight: string;
  /** Right-column width reserved for the numeric value. */
  valueColWidth: string;
  /** Left-column width reserved for the accord label (allows a 2-line wrap). */
  labelColWidth: string;
  /** Label / value typography. */
  labelFont: string;
  valueFont: string;
  /** Optional max-gap clamp so 3–4 rows don't drift into a vacuum. */
  maxGap: string;
}

const DENSITY: Record<AccordDensity, AccordDensityStyle> = {
  relaxed: {
    bodyPadding: "px-4 py-4 sm:px-5 sm:py-5",
    trackHeight: "h-[9px] sm:h-[10px]",
    valueColWidth: "2.75rem",
    labelColWidth: "clamp(5.25rem, 34%, 8.75rem)",
    labelFont: "text-[10.5px] sm:text-[11.5px] tracking-[0.16em]",
    valueFont: "text-[11.5px] sm:text-[12.5px]",
    maxGap: "max-h-[3.35rem]",
  },
  balanced: {
    bodyPadding: "px-4 py-3.5 sm:px-5 sm:py-4",
    trackHeight: "h-[7px] sm:h-[8px]",
    valueColWidth: "2.75rem",
    labelColWidth: "clamp(5rem, 35%, 8.25rem)",
    labelFont: "text-[10px] sm:text-[11px] tracking-[0.14em]",
    valueFont: "text-[11px] sm:text-[12px]",
    maxGap: "max-h-[2.85rem]",
  },
  compact: {
    bodyPadding: "px-4 py-3 sm:px-5 sm:py-3.5",
    trackHeight: "h-[6px] sm:h-[7px]",
    valueColWidth: "2.55rem",
    labelColWidth: "clamp(4.75rem, 36%, 7.75rem)",
    labelFont: "text-[9.5px] sm:text-[10.5px] tracking-[0.12em]",
    valueFont: "text-[10.5px] sm:text-[11.5px]",
    maxGap: "max-h-[2.45rem]",
  },
};

function resolveAccordDensity(count: number): AccordDensity {
  if (count <= 4) return "relaxed";
  if (count <= 7) return "balanced";
  return "compact";
}

/** Rank ramp: rank 0 = strongest accord (full intensity), trailing rows quieter. */
function rankIntensity(index: number, total: number): {
  labelOpacity: number;
  valueOpacity: number;
  barOpacity: number;
  glow: string;
  labelWeight: number;
} {
  const t = total <= 1 ? 0 : index / (total - 1);
  const labelOpacity = 1 - t * 0.34; // 1.00 → ~0.66
  const valueOpacity = 1 - t * 0.30; // 1.00 → ~0.70
  const barOpacity = 1 - t * 0.22;   // 1.00 → ~0.78
  const glowAlpha = (0.34 - t * 0.26).toFixed(3); // 0.34 → ~0.08
  const glow = `0 0 ${18 - t * 10}px rgba(212,175,55,${glowAlpha})`;
  const labelWeight = index === 0 ? 600 : 500;
  return { labelOpacity, valueOpacity, barOpacity, glow, labelWeight };
}

function AccordPanel({
  rows,
  activeNotes = EMPTY_ACTIVE_NOTES,
  renderMode = "full",
  className = "",
}: {
  rows: ReturnType<typeof resolveMainAccordChartRows>;
  activeNotes?: string[];
  renderMode?: "full" | "constrained";
  className?: string;
}) {
  const accordContentKey =
    rows
      .slice(0, 10)
      .map((r, i) => `${r.label}:${normalizedAccordBarPct(r, i, Math.max(1, rows.length))}`)
      .join("·");

  const constrained = renderMode === "constrained";
  const { containerRef, revealed, reduced } = useAccordPanelReveal(accordContentKey, constrained);

  const displayRows = rows.slice(0, 10);
  const density = resolveAccordDensity(displayRows.length);
  const densityStyle = DENSITY[density];
  const activeAccordLabels = React.useMemo(() => {
    if (activeNotes.length === 0 || displayRows.length === 0) return new Set<string>();
    return new Set(
      [...resolveNoteAccordLinks(activeNotes, displayRows).values()].map((link) =>
        normalizeAccordLabel(link.row.label),
      ),
    );
  }, [activeNotes, displayRows]);

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
        className={`flex flex-1 flex-col ${densityStyle.bodyPadding}`}
        style={{ contain: "layout paint" }}
      >
        <motion.ul
          className="flex flex-1 flex-col justify-evenly"
          layout={false}
          role="list"
        >
          {displayRows.map((row, index) => {
            const fillPct = normalizedAccordBarPct(row, index, displayRows.length);
            const rowDelay = ACCORD_ROW_DELAY_START + index * ACCORD_STAGGER_S;
            const intensity = rankIntensity(index, displayRows.length);
            const isPyramidMatch = activeAccordLabels.has(normalizeAccordLabel(row.label));
            const activeGlow = `0 0 ${Math.round(16 + fillPct * 0.06)}px rgba(252,157,25,0.62)`;
            const restingGlow = isPyramidMatch
              ? `${intensity.glow}, 0 0 0 1px rgba(252,157,25,0.34)`
              : intensity.glow;

            return (
              <motion.li
                key={row.label}
                className={`grid items-center gap-x-3 sm:gap-x-4 ${densityStyle.maxGap}`}
                style={{
                  gridTemplateColumns: `${densityStyle.labelColWidth} minmax(0, 1fr) ${densityStyle.valueColWidth}`,
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
                  className={`min-w-0 uppercase leading-tight text-white line-clamp-2 [overflow-wrap:anywhere] ${densityStyle.labelFont}`}
                  style={{
                    opacity: intensity.labelOpacity,
                    fontWeight: intensity.labelWeight,
                    textShadow: isPyramidMatch ? "0 0 14px rgba(252,157,25,0.52)" : undefined,
                  }}
                  title={row.label}
                >
                  {row.label}
                </p>
                <div
                  className={`relative ${densityStyle.trackHeight} overflow-hidden rounded-full bg-black/30 ring-1 ring-inset ${isPyramidMatch ? "ring-[#fc9d19]/40" : "ring-white/[0.05]"} shadow-[inset_0_1px_2px_rgba(0,0,0,0.6),inset_0_-1px_0_rgba(255,255,255,0.03)]`}
                >
                  <motion.div
                    className="relative h-full min-w-[3px] origin-left rounded-full bg-gradient-to-r from-[#b07a24] via-scent-accent to-[#ecd49d]"
                    // Width is static; the reveal animates `scaleX` (origin-left)
                    // instead of `width` so up to 10 bars don't trigger per-frame
                    // layout on reveal. The track's overflow-hidden rounded-full
                    // clips the scaled fill, so no corner/edge distortion shows.
                    style={{ width: `${fillPct}%`, boxShadow: restingGlow, willChange: reduced ? "auto" : "transform" }}
                    initial={false}
                    animate={{
                      scaleX: reduced || revealed ? 1 : 0.06,
                      opacity: reduced || revealed ? intensity.barOpacity : 0.32,
                      boxShadow: isPyramidMatch ? `${restingGlow}, ${activeGlow}` : restingGlow,
                      filter: isPyramidMatch && !reduced ? "brightness(1.16)" : "brightness(1)",
                    }}
                    transition={{
                      scaleX: {
                        duration: reduced ? 0 : 1.08,
                        ease: ACCORD_ROW_EASE,
                        delay: reduced ? 0 : rowDelay + 0.14,
                      },
                      opacity: {
                        duration: reduced ? 0 : 0.55,
                        ease: ACCORD_ROW_EASE,
                        delay: reduced ? 0 : rowDelay + 0.08,
                      },
                      boxShadow: { duration: 0.2 },
                      filter: { duration: 0.2 },
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
                  {isPyramidMatch ? (
                    <motion.span
                      className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#fc9d19]"
                      style={{ left: `${fillPct}%` }}
                      initial={false}
                      animate={{
                        opacity: reduced ? 0.82 : 0.92,
                        scale: reduced ? 1 : 1.08,
                        boxShadow: "0 0 12px rgba(252,157,25,0.68)",
                      }}
                      transition={{ duration: 0.2 }}
                      aria-hidden
                    />
                  ) : null}
                </div>
                <motion.p
                  className={`text-right leading-none text-white tabular-nums tracking-tight ${densityStyle.valueFont}`}
                  initial={false}
                  animate={{
                    opacity: reduced || revealed ? intensity.valueOpacity : 0,
                  }}
                  transition={{
                    duration: reduced ? 0 : 0.45,
                    delay: reduced ? 0 : rowDelay + 0.28,
                  }}
                  aria-label={`${fillPct} percent`}
                >
                  {fillPct}%
                </motion.p>
              </motion.li>
            );
          })}
        </motion.ul>
      </div>
    </Panel>
  );
}

function ConstrainedNotesPanel({
  pyramid,
  onActiveNotesChange,
  className = "",
}: {
  pyramid: DisplayPyramid;
  onActiveNotesChange?: (notes: string[]) => void;
  className?: string;
}) {
  const layers = React.useMemo(
    () => [
      { key: "top" as NoteLayerKey, title: "Top", notes: pyramid.top },
      { key: "heart" as NoteLayerKey, title: "Heart", notes: pyramid.heart },
      { key: "base" as NoteLayerKey, title: "Base", notes: pyramid.base },
    ],
    [pyramid],
  );
  const firstLayerWithNotes = layers.find((layer) => layer.notes.length > 0)?.key ?? null;
  const [activeLayer, setActiveLayer] = useState<NoteLayerKey | null>(firstLayerWithNotes);
  const activeNotes = layers.find((layer) => layer.key === activeLayer)?.notes ?? EMPTY_ACTIVE_NOTES;
  const allLayerNotes = React.useMemo(
    () => dedupeNotes(layers.flatMap((layer) => layer.notes)),
    [layers],
  );
  const visibleNotes = activeLayer
    ? activeNotes
    : (pyramid.flat.length > 0 ? pyramid.flat : allLayerNotes);

  useEffect(() => {
    setActiveLayer(firstLayerWithNotes);
  }, [firstLayerWithNotes]);

  useEffect(() => {
    onActiveNotesChange?.(activeNotes);
    return () => onActiveNotesChange?.([]);
  }, [activeNotes, onActiveNotesChange]);

  if (!layers.some((layer) => layer.notes.length > 0) && pyramid.flat.length === 0) {
    return (
      <Panel title="Note Pyramid" className={className}>
        <div className="flex flex-1 items-center justify-center px-4 py-6 text-center">
          <p className="text-sm italic text-white/45 font-serif">Notes unavailable.</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Note Pyramid" className={className}>
      <div className="flex flex-1 flex-col gap-3 px-4 py-4 sm:px-5">
        <div className="grid grid-cols-3 gap-1.5">
          {layers.map((layer) => {
            const isActive = activeLayer === layer.key;
            const disabled = layer.notes.length === 0;
            return (
              <button
                key={layer.key}
                type="button"
                disabled={disabled}
                onClick={() => setActiveLayer((current) => (current === layer.key ? null : layer.key))}
                className={`min-h-[3.6rem] border px-2 py-2 text-center transition-colors ${
                  isActive
                    ? "border-scent-accent/38 bg-scent-accent/[0.075] text-scent-accent"
                    : "border-white/[0.07] bg-white/[0.025] text-white/62"
                } disabled:opacity-35`}
                aria-pressed={isActive}
              >
                <span className="block text-[9px] font-bold uppercase tracking-[0.2em]">
                  {layer.title}
                </span>
                <span className="mt-1 block text-[10px] tabular-nums text-white/42">
                  {layer.notes.length}
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-h-[9.5rem] border border-white/[0.055] bg-black/18 px-3 py-3">
          {visibleNotes.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2">
              {visibleNotes.map((note) => (
                <span
                  key={note}
                  className="max-w-full rounded-full border border-white/[0.07] bg-white/[0.025] px-3 py-1.5 text-[10px] font-medium leading-snug text-white/72 [overflow-wrap:anywhere]"
                >
                  {note}
                </span>
              ))}
            </div>
          ) : (
            <p className="py-7 text-center text-sm italic text-white/45 font-serif">
              No notes listed for this layer.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function NotesPanel({
  pyramid,
  accordRows,
  onActiveNotesChange,
  renderMode = "full",
  className = "",
}: {
  pyramid: DisplayPyramid;
  accordRows?: MainAccordDisplayRow[];
  onActiveNotesChange?: (notes: string[]) => void;
  renderMode?: "full" | "constrained";
  className?: string;
}) {
  if (renderMode === "constrained") {
    return (
      <ConstrainedNotesPanel
        pyramid={pyramid}
        onActiveNotesChange={onActiveNotesChange}
        className={className}
      />
    );
  }

  return (
    <Panel title="Note Pyramid" className={`overflow-hidden ${className}`}>
      <NotePyramid
        topNotes={pyramid.top}
        heartNotes={pyramid.heart}
        baseNotes={pyramid.base}
        accordRows={accordRows}
        onActiveNotesChange={onActiveNotesChange}
      />
    </Panel>
  );
}

export const ScentNotesInfographic: React.FC<ScentNotesInfographicProps> = ({
  derivedMetrics,
  scentAxesFallback,
  legacyPyramid,
  variant = "all",
  renderMode = "full",
  className = "",
}) => {
  const pyramid = React.useMemo(
    () => normalizeDisplayPyramid(resolveDisplayPyramid(derivedMetrics?.notes, legacyPyramid)),
    [derivedMetrics, legacyPyramid],
  );
  const accordRows = React.useMemo(
    () => resolveMainAccordChartRows(derivedMetrics?.main_accords, scentAxesFallback),
    [derivedMetrics?.main_accords, scentAxesFallback],
  );
  const noteAccordRows = React.useMemo(
    () => collectLinkableMainAccordRows(derivedMetrics?.main_accords),
    [derivedMetrics?.main_accords],
  );
  const hasAccordVisual = accordRows.length > 0;
  const hasPyramid = hasAnyNotes(pyramid);
  const scopeKey = React.useMemo(() => pyramidScopeKey(pyramid), [pyramid]);
  const activeNotes = useActivePyramidNotes(scopeKey);
  const handleActiveNotesChange = React.useCallback(
    (notes: string[]) => setActiveNotesSnapshot(scopeKey, notes),
    [scopeKey],
  );

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
    return <AccordPanel rows={accordRows} activeNotes={activeNotes} renderMode={renderMode} className={className} />;
  }

  if (variant === "notes") {
    return (
      <NotesPanel
        pyramid={pyramid}
        accordRows={noteAccordRows}
        onActiveNotesChange={handleActiveNotesChange}
        renderMode={renderMode}
        className={className}
      />
    );
  }

  return (
    <div id="scent-notes-infographic" className="space-y-3 sm:space-y-4">
      {accordRows.length > 0 ? <AccordPanel rows={accordRows} activeNotes={activeNotes} renderMode={renderMode} /> : null}
      <NotesPanel
        pyramid={pyramid}
        accordRows={noteAccordRows}
        onActiveNotesChange={handleActiveNotesChange}
        renderMode={renderMode}
      />
    </div>
  );
};
