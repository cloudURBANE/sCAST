import React from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { type MainAccordDisplayRow } from '@/lib/fragranceApi';
import { resolveNoteAccordLinks, type NoteAccordLink } from '@/lib/noteAccordLinks';

type ActiveLayer = 'top' | 'heart' | 'base';
type Point = readonly [number, number];

type NotePyramidProps = {
  topNotes: string[];
  heartNotes: string[];
  baseNotes: string[];
  accordRows?: MainAccordDisplayRow[];
  onActiveNotesChange?: (notes: string[]) => void;
  className?: string;
};

type LayerConfig = {
  key: ActiveLayer;
  title: string;
  ariaLabel: string;
  hitPath: string;
  faces: readonly [string, string];
  faceFills: readonly [string, string];
  polishFill: string;
  grainFill: string;
  revealClass: string;
  grainOpacity: number;
  polishOpacity: number;
  rimOpacity: number;
  channel: {
    start: Point;
    end: Point;
  };
  notes: string[];
};

const CALM_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SOFT_EASE: [number, number, number, number] = [0.42, 0, 0.58, 1];

type LayerMotionState = ActiveLayer | 'idle';
type LayerOffset = { y: number; scale: number; opacity: number };
type PointerActivation = { layer: ActiveLayer; pointerId: number; x: number; y: number };

const LAYER_MOTION: Record<LayerMotionState, Record<ActiveLayer, LayerOffset>> = {
  idle: {
    top: { y: 0, scale: 1, opacity: 1 },
    heart: { y: 0, scale: 1, opacity: 1 },
    base: { y: 0, scale: 1, opacity: 1 },
  },
  top: {
    top: { y: -18, scale: 1.035, opacity: 1 },
    heart: { y: 14, scale: 0.98, opacity: 0.35 },
    base: { y: 14, scale: 0.975, opacity: 0.25 },
  },
  heart: {
    top: { y: -16, scale: 0.985, opacity: 0.45 },
    heart: { y: 0, scale: 1.035, opacity: 1 },
    base: { y: 16, scale: 0.985, opacity: 0.45 },
  },
  base: {
    top: { y: -14, scale: 0.975, opacity: 0.25 },
    heart: { y: -14, scale: 0.98, opacity: 0.35 },
    base: { y: 18, scale: 1.035, opacity: 1 },
  },
};

const layerTransition: Transition = {
  duration: 0.48,
  ease: CALM_EASE,
};

const reducedTransition: Transition = {
  duration: 0.01,
};

const PYRAMID_CENTER_X = 180;
const TAP_MOVE_TOLERANCE_PX = 10;
const TYPEWRITER_FRAME_MS = 24;
const NOTE_MARQUEE_MIN_CHARS = 58;
const NOTE_MARQUEE_MIN_COUNT = 5;
const NO_ACTIVE_NOTES: string[] = [];
const LAYER_CENTER_Y: Record<ActiveLayer, number> = {
  top: 82,
  heart: 200,
  base: 319,
};

const PYRAMID_OUTER = {
  apex: [PYRAMID_CENTER_X, 25] as Point,
  leftBase: [21, 372] as Point,
  rightBase: [339, 372] as Point,
};

const PYRAMID_Y = {
  topBottom: 136,
  heartTop: 145,
  heartBottom: 255,
  baseTop: 266,
  baseBottom: 372,
};

function svgNumber(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2).replace(/\.?0+$/, '');
}

function pointToken([x, y]: Point) {
  return `${svgNumber(x)} ${svgNumber(y)}`;
}

function polygonPath(points: readonly Point[]) {
  return `M${points.map(pointToken).join(' L')} Z`;
}

function linePath(from: Point, to: Point) {
  return `M${pointToken(from)} L${pointToken(to)}`;
}

function pointOnEdge(edgeEnd: Point, y: number): Point {
  const [apexX, apexY] = PYRAMID_OUTER.apex;
  const [endX, endY] = edgeEnd;
  const progress = (y - apexY) / (endY - apexY);

  return [apexX + (endX - apexX) * progress, y];
}

function tierHitPath(topY: number, bottomY: number) {
  return polygonPath([
    pointOnEdge(PYRAMID_OUTER.leftBase, topY),
    pointOnEdge(PYRAMID_OUTER.rightBase, topY),
    pointOnEdge(PYRAMID_OUTER.rightBase, bottomY),
    pointOnEdge(PYRAMID_OUTER.leftBase, bottomY),
  ]);
}

function tierFaces(topY: number, bottomY: number): readonly [string, string] {
  return [
    polygonPath([
      pointOnEdge(PYRAMID_OUTER.leftBase, topY),
      [PYRAMID_CENTER_X, topY],
      [PYRAMID_CENTER_X, bottomY],
      pointOnEdge(PYRAMID_OUTER.leftBase, bottomY),
    ]),
    polygonPath([
      [PYRAMID_CENTER_X, topY],
      pointOnEdge(PYRAMID_OUTER.rightBase, topY),
      pointOnEdge(PYRAMID_OUTER.rightBase, bottomY),
      [PYRAMID_CENTER_X, bottomY],
    ]),
  ];
}

function apexFaces(bottomY: number): readonly [string, string] {
  const apex = PYRAMID_OUTER.apex;

  return [
    polygonPath([apex, [PYRAMID_CENTER_X, bottomY], pointOnEdge(PYRAMID_OUTER.leftBase, bottomY)]),
    polygonPath([apex, pointOnEdge(PYRAMID_OUTER.rightBase, bottomY), [PYRAMID_CENTER_X, bottomY]]),
  ];
}

const layerGeometry = {
  base: {
    hitPath: tierHitPath(PYRAMID_Y.baseTop, PYRAMID_Y.baseBottom),
    faces: tierFaces(PYRAMID_Y.baseTop, PYRAMID_Y.baseBottom),
    channel: {
      start: [PYRAMID_CENTER_X, PYRAMID_Y.baseTop + 6] as Point,
      end: [PYRAMID_CENTER_X, PYRAMID_Y.baseBottom - 7] as Point,
    },
  },
  heart: {
    hitPath: tierHitPath(PYRAMID_Y.heartTop, PYRAMID_Y.heartBottom),
    faces: tierFaces(PYRAMID_Y.heartTop, PYRAMID_Y.heartBottom),
    channel: {
      start: [PYRAMID_CENTER_X, PYRAMID_Y.heartTop + 6] as Point,
      end: [PYRAMID_CENTER_X, PYRAMID_Y.heartBottom - 6] as Point,
    },
  },
  top: {
    hitPath: polygonPath([
      PYRAMID_OUTER.apex,
      pointOnEdge(PYRAMID_OUTER.rightBase, PYRAMID_Y.topBottom),
      pointOnEdge(PYRAMID_OUTER.leftBase, PYRAMID_Y.topBottom),
    ]),
    faces: apexFaces(PYRAMID_Y.topBottom),
    channel: {
      start: [PYRAMID_CENTER_X, PYRAMID_OUTER.apex[1] + 9] as Point,
      end: [PYRAMID_CENTER_X, PYRAMID_Y.topBottom - 8] as Point,
    },
  },
} satisfies Record<ActiveLayer, Pick<LayerConfig, 'hitPath' | 'faces' | 'channel'>>;

function formatNotes(notes: string[]) {
  return notes.length > 0 ? notes.join(', ') : 'Uncharted territory.';
}

