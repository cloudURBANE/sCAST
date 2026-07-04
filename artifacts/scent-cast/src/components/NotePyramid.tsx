import React from 'react';
import { AnimatePresence, m, useReducedMotion, type Transition } from 'framer-motion';
import { type MainAccordDisplayRow } from '@/lib/fragranceApi';
import { resolveNoteAccordLinks, type NoteAccordLink } from '@/lib/noteAccordLinks';
import { isIpadSafariPerformanceMode, isLowRenderBudget } from '@/lib/platform';

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
  hitPathLength: number;
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
  crest?: string;
  notes: string[];
};

const CALM_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SOFT_EASE: [number, number, number, number] = [0.42, 0, 0.58, 1];

type LayerMotionState = ActiveLayer | 'idle';
type LayerOffset = { y: number; scale: number; opacity: number };
type PointerActivation = { layer: ActiveLayer; pointerId: number; x: number; y: number };
type PolygonGeometry = { path: string; length: number };
type DustMote = {
  id: string;
  cx: number;
  cy: number;
  r: number;
  delay: number;
  duration: number;
  sway: number;
};

type ConstellationDot = {
  cx: number;
  cy: number;
  r: number;
  opacity: number;
};

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
const APEX_GLINT_Y = 27;
const NOTE_PYRAMID_ARTWORK_SRC = '/note-pyramid-gold.png';
const TAP_MOVE_TOLERANCE_PX = 10;
const TYPEWRITER_FRAME_MS = 24;
const NOTE_MARQUEE_MIN_CHARS = 58;
const NOTE_MARQUEE_MIN_COUNT = 5;
const DECORATIVE_REPEAT_COUNT = 2;
const GUIDE_START_DELAY_MS = 620;
const GUIDE_LAYER_DURATION_MS = 2200;
const GUIDE_TRACE_DURATION_S = 1.9;
// Draw → hold-fully-outlined → release. Keeps each silhouette completely
// traced before it gracefully fades, so the hint always reads as a finished
// outline rather than a stroke that vanishes mid-draw.
const GUIDE_TRACE_TIMES = [0, 0.46, 0.72, 1] as const;
// The path string rounds coordinates, while hitPathLength uses source geometry.
// Keep the guide dash a hair longer so renderer rounding cannot leave an end gap.
const GUIDE_DASH_OVERSCAN_UNITS = 3;
const GUIDE_INTERSECTION_RATIO = 0.22;
const NO_ACTIVE_NOTES: string[] = [];
const LAYER_CENTER_Y: Record<ActiveLayer, number> = {
  top: 82,
  heart: 200,
  base: 319,
};

const PYRAMID_OUTER = {
  apex: [PYRAMID_CENTER_X, 27] as Point,
  leftBase: [33, 379] as Point,
  rightBase: [327, 379] as Point,
};

const PYRAMID_Y = {
  topBottom: 149,
  heartTop: 159,
  heartBottom: 261,
  baseTop: 270,
  baseBottom: 379,
};

// Horizontal bands that slice the artwork into its three tiers. Each cut falls
// inside a transparent gap between tiers (top↔heart ≈ y153, heart↔base ≈ y265),
// so the picture reassembles seamlessly when closed and the per-tier slices ride
// their own <m.g> when the pyramid opens. Full SVG viewBox height is 420.
const TIER_CLIP_BANDS: Record<ActiveLayer, { y: number; height: number }> = {
  top: { y: 0, height: 153 },
  heart: { y: 153, height: 112 },
  base: { y: 265, height: 155 },
};

function svgNumber(value: number) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2).replace(/\.?0+$/, '');
}

function pointToken([x, y]: Point) {
  return `${svgNumber(x)} ${svgNumber(y)}`;
}

function segmentLength([fromX, fromY]: Point, [toX, toY]: Point) {
  return Math.hypot(toX - fromX, toY - fromY);
}

function polygonGeometry(points: readonly Point[]): PolygonGeometry {
  const [firstPoint] = points;
  const closedPoints = [...points, firstPoint];
  const path = `M${closedPoints.map(pointToken).join(' L')}`;
  const length = closedPoints.slice(1).reduce((total, point, index) => total + segmentLength(closedPoints[index], point), 0);

  return { path, length };
}