function shouldMarqueeNotes(notes: string[], text: string) {
  return notes.length >= NOTE_MARQUEE_MIN_COUNT || text.length >= NOTE_MARQUEE_MIN_CHARS;
}

function typewriterChunkSize(textLength: number) {
  const targetMs = Math.min(880, Math.max(360, textLength * 16));
  const frames = Math.max(1, Math.ceil(targetMs / TYPEWRITER_FRAME_MS));
  return Math.max(1, Math.ceil(textLength / frames));
}

function offsetPoint([x, y]: Point, dx: number): Point {
  return [x + dx, y];
}

function useTypedNoteText(text: string, instant: boolean) {
  const [typedText, setTypedText] = React.useState(instant ? text : '');
  const [isComplete, setIsComplete] = React.useState(instant);

  React.useEffect(() => {
    if (instant) {
      setTypedText(text);
      setIsComplete(true);
      return;
    }

    let index = 0;
    const chunkSize = typewriterChunkSize(text.length);
    let completeTimer: number | undefined;

    setTypedText('');
    setIsComplete(false);

    const interval = window.setInterval(() => {
      index = Math.min(text.length, index + chunkSize);
      setTypedText(text.slice(0, index));

      if (index >= text.length) {
        window.clearInterval(interval);
        completeTimer = window.setTimeout(() => setIsComplete(true), 220);
      }
    }, TYPEWRITER_FRAME_MS);

    return () => {
      window.clearInterval(interval);
      if (completeTimer) window.clearTimeout(completeTimer);
    };
  }, [instant, text]);

  return { typedText, isComplete };
}

function LayerNotesText({
  notes,
  prefersReducedMotion,
  transition,
}: {
  notes: string[];
  prefersReducedMotion: boolean;
  transition: Transition;
}) {
  const fullText = React.useMemo(() => formatNotes(notes), [notes]);
  const shouldMarquee = shouldMarqueeNotes(notes, fullText) && !prefersReducedMotion;
  const { typedText, isComplete } = useTypedNoteText(fullText, prefersReducedMotion);
  const marqueeGroupRef = React.useRef<HTMLSpanElement | null>(null);
  const [marqueeDistance, setMarqueeDistance] = React.useState(0);

  React.useEffect(() => {
    setMarqueeDistance(0);
  }, [fullText]);

  React.useEffect(() => {
    if (!shouldMarquee || !isComplete) return;

    const group = marqueeGroupRef.current;
    if (!group) return;

    const updateDistance = () => {
      setMarqueeDistance(Math.ceil(group.getBoundingClientRect().width));
    };

    updateDistance();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(updateDistance);
    observer.observe(group);

    return () => observer.disconnect();
  }, [fullText, isComplete, shouldMarquee]);

  const marqueeDuration = Math.max(8, Math.min(18, fullText.length * 0.13));
  const marqueeStyle = {
    '--note-marquee-distance': `${marqueeDistance}px`,
    '--note-marquee-duration': `${marqueeDuration}s`,
  } as React.CSSProperties;

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={transition}
      className={`scent-note-text-shell text-[9.5px] sm:text-[11px] !leading-normal ${shouldMarquee ? 'scent-note-text-shell--marquee' : ''}`}
    >
      {shouldMarquee && isComplete ? (
        <>
          <span className="sr-only">{fullText}</span>
          <div className="scent-note-marquee" aria-hidden="true">
            <div
              className="scent-note-marquee-track"
              data-marquee-ready={marqueeDistance > 0 ? 'true' : 'false'}
              style={marqueeStyle}
            >
              <span ref={marqueeGroupRef} className="scent-note-marquee-group">
                {fullText}
              </span>
              <span className="scent-note-marquee-group">{fullText}</span>
            </div>
          </div>
        </>
      ) : (
        <p className={`scent-note-copy min-h-[1.5rem] sm:min-h-[2.1rem] ${shouldMarquee ? 'scent-note-copy--single-line' : ''}`} aria-label={fullText}>
          {typedText}
          {!isComplete ? <span className="scent-note-type-caret" aria-hidden="true" /> : null}
        </p>
      )}
    </motion.div>
  );
}

function MatchedNoteChip({
  note,
  link,
  prefersReducedMotion,
}: {
  note: string;
  link: NoteAccordLink;
  prefersReducedMotion: boolean;
}) {
  const pct = link.displayPct;
  const glowRadius = Math.round(5 + pct * 0.08);
  const glowAlpha = ((pct / 100) * 0.62).toFixed(2);
  const pulseDuration = 2.4 + (1 - pct / 100) * 0.8;

  return (
    <motion.span
      title={`${link.row.label} · ${pct}%`}
      style={{ textShadow: `0 0 ${glowRadius}px rgba(252,157,25,${prefersReducedMotion ? "0.28" : glowAlpha})` }}
      animate={
        prefersReducedMotion
          ? undefined
          : {
              opacity: [0.82, 1, 0.82],
              textShadow: [
                `0 0 ${Math.max(3, glowRadius - 4)}px rgba(252,157,25,0.28)`,
                `0 0 ${glowRadius}px rgba(252,157,25,${glowAlpha})`,
                `0 0 ${Math.max(3, glowRadius - 4)}px rgba(252,157,25,0.28)`,
              ],
            }
      }
      transition={
        prefersReducedMotion
          ? undefined
          : { duration: pulseDuration, repeat: Infinity, ease: 'easeInOut' }
      }
      className="inline text-[8.5px] sm:text-[10px] font-semibold leading-relaxed text-[#ffd98a]"
    >
      {note}
    </motion.span>
  );
}

function LayerNotesList({
  notes,
  links,
  prefersReducedMotion,
  transition,
}: {
  notes: string[];
  links: Map<string, NoteAccordLink>;
  prefersReducedMotion: boolean;
  transition: Transition;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={transition}
      className="flex flex-wrap justify-center gap-x-1.5 gap-y-0.5 px-1 py-0.5 sm:gap-x-2.5 sm:gap-y-1 sm:px-2 sm:py-1"
    >
      {notes.map((note) => {
        const link = links.get(note);
        if (link) {
          return (
            <MatchedNoteChip
              key={note}
              note={note}
              link={link}
              prefersReducedMotion={prefersReducedMotion}
            />
          );
        }
        return (
          <span
            key={note}
            className="inline text-[8.5px] sm:text-[10px] font-medium leading-relaxed text-white/55"
          >
            {note}
          </span>
        );
      })}
    </motion.div>
  );
}