function polygonPath(points: readonly Point[]) {
  return polygonGeometry(points).path;
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

function tierHitGeometry(topY: number, bottomY: number) {
  return polygonGeometry([
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

function tierCrestPath(topY: number) {
  return linePath(pointOnEdge(PYRAMID_OUTER.leftBase, topY), pointOnEdge(PYRAMID_OUTER.rightBase, topY));
}

const baseHitGeometry = tierHitGeometry(PYRAMID_Y.baseTop, PYRAMID_Y.baseBottom);
const heartHitGeometry = tierHitGeometry(PYRAMID_Y.heartTop, PYRAMID_Y.heartBottom);
const topHitGeometry = polygonGeometry([
  PYRAMID_OUTER.apex,
  pointOnEdge(PYRAMID_OUTER.rightBase, PYRAMID_Y.topBottom),
  pointOnEdge(PYRAMID_OUTER.leftBase, PYRAMID_Y.topBottom),
]);

const layerGeometry = {
  base: {
    hitPath: baseHitGeometry.path,
    hitPathLength: baseHitGeometry.length,
    faces: tierFaces(PYRAMID_Y.baseTop, PYRAMID_Y.baseBottom),
    crest: tierCrestPath(PYRAMID_Y.baseTop),
    channel: {
      start: [PYRAMID_CENTER_X, PYRAMID_Y.baseTop + 6] as Point,
      end: [PYRAMID_CENTER_X, PYRAMID_Y.baseBottom - 7] as Point,
    },
  },
  heart: {
    hitPath: heartHitGeometry.path,
    hitPathLength: heartHitGeometry.length,
    faces: tierFaces(PYRAMID_Y.heartTop, PYRAMID_Y.heartBottom),
    crest: tierCrestPath(PYRAMID_Y.heartTop),
    channel: {
      start: [PYRAMID_CENTER_X, PYRAMID_Y.heartTop + 6] as Point,
      end: [PYRAMID_CENTER_X, PYRAMID_Y.heartBottom - 6] as Point,
    },
  },
  top: {
    hitPath: topHitGeometry.path,
    hitPathLength: topHitGeometry.length,
    faces: apexFaces(PYRAMID_Y.topBottom),
    channel: {
      start: [PYRAMID_CENTER_X, PYRAMID_OUTER.apex[1] + 9] as Point,
      end: [PYRAMID_CENTER_X, PYRAMID_Y.topBottom - 8] as Point,
    },
  },
} satisfies Record<ActiveLayer, Pick<LayerConfig, 'hitPath' | 'hitPathLength' | 'faces' | 'channel' | 'crest'>>;

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
    <m.div
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
    </m.div>
  );
}

function MatchedNoteChip({
  note,
  link,
}: {
  note: string;
  link: NoteAccordLink;
}) {
  const pct = link.displayPct;
  const glowRadius = Math.round(5 + pct * 0.08);
  const glowAlpha = ((pct / 100) * 0.5).toFixed(2);

  // Matched notes carry a steady gold glow scaled by match strength. The glow is
  // a static text-shadow — no looping animation — so the note text stays perfectly
  // still instead of shimmering/wobbling per character.
  return (
    <span
      title={`${link.row.label} · ${pct}%`}
      style={{ textShadow: `0 0 ${glowRadius}px rgba(252,157,25,${glowAlpha})` }}
      className="inline text-[8.5px] sm:text-[10px] font-semibold leading-relaxed text-[#ffd98a]"
    >
      {note}
    </span>
  );
}

function LayerNotesList({
  notes,
  links,
  transition,
}: {
  notes: string[];
  links: Map<string, NoteAccordLink>;
  transition: Transition;
}) {
  return (
    <m.div
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
    </m.div>
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
    <m.div
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
              <m.span
                className="absolute inset-y-0 left-0 origin-left rounded-full bg-gradient-to-r from-[#9f6a1f] via-[#fc9d19] to-[#ffe1a3]"
                // Fill is full-width and revealed via `scaleX` (origin-left) so a
                // selection change tweens a GPU transform, not `width` (layout).
                // The glow is a static box-shadow rather than a looped one — the
                // opacity pulse below already carries its intensity to the shadow,
                // which avoids a per-frame box-shadow repaint over the live SVG.
                style={{
                  width: '100%',
                  willChange: 'transform',
                  boxShadow: prefersReducedMotion
                    ? '0 0 8px rgba(252,157,25,0.28)'
                    : '0 0 12px rgba(252,157,25,0.42)',
                }}
                initial={false}
                animate={{
                  scaleX: pct / 100,
                  opacity: prefersReducedMotion ? 0.78 : [0.72, 1, 0.72],
                }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0.2 }
                    : {
                        scaleX: { duration: 0.56, ease: CALM_EASE },
                        opacity: { duration: 1.45, repeat: DECORATIVE_REPEAT_COUNT, ease: 'easeInOut' },
                      }
                }
              />
            </span>
          </div>
        );
      })}
    </m.div>
  );
}

function seededUnit(index: number, salt: number) {
  const value = Math.sin(index * 91.73 + salt * 17.19) * 10000;
  return value - Math.floor(value);
}

// Deterministic dust field. Canvas animation below draws these in one render loop
// instead of keeping a separate animated SVG node alive for each mote.
const DUST_MOTES: DustMote[] = Array.from({ length: 14 }, (_, index) => ({
  id: `mote-${index}`,
  cx: 30 + seededUnit(index, 1) * 300,
  cy: 50 + seededUnit(index, 2) * 320,
  r: 0.35 + seededUnit(index, 3) * 1.1,
  delay: seededUnit(index, 4) * 7,
  duration: 12 + seededUnit(index, 5) * 10,
  sway: (seededUnit(index, 6) - 0.5) * 12,
}));

// Static constellation pinpricks — fixed deep-field starlight for parallax depth
const CONSTELLATION_DOTS: ConstellationDot[] = [
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
  { cx: 118, cy: 46, r: 0.85, opacity: 0.52 },
  { cx: 252, cy: 40, r: 0.6, opacity: 0.4 },
  { cx: 40, cy: 138, r: 0.45, opacity: 0.3 },
  { cx: 324, cy: 122, r: 0.8, opacity: 0.48 },
  { cx: 14, cy: 332, r: 0.4, opacity: 0.26 },
  { cx: 346, cy: 312, r: 0.5, opacity: 0.34 },
];