function LayerAccordEcho({
  notes,
  links,
  prefersReducedMotion,
  transition,
}: {
  notes: string[];
  links: Map<string, NoteAccordLink>;
  prefersReducedMotion: boolean;
  transition: Transition;
}) {
  const matches = React.useMemo(() => {
    const seen = new Set<string>();
    const out: NoteAccordLink[] = [];

    for (const note of notes) {
      const link = links.get(note);
      if (!link) continue;

      const key = link.row.label.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      out.push(link);
    }

    return out.sort((a, b) => b.displayPct - a.displayPct).slice(0, 3);
  }, [links, notes]);

  if (matches.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={transition}
      className="mt-1 flex w-full flex-col gap-1 border-t border-white/[0.055] pt-1.5 lg:hidden"
    >
      {matches.map((link) => {
        const pct = Math.max(12, Math.min(100, link.displayPct));
        return (
          <div
            key={link.row.label}
            className="grid items-center gap-1.5 text-left"
            style={{ gridTemplateColumns: 'minmax(4.25rem, 32%) minmax(0, 1fr)' }}
          >
            <span className="truncate text-[7.5px] font-semibold uppercase leading-none tracking-[0.18em] text-white/48">
              {link.row.label}
            </span>
            <span className="relative h-[2px] sm:h-[3px] overflow-hidden rounded-full bg-white/[0.08]">
              <motion.span
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#9f6a1f] via-[#fc9d19] to-[#ffe1a3]"
                initial={false}
                animate={{
                  width: `${pct}%`,
                  opacity: prefersReducedMotion ? 0.78 : [0.72, 1, 0.72],
                  boxShadow: prefersReducedMotion
                    ? '0 0 8px rgba(252,157,25,0.28)'
                    : [
                        '0 0 8px rgba(252,157,25,0.24)',
                        '0 0 18px rgba(252,157,25,0.56)',
                        '0 0 8px rgba(252,157,25,0.24)',
                      ],
                }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0.2 }
                    : {
                        width: { duration: 0.56, ease: CALM_EASE },
                        opacity: { duration: 1.45, repeat: Infinity, ease: 'easeInOut' },
                        boxShadow: { duration: 1.45, repeat: Infinity, ease: 'easeInOut' },
                      }
                }
              />
            </span>
          </div>
        );
      })}
    </motion.div>
  );
}

// Particle System Generation
const DUST_MOTES = Array.from({ length: 14 }).map((_, i) => ({
  id: `mote-${i}`,
  cx: 30 + Math.random() * 300,
  cy: 50 + Math.random() * 320,
  r: 0.35 + Math.random() * 1.1,
  delay: Math.random() * 7,
  duration: 12 + Math.random() * 10,
  sway: (Math.random() - 0.5) * 12,
}));

// Static constellation pinpricks — fixed deep-field starlight for parallax depth
const CONSTELLATION_DOTS = [
  { cx: 48, cy: 78, r: 0.7, opacity: 0.45 },
  { cx: 312, cy: 62, r: 0.5, opacity: 0.32 },
  { cx: 28, cy: 198, r: 0.55, opacity: 0.4 },
  { cx: 332, cy: 184, r: 0.45, opacity: 0.3 },
  { cx: 60, cy: 342, r: 0.55, opacity: 0.36 },
  { cx: 298, cy: 352, r: 0.7, opacity: 0.5 },
  { cx: 82, cy: 116, r: 0.4, opacity: 0.26 },
  { cx: 278, cy: 108, r: 0.45, opacity: 0.28 },
  { cx: 20, cy: 280, r: 0.5, opacity: 0.32 },
  { cx: 338, cy: 258, r: 0.6, opacity: 0.42 },
  { cx: 156, cy: 18, r: 0.4, opacity: 0.28 },
  { cx: 210, cy: 14, r: 0.5, opacity: 0.34 },
];