function drawAtmosphere(
  context: CanvasRenderingContext2D,
  viewportWidth: number,
  viewportHeight: number,
  timeMs: number,
  reducedMotion: boolean,
) {
  context.clearRect(0, 0, viewportWidth, viewportHeight);

  const scale = Math.min(viewportWidth / 360, viewportHeight / 420);
  const offsetX = (viewportWidth - 360 * scale) / 2;
  const offsetY = (viewportHeight - 420 * scale) / 2;

  context.save();
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);
  context.globalCompositeOperation = 'screen';

  CONSTELLATION_DOTS.forEach((star, index) => {
    const pulse = reducedMotion ? 0.85 : 0.55 + 0.4 * ((Math.sin(timeMs / (1120 + index * 80) + index * 0.8) + 1) / 2);
    context.globalAlpha = star.opacity * pulse;
    context.fillStyle = '#fff8e6';
    context.beginPath();
    context.arc(star.cx, star.cy, star.r, 0, Math.PI * 2);
    context.fill();
  });

  DUST_MOTES.forEach((mote) => {
    const progress = reducedMotion ? 0.35 : ((timeMs / 1000 + mote.delay) % mote.duration) / mote.duration;
    const driftY = reducedMotion ? 0 : -42 * progress;
    const driftX = reducedMotion ? 0 : Math.sin(progress * Math.PI * 2) * mote.sway;
    context.globalAlpha = reducedMotion ? 0.08 : Math.sin(progress * Math.PI) * 0.22;
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.arc(mote.cx + driftX, mote.cy + driftY, mote.r, 0, Math.PI * 2);
    context.fill();
  });

  context.restore();
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
}

function AtmosphereCanvas({ reducedMotion, lowRenderBudget }: { reducedMotion: boolean; lowRenderBudget: boolean }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    // Under a constrained budget the render loop never runs (see queueRender),
    // so the only thing a mounted canvas would do is allocate a full-surface 2D
    // backing store on every detail-modal open — a large offscreen IOSurface
    // that feeds the iPhone "A problem repeatedly occurred" memory-pressure
    // kill. Skip allocation entirely; the SVG's own gold-air gradient carries
    // the ambient haze on these devices.
    if (lowRenderBudget) return;
    const canvas = canvasRef.current;
    if (!canvas || typeof window === 'undefined') return;

    const canvasContext = canvas.getContext('2d', { alpha: true });
    if (!canvasContext) return;
    const renderContext: CanvasRenderingContext2D = canvasContext;

    let animationFrame = 0;
    let viewportWidth = 0;
    let viewportHeight = 0;
    const pixelRatio = reducedMotion || lowRenderBudget ? 1 : Math.min(window.devicePixelRatio || 1, 1.75);

    function queueRender() {
      if (!reducedMotion && document.visibilityState === 'visible' && animationFrame === 0) {
        animationFrame = window.requestAnimationFrame(render);
      }
    }

    function render(timeMs: number) {
      animationFrame = 0;
      renderContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      drawAtmosphere(renderContext, viewportWidth, viewportHeight, timeMs, reducedMotion);
      queueRender();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        queueRender();
        return;
      }

      if (animationFrame !== 0) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      viewportWidth = Math.max(1, rect.width);
      viewportHeight = Math.max(1, rect.height);
      canvas.width = Math.round(viewportWidth * pixelRatio);
      canvas.height = Math.round(viewportHeight * pixelRatio);
      render(window.performance.now());
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    resize();

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [lowRenderBudget, reducedMotion]);

  // Don't even mount the element on constrained devices — no DOM node means no
  // canvas backing store is ever allocated for it.
  if (lowRenderBudget) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 h-full w-full mix-blend-screen"
    />
  );
}

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
  const [guidedLayer, setGuidedLayer] = React.useState<ActiveLayer | null>(null);
  const [isGuideSequencing, setIsGuideSequencing] = React.useState(false);
  const rootRef = React.useRef<HTMLElement | null>(null);
  const pointerActivationRef = React.useRef<PointerActivation | null>(null);
  const ignoreClickActivationRef = React.useRef(false);
  const guideHasPlayedRef = React.useRef(false);
  const guideTimersRef = React.useRef<number[]>([]);
  // Phone-class coarse-pointer devices cannot afford the pyramid's heavy paint.
  // Each feGaussianBlur / feDropShadow, the full-surface drop-shadow, and the
  // screen-blend layer allocates a large offscreen IOSurface, and the decorative
  // atmosphere / starfield / glow run ~10 infinite animations. Re-creating and
  // compositing all of that on every detail-modal open exhausts a phone's small
  // GPU/memory budget — WebKit then kills the page ("A problem repeatedly
  // occurred"). iPad Safari keeps tablet layout and interaction motion, but it
  // gets the same no-filter/no-blend compositor path because WebKit repeatedly
  // re-rasterizes those surfaces during modal and PWA transitions.
  // Device class is stable, so sample once.
  const lowRenderBudget = React.useRef(isLowRenderBudget()).current;
  const ipadSafariBlendMode = React.useRef(isIpadSafariPerformanceMode()).current;
  const lightweightEffects = lowRenderBudget || ipadSafariBlendMode;
  const osPrefersReducedMotion = useReducedMotion();
  const prefersReducedMotion = osPrefersReducedMotion === true || lowRenderBudget;
  const atmosphereReducedMotion = prefersReducedMotion || ipadSafariBlendMode;
  const shouldPlayGuide = osPrefersReducedMotion !== true && !lowRenderBudget;
  const idPrefix = React.useId().replace(/:/g, '');
  const state = activeLayer ?? 'idle';
  const engagedLayer = hoveredLayer ?? focusedLayer ?? (activeLayer ? null : guidedLayer);
  const guideLayerSequence = React.useMemo<ActiveLayer[]>(() => {
    const sequence: ActiveLayer[] = [];
    if (topNotes.length > 0) sequence.push('top');
    if (heartNotes.length > 0) sequence.push('heart');
    if (baseNotes.length > 0) sequence.push('base');
    return sequence;
  }, [topNotes.length, heartNotes.length, baseNotes.length]);
  const guideCanPlay = shouldPlayGuide && guideLayerSequence.length > 0;
  const guideVisualsMounted = guideCanPlay && isGuideSequencing;
  // Soft outer halo + crisp core. Slightly heavier on low-render-budget
  // devices, where the bevel/halo paint without the gold-soft bloom filter.
  const guideHaloStrokeWidth = lightweightEffects ? 6.4 : 4.2;
  const guideCoreStrokeWidth = lightweightEffects ? 2.4 : 1.4;
  const guideStartDelayMs = ipadSafariBlendMode ? 1350 : GUIDE_START_DELAY_MS;
  const guideLayerDurationMs = ipadSafariBlendMode ? 1900 : GUIDE_LAYER_DURATION_MS;

  const allLinks = React.useMemo(
    () => resolveNoteAccordLinks([...topNotes, ...heartNotes, ...baseNotes], accordRows ?? []),
    [topNotes, heartNotes, baseNotes, accordRows],
  );

  const id = React.useCallback((name: string) => `${idPrefix}-${name}`, [idPrefix]);
  const fill = React.useCallback((name: string) => `url(#${id(name)})`, [id]);
  // Filter reference that collapses to `undefined` on constrained/iPad WebKit devices,
  // so the element paints without allocating an offscreen filter surface.
  const filterRef = React.useCallback(
    (name: string) => (lightweightEffects ? undefined : `url(#${id(name)})`),
    [id, lightweightEffects],
  );

  const clearGuideTimers = React.useCallback(() => {
    guideTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    guideTimersRef.current = [];
  }, []);

  const cancelGuide = React.useCallback(() => {
    guideHasPlayedRef.current = true;
    clearGuideTimers();
    setGuidedLayer(null);
    setIsGuideSequencing(false);
  }, [clearGuideTimers]);

  React.useEffect(() => {
    if (!guideCanPlay) return;

    const root = rootRef.current;
    if (!root || guideHasPlayedRef.current) return;

    const playGuide = () => {
      if (guideHasPlayedRef.current) return;

      guideHasPlayedRef.current = true;
      clearGuideTimers();
      setGuidedLayer(null);
      setIsGuideSequencing(true);

      guideLayerSequence.forEach((layer, index) => {
        const timer = window.setTimeout(() => {
          setGuidedLayer(layer);
        }, guideStartDelayMs + index * guideLayerDurationMs);
        guideTimersRef.current.push(timer);
      });

      const endTimer = window.setTimeout(() => {
        setGuidedLayer(null);
        setIsGuideSequencing(false);
      }, guideStartDelayMs + guideLayerSequence.length * guideLayerDurationMs);
      guideTimersRef.current.push(endTimer);
    };

    if (typeof IntersectionObserver === 'undefined') {
      playGuide();
      return () => {
        clearGuideTimers();
        setGuidedLayer(null);
        setIsGuideSequencing(false);
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= GUIDE_INTERSECTION_RATIO)) {
          playGuide();
          observer.disconnect();
        }
      },
      {
        root: null,
        rootMargin: '0px 0px -2% 0px',
        threshold: [0.12, GUIDE_INTERSECTION_RATIO, 0.38, 0.55],
      },
    );

    observer.observe(root);

    return () => {
      observer.disconnect();
      clearGuideTimers();
      setGuidedLayer(null);
      setIsGuideSequencing(false);
    };
  }, [clearGuideTimers, guideCanPlay, guideLayerDurationMs, guideLayerSequence, guideStartDelayMs]);

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
    cancelGuide();
    setActiveLayer((current) => (current === layer ? null : layer));
  }, [cancelGuide]);

  const handleLayerPointerDown = React.useCallback((event: React.PointerEvent<SVGGElement>, layer: ActiveLayer) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    event.stopPropagation();
    cancelGuide();
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
  }, [cancelGuide]);

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

  const { pulseTransition, shimmerTransition, atmosphericTransition, glyphTransition } = React.useMemo(() => {
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
      pulseTransition: { duration: 5.4, ease: SOFT_EASE, repeat: DECORATIVE_REPEAT_COUNT, repeatType: 'mirror' } as Transition,
      floatTransition: { duration: 8.5, ease: 'easeInOut', repeat: DECORATIVE_REPEAT_COUNT, repeatType: 'mirror' } as Transition,
      shimmerTransition: { duration: 6.4, ease: SOFT_EASE, repeat: DECORATIVE_REPEAT_COUNT, repeatType: 'mirror' } as Transition,
      atmosphericTransition: { duration: 10, ease: SOFT_EASE, repeat: DECORATIVE_REPEAT_COUNT, repeatType: 'mirror' } as Transition,
      glyphTransition: { duration: 7.2, ease: 'easeInOut', repeat: DECORATIVE_REPEAT_COUNT, repeatType: 'mirror' } as Transition,
    };
  }, [prefersReducedMotion]);

  return (
    <section
      ref={rootRef}
      className={`relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden px-3 py-5 sm:px-5 ${className}`}
      onClick={() => setActiveLayer(null)}
    >
      <m.div
        className="relative z-10 w-full max-w-[24rem] aspect-[1/1.08] shrink-0 overflow-visible sm:max-w-[26rem]"
        onClick={(event) => event.stopPropagation()}
        initial={prefersReducedMotion ? false : { opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={prefersReducedMotion ? reducedTransition : { duration: 1.1, ease: CALM_EASE }}
      >
        <AtmosphereCanvas reducedMotion={atmosphereReducedMotion} lowRenderBudget={lightweightEffects} />

        <svg
          viewBox="0 0 360 420"
          overflow="visible"
          className={`relative z-10 h-full w-full overflow-visible${lightweightEffects ? '' : ' drop-shadow-[0_24px_44px_rgba(0,0,0,0.48)]'}`}
          role="img"
          aria-label="Interactive fragrance note pyramid"
        >
          <defs>
            {(['top', 'heart', 'base'] as ActiveLayer[]).map((tier) => (
              <clipPath key={tier} id={id(`tier-clip-${tier}`)} clipPathUnits="userSpaceOnUse">
                <rect x="0" y={TIER_CLIP_BANDS[tier].y} width="360" height={TIER_CLIP_BANDS[tier].height} />
              </clipPath>
            ))}

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
              <stop offset="0" stopColor="#96732f" />
              <stop offset="0.14" stopColor="#fffbe8" />
              <stop offset="0.4" stopColor="#ecc365" />
              <stop offset="0.62" stopColor="#d9a945" />
              <stop offset="0.82" stopColor="#fffdf0" />
              <stop offset="1" stopColor="#c08e2e" />
            </linearGradient>

            <linearGradient id={id('top-right')} x1="180" y1="83" x2="231" y2="83" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fffdf0" />
              <stop offset="0.24" stopColor="#e6ba53" />
              <stop offset="0.62" stopColor="#a06a1c" />
              <stop offset="0.88" stopColor="#5e390b" />
              <stop offset="1" stopColor="#3d2406" />
            </linearGradient>

            <radialGradient id={id('top-polish')} cx="50%" cy="25%" r="82%">
              <stop offset="0" stopColor="#fff8df" stopOpacity="0.78" />
              <stop offset="0.38" stopColor="#ffcf70" stopOpacity="0.34" />
              <stop offset="0.7" stopColor="#7f5418" stopOpacity="0.18" />
              <stop offset="1" stopColor="#050607" stopOpacity="0.35" />
            </radialGradient>

            <linearGradient id={id('heart-left')} x1="75" y1="200" x2="180" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#1f1404" />
              <stop offset="0.2" stopColor="#684a16" />
              <stop offset="0.55" stopColor="#a87c33" />
              <stop offset="0.8" stopColor="#e4ba68" />
              <stop offset="1" stopColor="#fff4c9" />
            </linearGradient>

            <linearGradient id={id('heart-right')} x1="180" y1="200" x2="285" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff4c9" />
              <stop offset="0.2" stopColor="#d4a44c" />
              <stop offset="0.56" stopColor="#5e3d10" />
              <stop offset="1" stopColor="#0e0903" />
            </linearGradient>

            <linearGradient id={id('heart-polish')} x1="72" y1="200" x2="288" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#000000" stopOpacity="0.36" />
              <stop offset="0.28" stopColor="#ffdf94" stopOpacity="0.14" />
              <stop offset="0.49" stopColor="#fff8df" stopOpacity="0.62" />
              <stop offset="0.58" stopColor="#ffcf70" stopOpacity="0.25" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.45" />
            </linearGradient>

            <linearGradient id={id('base-left')} x1="21" y1="319" x2="180" y2="319" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#030201" />
              <stop offset="0.22" stopColor="#171108" />
              <stop offset="0.55" stopColor="#37270d" />
              <stop offset="0.82" stopColor="#7d5418" />
              <stop offset="1" stopColor="#b87e29" />
            </linearGradient>

            <linearGradient id={id('base-right')} x1="180" y1="319" x2="339" y2="319" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#b87e29" />
              <stop offset="0.23" stopColor="#684716" />
              <stop offset="0.6" stopColor="#1d1407" />
              <stop offset="1" stopColor="#010100" />
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

            {/* Center-ridge crest — a polished metallic catch-light that runs the
                full height of the spine where the two tier faces meet. Bright,
                warm gold at the apex falling to a deep antique gold at the base
                so the raised edge reads as solid bevelled metal, not a drawn line. */}
            <linearGradient id={id('ridge-core')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fffdf4" stopOpacity="0.98" />
              <stop offset="0.32" stopColor="#ffe9b8" stopOpacity="0.9" />
              <stop offset="0.66" stopColor="#ffcf70" stopOpacity="0.66" />
              <stop offset="1" stopColor="#b87924" stopOpacity="0.42" />
            </linearGradient>

            {/* Shadow side of the ridge — the face turning away from the light,
                seated just to the right of the crest to give the spine volume. */}
            <linearGradient id={id('ridge-shadow')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#180d02" stopOpacity="0.42" />
              <stop offset="0.5" stopColor="#0a0500" stopOpacity="0.58" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.68" />
            </linearGradient>

            <linearGradient id={id('groove-highlight')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
              <stop offset="0.42" stopColor="#ffffff" stopOpacity="0.5" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0.22" />
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

            <radialGradient id={id('apex-glint-aura')} cx="50%" cy="50%" r="56%">
              <stop offset="0" stopColor="#fffdf4" stopOpacity="0.5" />
              <stop offset="0.28" stopColor="#ffe7ad" stopOpacity="0.26" />
              <stop offset="0.62" stopColor="#fc9d19" stopOpacity="0.1" />
              <stop offset="1" stopColor="#fc9d19" stopOpacity="0" />
            </radialGradient>

            <radialGradient id={id('apex-glint-core')} cx="42%" cy="32%" r="72%">
              <stop offset="0" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="0.2" stopColor="#fff9e8" stopOpacity="1" />
              <stop offset="0.44" stopColor="#ffe1a3" stopOpacity="0.92" />
              <stop offset="0.72" stopColor="#fcaa28" stopOpacity="0.68" />
              <stop offset="1" stopColor="#7a4b0d" stopOpacity="0.08" />
            </radialGradient>

            <linearGradient id={id('apex-glint-beam')} x1="160" y1="27" x2="200" y2="27" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="0.28" stopColor="#ffe0a0" stopOpacity="0.34" />
              <stop offset="0.49" stopColor="#fffdf4" stopOpacity="0.96" />
              <stop offset="0.54" stopColor="#d9f7ff" stopOpacity="0.52" />
              <stop offset="0.74" stopColor="#ffd98a" stopOpacity="0.26" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>

            <linearGradient id={id('apex-glint-prism')} x1="172" y1="19" x2="188" y2="35" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#d9f7ff" stopOpacity="0.36" />
              <stop offset="0.34" stopColor="#fffdf4" stopOpacity="0.74" />
              <stop offset="0.62" stopColor="#ffd98a" stopOpacity="0.8" />
              <stop offset="1" stopColor="#fc9d19" stopOpacity="0.2" />
            </linearGradient>

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

            <filter id={id('edge-glow')} filterUnits="userSpaceOnUse" x="-24" y="-24" width="408" height="468" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id={id('gold-soft')} filterUnits="userSpaceOnUse" x="-48" y="-48" width="456" height="516" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.45" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id={id('apex-glint-bloom')} filterUnits="userSpaceOnUse" x="148" y="-6" width="64" height="68" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.35" result="softBloom" />
              <feColorMatrix
                in="softBloom"
                type="matrix"
                values="1.08 0 0 0 0  0 1.01 0 0 0  0 0 0.88 0 0  0 0 0 0.72 0"
                result="warmBloom"
              />
              <feMerge>
                <feMergeNode in="warmBloom" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
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

            <linearGradient id={id('edge-cut')} x1="21" y1="0" x2="339" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff8e6" stopOpacity="0" />
              <stop offset="0.2" stopColor="#ffe9b8" stopOpacity="0.5" />
              <stop offset="0.5" stopColor="#fffdf4" stopOpacity="0.92" />
              <stop offset="0.8" stopColor="#ffe9b8" stopOpacity="0.5" />
              <stop offset="1" stopColor="#fff8e6" stopOpacity="0" />
            </linearGradient>

            <linearGradient id={id('mirror-fade')} x1="0" y1="380" x2="0" y2="420" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
              <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.16" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>

            <mask id={id('mirror-mask')} maskUnits="userSpaceOnUse" x="0" y="376" width="360" height="44">
              <rect x="0" y="376" width="360" height="44" fill={fill('mirror-fade')} />
            </mask>
          </defs>

          {/* Ambient depth field — soft gold air + slow-drifting starfield. No grid, no reticles. */}
          <g aria-hidden pointerEvents="none" className={lightweightEffects ? '' : 'mix-blend-screen'}>
            <m.circle
              cx="180"
              cy="210"
              r="190"
              fill={fill('background-gold-air')}
              animate={prefersReducedMotion ? { opacity: 0.55 } : { opacity: [0.4, 0.62, 0.4], scale: [0.985, 1.015, 0.985] }}
              transition={atmosphericTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />

          </g>

          {/* Base Reflection */}
          <ellipse cx={PYRAMID_CENTER_X} cy={PYRAMID_Y.baseBottom + 12} rx="165" ry="12" fill={fill('pyramid-cast-reflection')} pointerEvents="none" />

          {/* Mirror floor — the base tier reflected into the glossy black surface beneath the pyramid.
              Pure geometry + a gradient mask (no filters), but still skipped on low render budgets. */}
          {!lightweightEffects && (
            <g aria-hidden pointerEvents="none" mask={`url(#${id('mirror-mask')})`} opacity="0.32">
              <g transform={`translate(0 ${(PYRAMID_Y.baseBottom + 10) * 2}) scale(1 -1)`}>
                <path d={layerGeometry.base.faces[0]} fill={fill('base-left')} />
                <path d={layerGeometry.base.faces[1]} fill={fill('base-right')} />
                <path d={layerGeometry.base.hitPath} fill={fill('base-polish')} opacity="0.55" />
              </g>
            </g>
          )}

          {/* Ground horizon line — grounds the structure with a soft luminous footing */}
          <m.path
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
            const guideDashLength = layer.hitPathLength + GUIDE_DASH_OVERSCAN_UNITS;
            const guideDashPattern = `${guideDashLength} ${guideDashLength}`;
            const guideDashTrace = [guideDashLength, 0, 0, 0];

            return (
              <m.g
                key={layer.key}
                role={isEmpty ? undefined : 'button'}
                tabIndex={isEmpty ? -1 : 0}
                aria-label={layer.ariaLabel}
                aria-pressed={isEmpty ? undefined : isActive}
                aria-disabled={isEmpty || undefined}
                className={`outline-none [&:focus-visible_.focus-ring]:opacity-100 ${isEmpty ? 'cursor-default' : 'cursor-pointer'}`}
                initial={false}
                animate={
                  lightweightEffects
                    ? {
                        y: targetY,
                        opacity: targetOpacity,
                        scale: targetScale,
                      }
                    : {
                        y: targetY,
                        opacity: targetOpacity,
                        scale: targetScale,
                        filter: isEmpty
                          ? 'saturate(1.05) brightness(0.88)'
                          : isMuted
                            ? 'saturate(0.85) brightness(0.92)'
                            : 'saturate(1) brightness(1)',
                      }
                }
                transition={
                  prefersReducedMotion
                    ? reducedTransition
                    : lightweightEffects
                      ? { ...layerTransition, opacity: { duration: 0.46, ease: CALM_EASE } }
                      : { ...layerTransition, filter: { duration: 0.44, ease: CALM_EASE }, opacity: { duration: 0.46, ease: CALM_EASE } }
                }
                style={{
                  transformBox: 'view-box',
                  transformOrigin: `${PYRAMID_CENTER_X}px ${LAYER_CENTER_Y[layer.key]}px`,
                  WebkitTapHighlightColor: 'transparent',
                  touchAction: 'manipulation',
                  willChange: activeLayer !== null || isEngaged ? (lightweightEffects ? 'transform, opacity' : 'transform, opacity, filter') : 'auto',
                }}
                onPointerEnter={isEmpty ? undefined : (event) => {
                  if (event.pointerType !== 'mouse') return;
                  cancelGuide();
                  setHoveredLayer(layer.key);
                }}
                onPointerLeave={isEmpty ? undefined : (event) => {
                  if (event.pointerType !== 'mouse') return;
                  setHoveredLayer((current) => (current === layer.key ? null : current));
                }}
                onFocus={isEmpty ? undefined : () => {
                  cancelGuide();
                  setFocusedLayer(layer.key);
                }}
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

                <g filter={isActive ? filterRef('piece-active-shadow') : isEngaged ? filterRef('piece-engaged-shadow') : filterRef('piece-shadow')}>
                  {/* The fragrance-note artwork, sliced into its three tiers by a
                      horizontal clip band whose cuts fall inside the transparent
                      gaps between tiers. Each slice lives in its tier's <m.g>,
                      so the picture opens up tier-by-tier exactly like the original
                      procedural pyramid — the full image reassembles seamlessly at
                      rest and separates cleanly when a tier is selected. */}
                  <image
                    href={NOTE_PYRAMID_ARTWORK_SRC}
                    x="0"
                    y="0"
                    width="360"
                    height="420"
                    preserveAspectRatio="xMidYMid meet"
                    clipPath={`url(#${id(`tier-clip-${layer.key}`)})`}
                    pointerEvents="none"
                  />

                  <m.path
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

                {/* Outer outlining effect — a dynamic gold rim that traces each
                    tier's silhouette and brightens on hover/active, restored to sit
                    directly on the artwork's baked border. */}
                <m.path
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
                  filter={filterRef('edge-glow')}
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <m.path
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
                      ? { opacity: isActive ? 0.4 : isGuided && lightweightEffects ? 0.38 : isEngaged ? 0.22 : 0 }
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

                {/* Premium guide outline — a single, slow, seamless gold tracer that
                    draws the complete tier silhouette, holds it fully outlined, then
                    releases. Two coupled strokes: a soft gold halo for the bloom and a
                    crisp pearlescent-gold core for the edge. Both share the identical
                    closed hit-path, so the outline lands on the exact shape every time;
                    the sequence runs top → heart → base one tier at a time. */}
                {guideVisualsMounted && (
                  <m.path
                    d={layer.hitPath}
                    fill="none"
                    stroke="#fc9d19"
                    strokeWidth={guideHaloStrokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pointerEvents="none"
                    filter={filterRef('gold-soft')}
                    strokeDasharray={guideDashPattern}
                    strokeDashoffset={guideDashLength}
                    initial={false}
                    animate={
                      isGuided
                        ? {
                            strokeDashoffset: guideDashTrace,
                            opacity: lightweightEffects ? [0, 0.62, 0.62, 0] : [0, 0.46, 0.46, 0],
                          }
                        : { strokeDashoffset: guideDashLength, opacity: 0 }
                    }
                    transition={
                      isGuided
                        ? {
                            strokeDashoffset: { duration: GUIDE_TRACE_DURATION_S, times: [...GUIDE_TRACE_TIMES], ease: CALM_EASE },
                            opacity: { duration: GUIDE_TRACE_DURATION_S, times: [...GUIDE_TRACE_TIMES], ease: CALM_EASE },
                          }
                        : { duration: 0.2, ease: CALM_EASE }
                    }
                    style={{ willChange: 'stroke-dashoffset, opacity' }}
                  />
                )}

                {guideVisualsMounted && (
                  <m.path
                    d={layer.hitPath}
                    fill="none"
                    stroke={fill('outer-rim')}
                    strokeWidth={guideCoreStrokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="miter"
                    pointerEvents="none"
                    filter={filterRef('gold-soft')}
                    strokeDasharray={guideDashPattern}
                    strokeDashoffset={guideDashLength}
                    initial={false}
                    animate={
                      isGuided
                        ? {
                            strokeDashoffset: guideDashTrace,
                            opacity: [0, 1, 1, 0],
                          }
                        : { strokeDashoffset: guideDashLength, opacity: 0 }
                    }
                    transition={
                      isGuided
                        ? {
                            strokeDashoffset: { duration: GUIDE_TRACE_DURATION_S, times: [...GUIDE_TRACE_TIMES], ease: CALM_EASE },
                            opacity: { duration: GUIDE_TRACE_DURATION_S, times: [...GUIDE_TRACE_TIMES], ease: CALM_EASE },
                          }
                        : { duration: 0.2, ease: CALM_EASE }
                    }
                    style={{ willChange: 'stroke-dashoffset, opacity' }}
                  />
                )}

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
              </m.g>
            );
          })}

          <AnimatePresence>
            {gapDots.map((dot) =>
              dot.isVisible ? (
                <m.g
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
                  <m.circle
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

                  <m.circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="2.85"
                    fill={fill('gold-dot')}
                    filter={filterRef('gold-soft')}
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
                </m.g>
              ) : null,
            )}
          </AnimatePresence>

          <m.g
            aria-hidden
            pointerEvents="none"
            filter={filterRef('glyph-soft')}
            animate={prefersReducedMotion ? { opacity: 0.96, y: 0 } : { opacity: [0.88, 1, 0.88], y: [0, -0.6, 0] }}
            transition={glyphTransition}
            style={{
              transformBox: 'view-box',
              transformOrigin: '180px 401px',
              willChange: prefersReducedMotion ? 'auto' : 'transform, opacity',
            }}
          >
            {/* Soft pedestal underlight — a wide, flat halo resting on the glossy black surface */}
            <m.ellipse
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
            <m.g
              animate={prefersReducedMotion ? { opacity: 0 } : { opacity: [0, 0.5, 0], x: [-30, 30, 30] }}
              transition={{ duration: 4.8, ease: SOFT_EASE, repeat: DECORATIVE_REPEAT_COUNT, repeatDelay: 1.4 }}
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
            </m.g>

            {/* Center orb — small, refined, seated into the reflection base */}
            <m.circle
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

            <m.circle
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
          </m.g>
        </svg>

        {/* Enhanced Hovering Glassmorphic Text UI */}
        <AnimatePresence mode="wait">
          {selectedLayer ? (
            <m.div
              key={selectedLayer.key}
              initial={lightweightEffects ? { opacity: 0, y: 8, scale: 0.985 } : { opacity: 0, y: 8, scale: 0.985, filter: 'blur(3px)' }}
              animate={lightweightEffects ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={lightweightEffects ? { opacity: 0, y: -5, scale: 0.99 } : { opacity: 0, y: -5, scale: 0.99, filter: 'blur(2px)' }}
              transition={prefersReducedMotion ? reducedTransition : { duration: 0.32, ease: CALM_EASE }}
              className={`pointer-events-none absolute left-1/2 z-50 w-[84%] max-w-[15rem] -translate-x-1/2 overflow-hidden rounded-xl border border-white/[0.12] bg-[#08080b]/95 px-2.5 py-2.5 shadow-[0_14px_36px_-12px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(252,157,25,0.12)] sm:max-w-[18.5rem] sm:px-4 sm:py-3.5 ${selectedLayer.revealClass}`}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-[3px] rounded-lg border border-white/[0.05]"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-[#ffd98a]/55 to-transparent"
              />

              <div className="relative flex flex-col items-center justify-center space-y-1.5 sm:space-y-2 text-center">
                <m.div
                   initial={{ opacity: 0, y: 4 }}
                   animate={{ opacity: 1, y: 0 }}
                   exit={{ opacity: 0, y: -3 }}
                   transition={prefersReducedMotion ? reducedTransition : { duration: 0.6, delay: 0.08, ease: CALM_EASE }}
                   className="flex w-full flex-col items-center justify-center"
                >
                  <h3 className="bg-gradient-to-br from-[#fff3d4] via-[#fc9d19] to-[#8c5a1a] bg-clip-text text-[9.5px] sm:text-[10.5px] font-bold uppercase tracking-[0.38em] text-transparent drop-shadow-[0_2px_10px_rgba(252,157,25,0.4)]">
                    {selectedLayer.title}
                  </h3>
                </m.div>

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
              </div>
            </m.div>
          ) : null}
        </AnimatePresence>
      </m.div>
    </section>
  );
};