export const NotePyramid: React.FC<NotePyramidProps> = ({
  topNotes,
  heartNotes,
  baseNotes,
  accordRows,
  onActiveNotesChange,
  className = '',
}) => {
  const [activeLayer, setActiveLayer] = React.useState<ActiveLayer | null>(null);
  const [hoveredLayer, setHoveredLayer] = React.useState<ActiveLayer | null>(null);
  const [focusedLayer, setFocusedLayer] = React.useState<ActiveLayer | null>(null);
  const rootRef = React.useRef<HTMLElement | null>(null);
  const pointerActivationRef = React.useRef<PointerActivation | null>(null);
  const ignoreClickActivationRef = React.useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const guidedLayer = null;
  const idPrefix = React.useId().replace(/:/g, '');
  const state = activeLayer ?? 'idle';
  const engagedLayer = hoveredLayer ?? focusedLayer ?? guidedLayer;

  const allLinks = React.useMemo(
    () => resolveNoteAccordLinks([...topNotes, ...heartNotes, ...baseNotes], accordRows ?? []),
    [topNotes, heartNotes, baseNotes, accordRows],
  );

  const id = React.useCallback((name: string) => `${idPrefix}-${name}`, [idPrefix]);
  const fill = React.useCallback((name: string) => `url(#${id(name)})`, [id]);

  React.useEffect(() => {
    if (!activeLayer) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setActiveLayer(null);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      setActiveLayer(null);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [activeLayer]);

  const layers = React.useMemo<LayerConfig[]>(() => [
    {
      key: 'base',
      title: 'Base Notes',
      ariaLabel: 'Base notes',
      ...layerGeometry.base,
      faceFills: [fill('base-left'), fill('base-right')],
      polishFill: fill('base-polish'),
      grainFill: fill('grain-deep'),
      revealClass: 'top-[52%] sm:top-[60%]',
      grainOpacity: 0.42,
      polishOpacity: 0.76,
      rimOpacity: 0.78,
      notes: baseNotes,
    },
    {
      key: 'heart',
      title: 'Heart Notes',
      ariaLabel: 'Heart notes',
      ...layerGeometry.heart,
      faceFills: [fill('heart-left'), fill('heart-right')],
      polishFill: fill('heart-polish'),
      grainFill: fill('grain-satin'),
      revealClass: 'top-[36%] sm:top-[44%]',
      grainOpacity: 0.32,
      polishOpacity: 0.72,
      rimOpacity: 0.86,
      notes: heartNotes,
    },
    {
      key: 'top',
      title: 'Top Notes',
      ariaLabel: 'Top notes',
      ...layerGeometry.top,
      faceFills: [fill('top-left'), fill('top-right')],
      polishFill: fill('top-polish'),
      grainFill: fill('grain-platinum'),
      revealClass: 'top-[10%] sm:top-[15%]',
      grainOpacity: 0.28,
      polishOpacity: 0.82,
      rimOpacity: 0.98,
      notes: topNotes,
    },
  ], [fill, baseNotes, heartNotes, topNotes]);

  const selectedLayer = layers.find((layer) => layer.key === activeLayer);
  const selectedNotes =
    activeLayer === 'top'
      ? topNotes
      : activeLayer === 'heart'
        ? heartNotes
        : activeLayer === 'base'
          ? baseNotes
          : NO_ACTIVE_NOTES;

  React.useEffect(() => {
    onActiveNotesChange?.(selectedNotes);

    return () => onActiveNotesChange?.([]);
  }, [onActiveNotesChange, selectedNotes]);

  const handleLayerActivate = React.useCallback((layer: ActiveLayer) => {
    setActiveLayer((current) => (current === layer ? null : layer));
  }, []);

  const handleLayerPointerDown = React.useCallback((event: React.PointerEvent<SVGGElement>, layer: ActiveLayer) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    event.stopPropagation();
    pointerActivationRef.current = {
      layer,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some mobile WebKit builds expose pointer events on SVG but reject capture.
      // The click fallback below keeps tap activation reliable there.
    }
  }, []);

  const handleLayerPointerUp = React.useCallback((event: React.PointerEvent<SVGGElement>, layer: ActiveLayer) => {
    event.stopPropagation();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore SVG pointer-capture release differences across mobile browsers.
      }
    }

    const activation = pointerActivationRef.current;
    pointerActivationRef.current = null;
    if (!activation || activation.layer !== layer || activation.pointerId !== event.pointerId) return;

    const moved = Math.hypot(event.clientX - activation.x, event.clientY - activation.y);
    if (moved > TAP_MOVE_TOLERANCE_PX) return;

    ignoreClickActivationRef.current = true;
    handleLayerActivate(layer);
  }, [handleLayerActivate]);

  const handleLayerPointerCancel = React.useCallback((event: React.PointerEvent<SVGGElement>) => {
    event.stopPropagation();
    pointerActivationRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore SVG pointer-capture release differences across mobile browsers.
      }
    }
  }, []);

  const handleLayerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<SVGGElement>, layer: ActiveLayer) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      handleLayerActivate(layer);
    },
    [handleLayerActivate],
  );

  const handleLayerClick = React.useCallback((event: React.MouseEvent<SVGGElement>, layer: ActiveLayer) => {
    event.stopPropagation();

    if (ignoreClickActivationRef.current) {
      ignoreClickActivationRef.current = false;
      return;
    }

    handleLayerActivate(layer);
  }, [handleLayerActivate]);

  const layerOffsets = LAYER_MOTION[state];

  const upperGapY = (PYRAMID_Y.topBottom + layerOffsets.top.y + PYRAMID_Y.heartTop + layerOffsets.heart.y) / 2;
  const lowerGapY = (PYRAMID_Y.heartBottom + layerOffsets.heart.y + PYRAMID_Y.baseTop + layerOffsets.base.y) / 2;

  const gapDots = [
    {
      key: 'upper-gap-dot',
      y: upperGapY,
      isVisible: activeLayer === 'top' || activeLayer === 'heart',
    },
    {
      key: 'lower-gap-dot',
      y: lowerGapY,
      isVisible: activeLayer === 'base' || activeLayer === 'heart',
    },
  ];

  const { pulseTransition, floatTransition, shimmerTransition, atmosphericTransition, glyphTransition } = React.useMemo(() => {
    if (prefersReducedMotion) {
      return {
        pulseTransition: reducedTransition,
        floatTransition: reducedTransition,
        shimmerTransition: reducedTransition,
        atmosphericTransition: reducedTransition,
        glyphTransition: reducedTransition,
      };
    }
    return {
      pulseTransition: { duration: 5.4, ease: SOFT_EASE, repeat: Infinity, repeatType: 'mirror' } as Transition,
      floatTransition: { duration: 8.5, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' } as Transition,
      shimmerTransition: { duration: 6.4, ease: SOFT_EASE, repeat: Infinity, repeatType: 'mirror' } as Transition,
      atmosphericTransition: { duration: 10, ease: SOFT_EASE, repeat: Infinity, repeatType: 'mirror' } as Transition,
      glyphTransition: { duration: 7.2, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' } as Transition,
    };
  }, [prefersReducedMotion]);

  return (
    <section
      ref={rootRef}
      className={`relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden px-3 py-5 sm:px-5 ${className}`}
      onClick={() => setActiveLayer(null)}
    >
      <motion.div
        className="relative z-10 w-full max-w-[24rem] aspect-[1/1.08] shrink-0 overflow-visible sm:max-w-[26rem]"
        onClick={(event) => event.stopPropagation()}
        initial={prefersReducedMotion ? false : { opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={prefersReducedMotion ? reducedTransition : { duration: 1.1, ease: CALM_EASE }}
      >
        <svg
          viewBox="0 0 360 420"
          className="h-full w-full overflow-visible drop-shadow-[0_20px_35px_rgba(0,0,0,0.4)]"
          role="img"
          aria-label="Interactive fragrance note pyramid"
        >
          <defs>
            <radialGradient id={id('background-gold-air')} cx="50%" cy="48%" r="58%">
              <stop offset="0" stopColor="#ffb84d" stopOpacity="0.14" />
              <stop offset="0.45" stopColor="#ffb84d" stopOpacity="0.06" />
              <stop offset="1" stopColor="#ffb84d" stopOpacity="0" />
            </radialGradient>

            <radialGradient id={id('pyramid-cast-reflection')} cx="50%" cy="92%" r="40%">
              <stop offset="0" stopColor="#ffb84d" stopOpacity="0.1" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.03" />
              <stop offset="1" stopColor="#000000" stopOpacity="0" />
            </radialGradient>

            <linearGradient id={id('top-left')} x1="129" y1="83" x2="181" y2="83" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#8a6a36" />
              <stop offset="0.15" stopColor="#fff1c7" />
              <stop offset="0.44" stopColor="#e1b966" />
              <stop offset="0.8" stopColor="#fff8df" />
              <stop offset="1" stopColor="#b9872e" />
            </linearGradient>

            <linearGradient id={id('top-right')} x1="180" y1="83" x2="231" y2="83" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff8df" />
              <stop offset="0.26" stopColor="#dfb35a" />
              <stop offset="0.68" stopColor="#9c6a22" />
              <stop offset="1" stopColor="#5c390d" />
            </linearGradient>

            <radialGradient id={id('top-polish')} cx="50%" cy="25%" r="82%">
              <stop offset="0" stopColor="#fff8df" stopOpacity="0.78" />
              <stop offset="0.38" stopColor="#ffcf70" stopOpacity="0.34" />
              <stop offset="0.7" stopColor="#7f5418" stopOpacity="0.18" />
              <stop offset="1" stopColor="#050607" stopOpacity="0.35" />
            </radialGradient>

            <linearGradient id={id('heart-left')} x1="75" y1="200" x2="180" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#2a1c0a" />
              <stop offset="0.2" stopColor="#5f4216" />
              <stop offset="0.58" stopColor="#99702f" />
              <stop offset="0.82" stopColor="#d6ad62" />
              <stop offset="1" stopColor="#fff0bf" />
            </linearGradient>

            <linearGradient id={id('heart-right')} x1="180" y1="200" x2="285" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff0bf" />
              <stop offset="0.22" stopColor="#c99b49" />
              <stop offset="0.58" stopColor="#5c3c12" />
              <stop offset="1" stopColor="#171008" />
            </linearGradient>

            <linearGradient id={id('heart-polish')} x1="72" y1="200" x2="288" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#000000" stopOpacity="0.36" />
              <stop offset="0.28" stopColor="#ffdf94" stopOpacity="0.14" />
              <stop offset="0.49" stopColor="#fff8df" stopOpacity="0.62" />
              <stop offset="0.58" stopColor="#ffcf70" stopOpacity="0.25" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.45" />
            </linearGradient>

            <linearGradient id={id('base-left')} x1="21" y1="319" x2="180" y2="319" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#050302" />
              <stop offset="0.24" stopColor="#151008" />
              <stop offset="0.58" stopColor="#30210c" />
              <stop offset="0.84" stopColor="#704b16" />
              <stop offset="1" stopColor="#a46f24" />
            </linearGradient>

            <linearGradient id={id('base-right')} x1="180" y1="319" x2="339" y2="319" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#a46f24" />
              <stop offset="0.25" stopColor="#5f4115" />
              <stop offset="0.62" stopColor="#1b1207" />
              <stop offset="1" stopColor="#020201" />
            </linearGradient>

            <linearGradient id={id('base-polish')} x1="23" y1="320" x2="337" y2="320" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#000000" stopOpacity="0.42" />
              <stop offset="0.35" stopColor="#ffcf70" stopOpacity="0.08" />
              <stop offset="0.5" stopColor="#fff4d1" stopOpacity="0.5" />
              <stop offset="0.62" stopColor="#ffcf70" stopOpacity="0.18" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.52" />
            </linearGradient>

            <linearGradient id={id('active-sheen')} x1="36" y1="25" x2="324" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="0.26" stopColor="#ffffff" stopOpacity="0.06" />
              <stop offset="0.46" stopColor="#ffeaad" stopOpacity="0.32" />
              <stop offset="0.52" stopColor="#ffffff" stopOpacity="0.24" />
              <stop offset="0.72" stopColor="#ffffff" stopOpacity="0.04" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>

            <linearGradient id={id('active-edge-gold')} x1="30" y1="40" x2="330" y2="370" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffb84d" stopOpacity="0.2" />
              <stop offset="0.42" stopColor="#ffeaad" stopOpacity="0.75" />
              <stop offset="0.58" stopColor="#fc9d19" stopOpacity="0.55" />
              <stop offset="1" stopColor="#6b400a" stopOpacity="0.18" />
            </linearGradient>

            <linearGradient id={id('vertical-falloff')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff8df" stopOpacity="0.24" />
              <stop offset="0.36" stopColor="#ffcf70" stopOpacity="0.1" />
              <stop offset="0.78" stopColor="#000000" stopOpacity="0.28" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.5" />
            </linearGradient>

            <linearGradient id={id('outer-rim')} x1="28" y1="37" x2="332" y2="360" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff8df" stopOpacity="0.95" />
              <stop offset="0.18" stopColor="#ffd98a" stopOpacity="0.9" />
              <stop offset="0.48" stopColor="#fff4d1" stopOpacity="1" />
              <stop offset="0.72" stopColor="#b87924" stopOpacity="0.74" />
              <stop offset="1" stopColor="#ffe0a0" stopOpacity="0.9" />
            </linearGradient>

            <linearGradient id={id('groove-core')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#08090a" />
              <stop offset="0.45" stopColor="#262a2c" />
              <stop offset="0.58" stopColor="#07090b" />
              <stop offset="1" stopColor="#020304" />
            </linearGradient>

            <linearGradient id={id('groove-highlight')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.75" />
              <stop offset="0.42" stopColor="#ffffff" stopOpacity="0.45" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0.22" />
            </linearGradient>

            <linearGradient id={id('groove-gold')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffeaad" stopOpacity="0.65" />
              <stop offset="0.45" stopColor="#fc9d19" stopOpacity="0.5" />
              <stop offset="1" stopColor="#6b400a" stopOpacity="0.25" />
            </linearGradient>

            <radialGradient id={id('gold-dot')} cx="36%" cy="30%" r="74%">
              <stop offset="0" stopColor="#fff3d4" />
              <stop offset="0.24" stopColor="#ffc766" />
              <stop offset="0.55" stopColor="#fc9d19" />
              <stop offset="0.8" stopColor="#7a4b0d" />
              <stop offset="1" stopColor="#211003" />
            </radialGradient>

            <radialGradient id={id('gold-glow')} cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#fcaa28" stopOpacity="0.68" />
              <stop offset="0.44" stopColor="#fc9d19" stopOpacity="0.28" />
              <stop offset="1" stopColor="#fc9d19" stopOpacity="0" />
            </radialGradient>

            <linearGradient id={id('glyph-line-left')} x1="76" y1="400" x2="171" y2="397" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#6b400a" stopOpacity="0" />
              <stop offset="0.28" stopColor="#a76f20" stopOpacity="0.58" />
              <stop offset="0.72" stopColor="#fcaa28" stopOpacity="0.98" />
              <stop offset="1" stopColor="#fff4d1" stopOpacity="1" />
            </linearGradient>

            <linearGradient id={id('glyph-line-right')} x1="189" y1="397" x2="284" y2="400" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff4d1" stopOpacity="1" />
              <stop offset="0.28" stopColor="#fcaa28" stopOpacity="0.98" />
              <stop offset="0.72" stopColor="#a76f20" stopOpacity="0.58" />
              <stop offset="1" stopColor="#6b400a" stopOpacity="0" />
            </linearGradient>

            <linearGradient id={id('glyph-plinth')} x1="93" y1="402" x2="267" y2="402" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#4a2907" stopOpacity="0" />
              <stop offset="0.16" stopColor="#8c5a1a" stopOpacity="0.72" />
              <stop offset="0.5" stopColor="#ffe0a0" stopOpacity="0.96" />
              <stop offset="0.84" stopColor="#8c5a1a" stopOpacity="0.72" />
              <stop offset="1" stopColor="#4a2907" stopOpacity="0" />
            </linearGradient>

            <linearGradient id={id('glyph-shimmer')} x1="137" y1="390" x2="223" y2="405" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="0.43" stopColor="#fff8e8" stopOpacity="0" />
              <stop offset="0.5" stopColor="#fff8e8" stopOpacity="0.72" />
              <stop offset="0.57" stopColor="#fff8e8" stopOpacity="0" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>

            <radialGradient id={id('glyph-sphere')} cx="36%" cy="30%" r="72%">
              <stop offset="0" stopColor="#fff8e8" />
              <stop offset="0.2" stopColor="#ffe2a0" />
              <stop offset="0.46" stopColor="#fcaa28" />
              <stop offset="0.72" stopColor="#8b5310" />
              <stop offset="1" stopColor="#2d1504" />
            </radialGradient>

            <linearGradient id={id('glyph-rim')} x1="173" y1="393" x2="187" y2="407" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff6dd" stopOpacity="0.95" />
              <stop offset="0.48" stopColor="#ffc766" stopOpacity="0.78" />
              <stop offset="1" stopColor="#7a4b0d" stopOpacity="0.52" />
            </linearGradient>

            <radialGradient id={id('glyph-underlight')} cx="50%" cy="45%" r="62%">
              <stop offset="0" stopColor="#ffd98a" stopOpacity="0.5" />
              <stop offset="0.42" stopColor="#fc9d19" stopOpacity="0.2" />
              <stop offset="1" stopColor="#fc9d19" stopOpacity="0" />
            </radialGradient>

            <pattern id={id('grain-platinum')} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-13)">
              <path d="M0 1 H7 M0 4 H7" stroke="#384044" strokeOpacity="0.22" strokeWidth="0.45" />
              <path d="M1 6 H6" stroke="#ffffff" strokeOpacity="0.2" strokeWidth="0.35" />
            </pattern>

            <pattern id={id('grain-satin')} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)">
              <path d="M0 1 H7 M0 3.5 H7 M0 6 H7" stroke="#111416" strokeOpacity="0.3" strokeWidth="0.5" />
              <path d="M1 2 H7" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="0.3" />
            </pattern>

            <pattern id={id('grain-deep')} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-17)">
              <path d="M0 1 H6 M0 3 H6 M0 5 H6" stroke="#ffffff" strokeOpacity="0.15" strokeWidth="0.4" />
              <path d="M1 2 H6 M0 4 H5" stroke="#000000" strokeOpacity="0.36" strokeWidth="0.4" />
            </pattern>

            <filter id={id('piece-shadow')} x="-20%" y="-20%" width="140%" height="150%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="14" stdDeviation="9" floodColor="#000000" floodOpacity="0.55" />
            </filter>

            <filter id={id('piece-active-shadow')} x="-24%" y="-24%" width="148%" height="158%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="18" stdDeviation="13" floodColor="#000000" floodOpacity="0.6" />
              <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#ffb84d" floodOpacity="0.16" />
            </filter>

            <filter id={id('piece-engaged-shadow')} x="-24%" y="-24%" width="148%" height="158%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="15" stdDeviation="10" floodColor="#000000" floodOpacity="0.58" />
              <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#ffb84d" floodOpacity="0.18" />
            </filter>

            <filter id={id('edge-glow')} x="-12%" y="-12%" width="124%" height="124%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id={id('gold-soft')} x="-180%" y="-180%" width="460%" height="460%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.45" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id={id('groove-shadow')} x="-250%" y="-12%" width="600%" height="124%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="-1" dy="0" stdDeviation="0.9" floodColor="#ffffff" floodOpacity="0.22" />
              <feDropShadow dx="1.4" dy="0" stdDeviation="1.1" floodColor="#000000" floodOpacity="0.78" />
              <feDropShadow dx="0" dy="2" stdDeviation="1.4" floodColor="#000000" floodOpacity="0.5" />
            </filter>

            <filter id={id('glyph-soft')} x="-80%" y="-800%" width="260%" height="1700%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="1.2" stdDeviation="1.1" floodColor="#000000" floodOpacity="0.42" />
              <feDropShadow dx="0" dy="0" stdDeviation="2.2" floodColor="#fc9d19" floodOpacity="0.34" />
            </filter>

            <linearGradient id={id('ground-line')} x1="20" y1="380" x2="340" y2="380" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="0.35" stopColor="#ffc766" stopOpacity="0.35" />
              <stop offset="0.5" stopColor="#fff3d4" stopOpacity="0.65" />
              <stop offset="0.65" stopColor="#ffc766" stopOpacity="0.35" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Ambient depth field — soft gold air + slow-drifting starfield. No grid, no reticles. */}
          <g aria-hidden pointerEvents="none" className="mix-blend-screen">
            <motion.circle
              cx="180"
              cy="210"
              r="190"
              fill={fill('background-gold-air')}
              animate={prefersReducedMotion ? { opacity: 0.55 } : { opacity: [0.4, 0.62, 0.4], scale: [0.985, 1.015, 0.985] }}
              transition={atmosphericTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />

            {CONSTELLATION_DOTS.map((star, idx) => (
              <motion.circle
                key={`star-${idx}`}
                cx={star.cx}
                cy={star.cy}
                r={star.r}
                fill="#fff8e6"
                animate={
                  prefersReducedMotion
                    ? { opacity: star.opacity * 0.85 }
                    : { opacity: [star.opacity * 0.55, star.opacity * 0.95, star.opacity * 0.55] }
                }
                transition={{
                  duration: 7 + (idx % 5) * 1.4,
                  delay: idx * 0.42,
                  ease: SOFT_EASE,
                  repeat: Infinity,
                  repeatType: 'mirror',
                }}
              />
            ))}
          </g>

          {/* Particle Motes — gentle vertical drift with subtle horizontal sway */}
          <g aria-hidden pointerEvents="none">
            {DUST_MOTES.map((mote) => (
              <motion.circle
                key={mote.id}
                cx={mote.cx}
                cy={mote.cy}
                r={mote.r}
                fill="#ffffff"
                initial={{ opacity: 0, y: 0, x: 0 }}
                animate={
                  prefersReducedMotion
                    ? { opacity: 0.08 }
                    : { opacity: [0, 0.22, 0], y: [0, -42], x: [0, mote.sway, 0] }
                }
                transition={{
                  duration: mote.duration,
                  delay: mote.delay,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
              />
            ))}
          </g>

          {/* Base Reflection */}
          <ellipse cx={PYRAMID_CENTER_X} cy={PYRAMID_Y.baseBottom + 12} rx="165" ry="12" fill={fill('pyramid-cast-reflection')} pointerEvents="none" />

          {/* Ground horizon line — grounds the structure with a soft luminous footing */}
          <motion.path
            d={`M22 ${PYRAMID_Y.baseBottom + 9} L338 ${PYRAMID_Y.baseBottom + 9}`}
            stroke={fill('ground-line')}
            strokeWidth="0.7"
            strokeLinecap="round"
            fill="none"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
            animate={
              prefersReducedMotion
                ? { opacity: activeLayer ? 0.6 : 0.42 }
                : { opacity: activeLayer ? [0.45, 0.65, 0.45] : [0.3, 0.45, 0.3] }
            }
            transition={atmosphericTransition}
          />

          {layers.map((layer) => {
            const isActive = activeLayer === layer.key;
            const isGuided = guidedLayer === layer.key && !activeLayer && !hoveredLayer && !focusedLayer;
            const isEngaged = engagedLayer === layer.key;
            const isMuted = activeLayer !== null && !isActive;
            const isEmpty = layer.notes.length === 0;

            const layerMotion = LAYER_MOTION[state][layer.key];
            const targetY = layerMotion.y + (isEngaged && !isActive && !isGuided ? -0.8 : 0);
            const targetScale = layerMotion.scale + (isEngaged && !isActive && !isGuided ? 0.003 : 0);
            const targetOpacity = isEngaged && !isActive ? Math.min(layerMotion.opacity + 0.08, 1) : layerMotion.opacity;
            const channelPath = linePath(layer.channel.start, layer.channel.end);
            const channelHighlightPath = linePath(
              offsetPoint(layer.channel.start, -2),
              offsetPoint(layer.channel.end, -2),
            );

            return (
              <motion.g
                key={layer.key}
                role={isEmpty ? undefined : 'button'}
                tabIndex={isEmpty ? -1 : 0}
                aria-label={layer.ariaLabel}
                aria-pressed={isEmpty ? undefined : isActive}
                aria-disabled={isEmpty || undefined}
                className={`outline-none [&:focus-visible_.focus-ring]:opacity-100 ${isEmpty ? 'cursor-default' : 'cursor-pointer'}`}
                initial={false}
                animate={{
                  y: targetY,
                  opacity: targetOpacity,
                  scale: targetScale,
                  filter: isEmpty
                    ? 'saturate(0.5) brightness(0.62)'
                    : isMuted
                      ? 'saturate(0.85) brightness(0.92)'
                      : 'saturate(1) brightness(1)',
                }}
                transition={
                  prefersReducedMotion
                    ? reducedTransition
                    : { ...layerTransition, filter: { duration: 0.44, ease: CALM_EASE }, opacity: { duration: 0.46, ease: CALM_EASE } }
                }
                style={{
                  transformBox: 'view-box',
                  transformOrigin: `${PYRAMID_CENTER_X}px ${LAYER_CENTER_Y[layer.key]}px`,
                  WebkitTapHighlightColor: 'transparent',
                  touchAction: 'manipulation',
                  willChange: activeLayer !== null || isEngaged ? 'transform, opacity, filter' : 'auto',
                }}
                onPointerEnter={isEmpty ? undefined : (event) => {
                  if (event.pointerType !== 'mouse') return;
                  setHoveredLayer(layer.key);
                }}
                onPointerLeave={isEmpty ? undefined : (event) => {
                  if (event.pointerType !== 'mouse') return;
                  setHoveredLayer((current) => (current === layer.key ? null : current));
                }}
                onFocus={isEmpty ? undefined : () => setFocusedLayer(layer.key)}
                onBlur={isEmpty ? undefined : () => setFocusedLayer((current) => (current === layer.key ? null : current))}
                onPointerDown={isEmpty ? undefined : (event) => handleLayerPointerDown(event, layer.key)}
                onPointerUp={isEmpty ? undefined : (event) => handleLayerPointerUp(event, layer.key)}
                onPointerCancel={isEmpty ? undefined : handleLayerPointerCancel}
                onLostPointerCapture={isEmpty ? undefined : handleLayerPointerCancel}
                onClick={isEmpty ? (event) => event.stopPropagation() : (event) => handleLayerClick(event, layer.key)}
                onKeyDown={isEmpty ? undefined : (event) => handleLayerKeyDown(event, layer.key)}
              >
                <path
                  d={layer.hitPath}
                  fill="transparent"
                  stroke="transparent"
                  strokeWidth="56"
                  pointerEvents="all"
                  vectorEffect="non-scaling-stroke"
                />

                <g filter={isActive ? fill('piece-active-shadow') : isEngaged ? fill('piece-engaged-shadow') : fill('piece-shadow')}>
                  {layer.faces.map((facePath, faceIndex) => (
                    <path key={`${layer.key}-${faceIndex}`} d={facePath} fill={layer.faceFills[faceIndex]} />
                  ))}

                  <path d={layer.hitPath} fill={fill('vertical-falloff')} opacity="0.65" />

                  <path
                    d={layer.hitPath}
                    fill={layer.polishFill}
                    opacity={isActive ? layer.polishOpacity + 0.14 : isEngaged ? layer.polishOpacity + 0.06 : layer.polishOpacity}
                  />

                  <path d={layer.hitPath} fill={layer.grainFill} opacity={layer.grainOpacity} />

                  <motion.path
                    d={layer.hitPath}
                    fill={fill('active-sheen')}
                    initial={false}
                    animate={
                      prefersReducedMotion
                        ? { opacity: isActive ? 0.2 : isEngaged ? 0.12 : 0.05 }
                        : {
                            opacity: isActive
                              ? [0.14, 0.22, 0.14]
                              : isEngaged
                                ? [0.08, 0.13, 0.08]
                                : [0.04, 0.06, 0.04],
                          }
                    }
                    transition={shimmerTransition}
                    pointerEvents="none"
                  />
                </g>

                <path
                  d={channelPath}
                  fill="none"
                  stroke="#010202"
                  strokeOpacity="0.85"
                  strokeWidth="7.5"
                  strokeLinecap="round"
                  filter={fill('groove-shadow')}
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <path
                  d={channelPath}
                  fill="none"
                  stroke={fill('groove-core')}
                  strokeWidth="4.4"
                  strokeLinecap="round"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <motion.path
                  d={channelPath}
                  fill="none"
                  stroke={fill('groove-gold')}
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                  initial={false}
                  animate={
                    prefersReducedMotion
                      ? { opacity: isActive ? 0.4 : 0 }
                      : { opacity: isActive ? [0.28, 0.42, 0.28] : isGuided ? [0.18, 0.34, 0.18] : isEngaged ? [0.12, 0.22, 0.12] : 0 }
                  }
                  transition={pulseTransition}
                />

                <path
                  d={channelHighlightPath}
                  fill="none"
                  stroke={fill('groove-highlight')}
                  strokeWidth="0.85"
                  strokeLinecap="round"
                  opacity={isActive ? 0.7 : isEngaged ? 0.6 : 0.5}
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <path
                  d={layer.hitPath}
                  fill="none"
                  stroke="#010202"
                  strokeOpacity="0.95"
                  strokeWidth="4.4"
                  strokeLinejoin="miter"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <motion.path
                  d={layer.hitPath}
                  fill="none"
                  stroke={fill('outer-rim')}
                  initial={false}
                  animate={{
                    strokeOpacity: isActive ? layer.rimOpacity + 0.1 : isEngaged ? layer.rimOpacity + 0.06 : layer.rimOpacity,
                    strokeWidth: isEngaged || isActive ? 1.5 : 1.3,
                  }}
                  transition={{ duration: 0.85, ease: CALM_EASE }}
                  strokeLinejoin="miter"
                  filter={fill('edge-glow')}
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <motion.path
                  d={layer.hitPath}
                  fill="none"
                  stroke={fill('active-edge-gold')}
                  strokeWidth="0.85"
                  strokeLinejoin="miter"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                  initial={false}
                  animate={
                    prefersReducedMotion
                      ? { opacity: isActive ? 0.4 : isEngaged ? 0.22 : 0 }
                      : {
                          opacity: isActive
                            ? [0.28, 0.42, 0.28]
                            : isGuided
                              ? [0.14, 0.28, 0.14]
                            : isEngaged
                              ? [0.12, 0.22, 0.12]
                              : 0,
                        }
                  }
                  transition={pulseTransition}
                />

                {/* Keyboard focus ring — visible only on :focus-visible via parent class */}
                <path
                  className="focus-ring pointer-events-none opacity-0 transition-opacity"
                  d={layer.hitPath}
                  fill="none"
                  stroke="#ffc766"
                  strokeOpacity="0.95"
                  strokeWidth="2.2"
                  strokeDasharray="4 3"
                  strokeLinejoin="miter"
                  vectorEffect="non-scaling-stroke"
                />

                {/* Apex pinpoint — single soft glow, no dashed ring, no sparkle path */}
                {layer.key === 'top' && (
                  <motion.circle
                    cx={PYRAMID_CENTER_X}
                    cy="27"
                    r="1.4"
                    fill="#fff8e6"
                    pointerEvents="none"
                    filter={fill('gold-soft')}
                    initial={false}
                    animate={prefersReducedMotion ? { opacity: 0.78 } : { opacity: [0.6, 0.95, 0.6] }}
                    transition={pulseTransition}
                  />
                )}
              </motion.g>
            );
          })}

          <AnimatePresence>
            {gapDots.map((dot) =>
              dot.isVisible ? (
                <motion.g
                  key={dot.key}
                  aria-hidden
                  pointerEvents="none"
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={prefersReducedMotion ? reducedTransition : { duration: 0.85, ease: CALM_EASE }}
                  style={{
                    transformBox: 'view-box',
                    transformOrigin: `${PYRAMID_CENTER_X}px ${dot.y}px`,
                  }}
                >
                  <motion.circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="11.5"
                    fill={fill('gold-glow')}
                    animate={
                      prefersReducedMotion
                        ? { opacity: 0.42, r: 11 }
                        : { opacity: [0.3, 0.5, 0.3], r: [10.5, 12.5, 10.5] }
                    }
                    transition={pulseTransition}
                  />

                  <motion.circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="2.85"
                    fill={fill('gold-dot')}
                    filter={fill('gold-soft')}
                    animate={
                      prefersReducedMotion
                        ? { opacity: 1, r: 2.85 }
                        : { opacity: [0.9, 1, 0.9], r: [2.85, 3.15, 2.85] }
                    }
                    transition={pulseTransition}
                  />

                  <circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="3.6"
                    fill="none"
                    stroke="#ffc766"
                    strokeOpacity="0.5"
                    strokeWidth="0.4"
                    vectorEffect="non-scaling-stroke"
                  />
                </motion.g>
              ) : null,
            )}
          </AnimatePresence>

          <motion.g
            aria-hidden
            pointerEvents="none"
            filter={fill('glyph-soft')}
            animate={prefersReducedMotion ? { opacity: 0.96, y: 0 } : { opacity: [0.88, 1, 0.88], y: [0, -0.6, 0] }}
            transition={glyphTransition}
            style={{
              transformBox: 'view-box',
              transformOrigin: '180px 401px',
              willChange: prefersReducedMotion ? 'auto' : 'transform, opacity',
            }}
          >
            {/* Soft pedestal underlight — a wide, flat halo resting on the glossy black surface */}
            <motion.ellipse
              cx="180"
              cy="403"
              rx="96"
              ry="6.2"
              fill={fill('glyph-underlight')}
              animate={prefersReducedMotion ? { opacity: 0.42, scaleX: 1 } : { opacity: [0.26, 0.44, 0.26], scaleX: [0.96, 1.03, 0.96] }}
              transition={glyphTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />

            {/* Primary reflection — a clean, symmetric gold hairline that fades at both ends */}
            <path
              d="M92 402 C123 400 152 399.4 180 399.4 C208 399.4 237 400 268 402"
              stroke={fill('glyph-plinth')}
              strokeWidth="1.5"
              strokeLinecap="round"
              fill="none"
              opacity="0.85"
              vectorEffect="non-scaling-stroke"
            />

            {/* Secondary polish reflection — shorter and fainter, just beneath the first */}
            <path
              d="M120 405 C143 403.6 162 403.2 180 403.2 C198 403.2 217 403.6 240 405"
              stroke={fill('glyph-plinth')}
              strokeWidth="0.8"
              strokeLinecap="round"
              fill="none"
              opacity="0.4"
              vectorEffect="non-scaling-stroke"
            />

            {/* Gentle traveling sheen drifting along the reflection */}
            <motion.g
              animate={prefersReducedMotion ? { opacity: 0 } : { opacity: [0, 0.5, 0], x: [-30, 30, 30] }}
              transition={{ duration: 4.8, ease: SOFT_EASE, repeat: Infinity, repeatDelay: 1.4 }}
              style={{
                transformBox: 'view-box',
                transformOrigin: '180px 401px',
                willChange: prefersReducedMotion ? 'auto' : 'transform, opacity',
              }}
            >
              <path
                d="M104 401 C132 399.4 158 399 178 399.2 M182 399.2 C202 399 228 399.4 256 401"
                stroke={fill('glyph-shimmer')}
                strokeWidth="1.05"
                strokeLinecap="round"
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            </motion.g>

            {/* Center orb — small, refined, seated into the reflection base */}
            <motion.circle
              cx="180"
              cy="400"
              r="13"
              fill={fill('gold-glow')}
              animate={prefersReducedMotion ? { opacity: 0.5, scale: 1 } : { opacity: [0.3, 0.5, 0.3], scale: [0.96, 1.06, 0.96] }}
              transition={pulseTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />

            <circle
              cx="180"
              cy="400"
              r="7.4"
              fill="#2a1404"
              opacity="0.5"
            />

            <motion.circle
              cx="180"
              cy="400"
              r="6.4"
              fill={fill('glyph-sphere')}
              animate={prefersReducedMotion ? { opacity: 1, scale: 1 } : { opacity: [0.95, 1, 0.95], scale: [0.98, 1.03, 0.98] }}
              transition={pulseTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />

            <circle
              cx="180"
              cy="400"
              r="7.1"
              fill="none"
              stroke={fill('glyph-rim')}
              strokeOpacity="0.85"
              strokeWidth="0.7"
              vectorEffect="non-scaling-stroke"
            />

            <circle cx="178" cy="397.4" r="1.4" fill="#fff8e8" opacity="0.85" />
          </motion.g>
        </svg>

        {/* Enhanced Hovering Glassmorphic Text UI */}
        <AnimatePresence mode="wait">
          {selectedLayer ? (
            <motion.div
              key={selectedLayer.key}
              initial={{ opacity: 0, y: 8, scale: 0.985, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -5, scale: 0.99, filter: 'blur(2px)' }}
              transition={prefersReducedMotion ? reducedTransition : { duration: 0.32, ease: CALM_EASE }}
              className={`pointer-events-none absolute left-1/2 z-50 w-[84%] max-w-[15rem] -translate-x-1/2 overflow-hidden rounded-lg border border-white/10 bg-[#060608]/76 px-2 py-2 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.78),inset_0_1px_1px_rgba(255,255,255,0.13),0_0_0_1px_rgba(252,157,25,0.07)] backdrop-blur-sm sm:max-w-[18.5rem] sm:px-3.5 sm:py-3.5 ${selectedLayer.revealClass}`}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-[3px] rounded-md border border-white/[0.045]"
              />

              <motion.div
                animate={prefersReducedMotion ? {} : { y: [0, -1, 0] }}
                transition={floatTransition}
                className="relative flex flex-col items-center justify-center space-y-1.5 sm:space-y-2 text-center"
              >
                <motion.div
                   initial={{ opacity: 0, y: 4 }}
                   animate={{ opacity: 1, y: 0 }}
                   exit={{ opacity: 0, y: -3 }}
                   transition={prefersReducedMotion ? reducedTransition : { duration: 0.6, delay: 0.08, ease: CALM_EASE }}
                   className="flex w-full flex-col items-center justify-center space-y-0.5 sm:space-y-1"
                >
                  <h3 className="bg-gradient-to-br from-[#fff3d4] via-[#fc9d19] to-[#8c5a1a] bg-clip-text text-[9.5px] sm:text-[10.5px] font-bold uppercase tracking-[0.38em] text-transparent drop-shadow-[0_2px_10px_rgba(252,157,25,0.4)]">
                    {selectedLayer.title}
                  </h3>

                  <motion.span
                    aria-hidden
                    initial={{ scaleX: 0, opacity: 0 }}
                    animate={{ scaleX: 1, opacity: 1 }}
                    exit={{ scaleX: 0, opacity: 0 }}
                    transition={
                      prefersReducedMotion
                        ? reducedTransition
                        : { duration: 0.85, delay: 0.22, ease: CALM_EASE }
                    }
                    className="block h-px w-8 sm:w-12 origin-center rounded-full bg-gradient-to-r from-transparent via-[#ffc766] to-transparent shadow-[0_0_7px_rgba(252,157,25,0.48)]"
                  />
                </motion.div>

                {(() => {
                  const tierNotes = selectedLayer.notes;
                  const hasLink = tierNotes.some((n) => allLinks.has(n));
                  const useChips = hasLink || tierNotes.length <= 7;
                  const noteTransition = prefersReducedMotion
                    ? reducedTransition
                    : { duration: 0.34, delay: 0.12, ease: CALM_EASE };
                  return useChips ? (
                    <>
                      <LayerNotesList
                        notes={tierNotes}
                        links={allLinks}
                        prefersReducedMotion={Boolean(prefersReducedMotion)}
                        transition={noteTransition}
                      />
                      <LayerAccordEcho
                        notes={tierNotes}
                        links={allLinks}
                        prefersReducedMotion={Boolean(prefersReducedMotion)}
                        transition={noteTransition}
                      />
                    </>
                  ) : (
                    <>
                      <LayerNotesText
                        notes={tierNotes}
                        prefersReducedMotion={Boolean(prefersReducedMotion)}
                        transition={noteTransition}
                      />
                      <LayerAccordEcho
                        notes={tierNotes}
                        links={allLinks}
                        prefersReducedMotion={Boolean(prefersReducedMotion)}
                        transition={noteTransition}
                      />
                    </>
                  );
                })()}
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </section>
  );
};
