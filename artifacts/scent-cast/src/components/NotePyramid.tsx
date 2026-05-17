import React from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';

type ActiveLayer = 'top' | 'heart' | 'base';
type Point = readonly [number, number];

type NotePyramidProps = {
  topNotes: string[];
  heartNotes: string[];
  baseNotes: string[];
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
const WEIGHTED_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

type LayerMotionState = ActiveLayer | 'idle';
type LayerOffset = { y: number; scale: number; opacity: number };

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
  duration: 0.72,
  ease: WEIGHTED_EASE,
};

const reducedTransition: Transition = {
  duration: 0.01,
};

const PYRAMID_CENTER_X = 180;

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

function offsetPoint([x, y]: Point, dx: number): Point {
  return [x + dx, y];
}

// Particle System Generation
const DUST_MOTES = Array.from({ length: 15 }).map((_, i) => ({
  id: `mote-${i}`,
  cx: 30 + Math.random() * 300,
  cy: 50 + Math.random() * 320,
  r: 0.4 + Math.random() * 1.4,
  delay: Math.random() * 5,
  duration: 7 + Math.random() * 8,
  sway: (Math.random() - 0.5) * 16,
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

// HUD-style corner reticles framing the canvas
const CORNER_RETICLES: { x: number; y: number; scaleX: 1 | -1; scaleY: 1 | -1 }[] = [
  { x: 14, y: 14, scaleX: 1, scaleY: 1 },
  { x: 346, y: 14, scaleX: -1, scaleY: 1 },
  { x: 14, y: 406, scaleX: 1, scaleY: -1 },
  { x: 346, y: 406, scaleX: -1, scaleY: -1 },
];

export const NotePyramid: React.FC<NotePyramidProps> = ({
  topNotes,
  heartNotes,
  baseNotes,
  className = '',
}) => {
  const [activeLayer, setActiveLayer] = React.useState<ActiveLayer | null>(null);
  const [hoveredLayer, setHoveredLayer] = React.useState<ActiveLayer | null>(null);
  const [focusedLayer, setFocusedLayer] = React.useState<ActiveLayer | null>(null);
  const rootRef = React.useRef<HTMLElement | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const idPrefix = React.useId().replace(/:/g, '');
  const state = activeLayer ?? 'idle';
  const engagedLayer = hoveredLayer ?? focusedLayer;

  const id = React.useCallback((name: string) => `${idPrefix}-${name}`, [idPrefix]);
  const fill = React.useCallback((name: string) => `url(#${id(name)})`, [id]);

  React.useEffect(() => {
    if (!activeLayer) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveLayer(null);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      setActiveLayer(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
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
      revealClass: 'top-[68%]',
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
      revealClass: 'top-[44%]',
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
      revealClass: 'top-[15%]',
      grainOpacity: 0.28,
      polishOpacity: 0.82,
      rimOpacity: 0.98,
      notes: topNotes,
    },
  ], [fill, baseNotes, heartNotes, topNotes]);

  const selectedLayer = layers.find((layer) => layer.key === activeLayer);

  const handleLayerActivate = React.useCallback((layer: ActiveLayer) => {
    setActiveLayer((current) => (current === layer ? null : layer));
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

  const { pulseTransition, floatTransition, shimmerTransition, atmosphericTransition, rotationTransition, counterRotationTransition } = React.useMemo(() => {
    if (prefersReducedMotion) {
      return {
        pulseTransition: reducedTransition,
        floatTransition: reducedTransition,
        shimmerTransition: reducedTransition,
        atmosphericTransition: reducedTransition,
        rotationTransition: reducedTransition,
        counterRotationTransition: reducedTransition,
      };
    }
    return {
      pulseTransition: { duration: 3.2, ease: SOFT_EASE, repeat: Infinity, repeatType: 'mirror' } as Transition,
      floatTransition: { duration: 4, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' } as Transition,
      shimmerTransition: { duration: 3.8, ease: SOFT_EASE, repeat: Infinity, repeatType: 'mirror' } as Transition,
      atmosphericTransition: { duration: 6.5, ease: SOFT_EASE, repeat: Infinity, repeatType: 'mirror' } as Transition,
      rotationTransition: { duration: 45, ease: 'linear', repeat: Infinity } as Transition,
      counterRotationTransition: { duration: 60, ease: 'linear', repeat: Infinity } as Transition,
    };
  }, [prefersReducedMotion]);

  return (
    <section
      ref={rootRef}
      className={`relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden px-3 py-5 sm:px-5 ${className}`}
      onClick={() => setActiveLayer(null)}
    >
      {/* Immersive ambient vignette overlay */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.6)_100%)] mix-blend-multiply" />

      <motion.div
        className="relative z-10 w-full max-w-[24rem] aspect-[1/1.08] shrink-0 overflow-visible sm:max-w-[26rem]"
        onClick={(event) => event.stopPropagation()}
        initial={prefersReducedMotion ? false : { opacity: 0, y: 18, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={prefersReducedMotion ? reducedTransition : { duration: 0.85, ease: WEIGHTED_EASE }}
      >
        <svg
          viewBox="0 0 360 420"
          className="h-full w-full overflow-visible drop-shadow-[0_20px_35px_rgba(0,0,0,0.4)]"
          role="img"
          aria-label="Interactive fragrance note pyramid"
        >
          <defs>
            <radialGradient id={id('background-luminance')} cx="50%" cy="49%" r="58%">
              <stop offset="0" stopColor="#3a3025" stopOpacity="0.25" />
              <stop offset="0.34" stopColor="#1a1816" stopOpacity="0.25" />
              <stop offset="1" stopColor="#020203" stopOpacity="0" />
            </radialGradient>

            <radialGradient id={id('background-amber-air')} cx="50%" cy="48%" r="56%">
              <stop offset="0" stopColor="#ffb84d" stopOpacity="0.18" />
              <stop offset="0.4" stopColor="#ffb84d" stopOpacity="0.08" />
              <stop offset="1" stopColor="#ffb84d" stopOpacity="0" />
            </radialGradient>

            <radialGradient id={id('pyramid-cast-reflection')} cx="50%" cy="92%" r="40%">
              <stop offset="0" stopColor="#ffb84d" stopOpacity="0.12" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.03" />
              <stop offset="1" stopColor="#000000" stopOpacity="0" />
            </radialGradient>

            <pattern id={id('background-grain')} width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M0 1 H8 M1 5 H8" stroke="#ffffff" strokeOpacity="0.055" strokeWidth="0.65" />
            </pattern>

            <linearGradient id={id('top-left')} x1="129" y1="83" x2="181" y2="83" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#a3a6a5" />
              <stop offset="0.15" stopColor="#fcfcf8" />
              <stop offset="0.44" stopColor="#eaebe7" />
              <stop offset="0.8" stopColor="#ffffff" />
              <stop offset="1" stopColor="#c3c4c0" />
            </linearGradient>

            <linearGradient id={id('top-right')} x1="180" y1="83" x2="231" y2="83" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.26" stopColor="#eeefe8" />
              <stop offset="0.68" stopColor="#cdceca" />
              <stop offset="1" stopColor="#939797" />
            </linearGradient>

            <radialGradient id={id('top-polish')} cx="50%" cy="25%" r="82%">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.75" />
              <stop offset="0.38" stopColor="#ffffff" stopOpacity="0.32" />
              <stop offset="0.7" stopColor="#a9abad" stopOpacity="0.15" />
              <stop offset="1" stopColor="#050607" stopOpacity="0.3" />
            </radialGradient>

            <linearGradient id={id('heart-left')} x1="75" y1="200" x2="180" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#35393a" />
              <stop offset="0.2" stopColor="#676a6a" />
              <stop offset="0.58" stopColor="#8d908e" />
              <stop offset="0.82" stopColor="#c4c4bf" />
              <stop offset="1" stopColor="#e8e8e5" />
            </linearGradient>

            <linearGradient id={id('heart-right')} x1="180" y1="200" x2="285" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#e8e8e5" />
              <stop offset="0.22" stopColor="#b4b5b0" />
              <stop offset="0.58" stopColor="#606362" />
              <stop offset="1" stopColor="#1e2021" />
            </linearGradient>

            <linearGradient id={id('heart-polish')} x1="72" y1="200" x2="288" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#000000" stopOpacity="0.36" />
              <stop offset="0.28" stopColor="#ffffff" stopOpacity="0.1" />
              <stop offset="0.49" stopColor="#ffffff" stopOpacity="0.6" />
              <stop offset="0.58" stopColor="#ffffff" stopOpacity="0.22" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.45" />
            </linearGradient>

            <linearGradient id={id('base-left')} x1="21" y1="319" x2="180" y2="319" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#060708" />
              <stop offset="0.24" stopColor="#121415" />
              <stop offset="0.58" stopColor="#292d2f" />
              <stop offset="0.84" stopColor="#4c4e4c" />
              <stop offset="1" stopColor="#6a6b66" />
            </linearGradient>

            <linearGradient id={id('base-right')} x1="180" y1="319" x2="339" y2="319" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#6a6b66" />
              <stop offset="0.25" stopColor="#414547" />
              <stop offset="0.62" stopColor="#191c1f" />
              <stop offset="1" stopColor="#020303" />
            </linearGradient>

            <linearGradient id={id('base-polish')} x1="23" y1="320" x2="337" y2="320" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#000000" stopOpacity="0.42" />
              <stop offset="0.35" stopColor="#ffffff" stopOpacity="0.06" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.46" />
              <stop offset="0.62" stopColor="#ffffff" stopOpacity="0.16" />
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

            <linearGradient id={id('active-edge-amber')} x1="30" y1="40" x2="330" y2="370" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffb84d" stopOpacity="0.2" />
              <stop offset="0.42" stopColor="#ffeaad" stopOpacity="0.75" />
              <stop offset="0.58" stopColor="#fc9d19" stopOpacity="0.55" />
              <stop offset="1" stopColor="#6b400a" stopOpacity="0.18" />
            </linearGradient>

            <linearGradient id={id('vertical-falloff')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
              <stop offset="0.36" stopColor="#ffffff" stopOpacity="0.08" />
              <stop offset="0.78" stopColor="#000000" stopOpacity="0.28" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.5" />
            </linearGradient>

            <linearGradient id={id('outer-rim')} x1="28" y1="37" x2="332" y2="360" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
              <stop offset="0.18" stopColor="#e9eae8" stopOpacity="0.85" />
              <stop offset="0.48" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="0.72" stopColor="#b1b4b5" stopOpacity="0.7" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0.88" />
            </linearGradient>

            <linearGradient id={id('hairline-rim')} x1="21" y1="372" x2="339" y2="25" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#adb0b0" stopOpacity="0.42" />
              <stop offset="0.44" stopColor="#ffffff" stopOpacity="0.95" />
              <stop offset="0.56" stopColor="#ffffff" stopOpacity="0.6" />
              <stop offset="1" stopColor="#caced1" stopOpacity="0.55" />
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

            <linearGradient id={id('groove-amber')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffeaad" stopOpacity="0.65" />
              <stop offset="0.45" stopColor="#fc9d19" stopOpacity="0.5" />
              <stop offset="1" stopColor="#6b400a" stopOpacity="0.25" />
            </linearGradient>

            <radialGradient id={id('amber-dot')} cx="36%" cy="30%" r="74%">
              <stop offset="0" stopColor="#fff3d4" />
              <stop offset="0.24" stopColor="#ffc766" />
              <stop offset="0.55" stopColor="#fc9d19" />
              <stop offset="0.8" stopColor="#7a4b0d" />
              <stop offset="1" stopColor="#211003" />
            </radialGradient>

            <radialGradient id={id('amber-glow')} cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#fcaa28" stopOpacity="0.68" />
              <stop offset="0.44" stopColor="#fc9d19" stopOpacity="0.28" />
              <stop offset="1" stopColor="#fc9d19" stopOpacity="0" />
            </radialGradient>

            <linearGradient id={id('glyph-line-left')} x1="106" y1="397" x2="164" y2="397" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fc9d19" stopOpacity="0" />
              <stop offset="0.62" stopColor="#fc9d19" stopOpacity="0.55" />
              <stop offset="1" stopColor="#ffc766" stopOpacity="0.95" />
            </linearGradient>

            <linearGradient id={id('glyph-line-right')} x1="196" y1="397" x2="254" y2="397" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffc766" stopOpacity="0.95" />
              <stop offset="0.38" stopColor="#fc9d19" stopOpacity="0.55" />
              <stop offset="1" stopColor="#fc9d19" stopOpacity="0" />
            </linearGradient>

            <radialGradient id={id('glyph-sphere')} cx="36%" cy="30%" r="72%">
              <stop offset="0" stopColor="#fff3d4" />
              <stop offset="0.22" stopColor="#ffc766" />
              <stop offset="0.5" stopColor="#fc9d19" />
              <stop offset="0.74" stopColor="#7a4b0d" />
              <stop offset="1" stopColor="#fff3d4" />
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
              <feDropShadow dx="0" dy="12" stdDeviation="7.5" floodColor="#000000" floodOpacity="0.7" />
              <feDropShadow dx="0" dy="0" stdDeviation="2.2" floodColor="#ffffff" floodOpacity="0.18" />
            </filter>

            <filter id={id('piece-active-shadow')} x="-24%" y="-24%" width="148%" height="158%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="18" stdDeviation="11" floodColor="#000000" floodOpacity="0.82" />
              <feDropShadow dx="0" dy="0" stdDeviation="5.5" floodColor="#e7ecec" floodOpacity="0.32" />
              <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#ffb84d" floodOpacity="0.22" />
            </filter>

            <filter id={id('piece-engaged-shadow')} x="-24%" y="-24%" width="148%" height="158%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="14" stdDeviation="8.5" floodColor="#000000" floodOpacity="0.75" />
              <feDropShadow dx="0" dy="0" stdDeviation="4.5" floodColor="#ffb84d" floodOpacity="0.28" />
            </filter>

            <filter id={id('edge-glow')} x="-12%" y="-12%" width="124%" height="124%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id={id('amber-soft')} x="-180%" y="-180%" width="460%" height="460%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.45" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id={id('groove-shadow')} x="-250%" y="-12%" width="600%" height="124%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="-1.2" dy="0" stdDeviation="1" floodColor="#ffffff" floodOpacity="0.3" />
              <feDropShadow dx="1.6" dy="0" stdDeviation="1.2" floodColor="#000000" floodOpacity="0.95" />
              <feDropShadow dx="0" dy="2.5" stdDeviation="1.5" floodColor="#000000" floodOpacity="0.65" />
              {/* Inner glowing core for the groove */}
              <feDropShadow dx="0" dy="0" stdDeviation="2" floodColor="#ffb84d" floodOpacity="0.15" />
            </filter>

            <filter id={id('glyph-soft')} x="-80%" y="-800%" width="260%" height="1700%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.35" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id={id('sparkle-blur')} x="-40%" y="-40%" width="180%" height="180%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="0.85" />
            </filter>

            <linearGradient id={id('vertical-shaft')} x1="180" y1="0" x2="180" y2="420" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffeaad" stopOpacity="0" />
              <stop offset="0.18" stopColor="#ffc766" stopOpacity="0.18" />
              <stop offset="0.5" stopColor="#ffb84d" stopOpacity="0.32" />
              <stop offset="0.82" stopColor="#ffc766" stopOpacity="0.14" />
              <stop offset="1" stopColor="#ffeaad" stopOpacity="0" />
            </linearGradient>

            <linearGradient id={id('ground-line')} x1="20" y1="380" x2="340" y2="380" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="0.35" stopColor="#ffc766" stopOpacity="0.35" />
              <stop offset="0.5" stopColor="#fff3d4" stopOpacity="0.65" />
              <stop offset="0.65" stopColor="#ffc766" stopOpacity="0.35" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Background Technical Grid / Reticle Layers */}
          <g aria-hidden pointerEvents="none" className="mix-blend-screen">
            <motion.circle
              cx="180"
              cy="210"
              r="205"
              fill="none"
              stroke="#ffffff"
              strokeWidth="0.5"
              strokeDasharray="2 18"
              opacity="0.04"
              animate={prefersReducedMotion ? {} : { rotate: 360 }}
              transition={rotationTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />
            <motion.circle
              cx="180"
              cy="210"
              r="196"
              fill={fill('background-luminance')}
              animate={prefersReducedMotion ? { opacity: 0.9 } : { opacity: [0.75, 1, 0.75], scale: [0.98, 1.02, 0.98] }}
              transition={atmosphericTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />
            <motion.circle
              cx="180"
              cy="210"
              r="184"
              fill={fill('background-amber-air')}
              animate={prefersReducedMotion ? { opacity: 0.72 } : { opacity: [0.42, 0.82, 0.42], scale: [0.97, 1.03, 0.97] }}
              transition={atmosphericTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />
            <circle cx="180" cy="210" r="176" fill={fill('background-grain')} opacity="0.18" />
            <motion.circle
              cx="180"
              cy="210"
              r="165"
              fill="none"
              stroke="#ffb84d"
              strokeWidth="0.5"
              strokeDasharray="1 8"
              opacity="0.05"
              animate={prefersReducedMotion ? {} : { rotate: -360 }}
              transition={counterRotationTransition}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />

            {/* Deep-field constellation pinpricks for parallax depth */}
            {CONSTELLATION_DOTS.map((star, idx) => (
              <motion.circle
                key={`star-${idx}`}
                cx={star.cx}
                cy={star.cy}
                r={star.r}
                fill="#fff8e6"
                animate={
                  prefersReducedMotion
                    ? { opacity: star.opacity }
                    : { opacity: [star.opacity * 0.45, star.opacity, star.opacity * 0.45] }
                }
                transition={{
                  duration: 4 + (idx % 4),
                  delay: idx * 0.27,
                  ease: SOFT_EASE,
                  repeat: Infinity,
                  repeatType: 'mirror',
                }}
              />
            ))}

            {/* HUD-style corner reticle marks */}
            {CORNER_RETICLES.map((mark, idx) => (
              <g
                key={`reticle-${idx}`}
                transform={`translate(${mark.x} ${mark.y}) scale(${mark.scaleX} ${mark.scaleY})`}
              >
                <path
                  d="M0 14 L0 0 L14 0"
                  fill="none"
                  stroke="#ffc766"
                  strokeOpacity="0.32"
                  strokeWidth="0.8"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx="0" cy="0" r="0.9" fill="#ffc766" fillOpacity="0.45" />
              </g>
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
                    ? { opacity: 0.1 }
                    : { opacity: [0, 0.34, 0], y: [-2, -46], x: [0, mote.sway, 0] }
                }
                transition={{
                  duration: mote.duration,
                  delay: mote.delay,
                  repeat: Infinity,
                  ease: 'easeOut',
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
            strokeWidth="0.75"
            strokeLinecap="round"
            fill="none"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
            animate={
              prefersReducedMotion
                ? { opacity: activeLayer ? 0.85 : 0.5 }
                : { opacity: activeLayer ? [0.55, 0.95, 0.55] : [0.32, 0.58, 0.32] }
            }
            transition={atmosphericTransition}
          />

          {/* Vertical luminance shaft revealed when a layer is engaged — anchors the active focus */}
          <motion.rect
            x="172"
            y="0"
            width="16"
            height="420"
            fill={fill('vertical-shaft')}
            pointerEvents="none"
            initial={false}
            animate={{ opacity: activeLayer ? 0.55 : 0 }}
            transition={layerTransition}
            style={{ mixBlendMode: 'screen' }}
          />

          {/* Dynamic Glow Ray behind pyramid based on active state */}
          <motion.path
            d={`M${PYRAMID_CENTER_X} 25 L345 400 L15 400 Z`}
            fill="url(#active-sheen)"
            pointerEvents="none"
            initial={false}
            animate={{ opacity: activeLayer ? 0.4 : 0 }}
            transition={layerTransition}
          />

          {layers.map((layer) => {
            const isActive = activeLayer === layer.key;
            const isEngaged = engagedLayer === layer.key;
            
            // Greyscale/Dim effect for inactive layers when something is active
            const isMuted = activeLayer !== null && !isActive;

            const layerMotion = LAYER_MOTION[state][layer.key];
            const targetY = layerMotion.y;
            const targetScale = layerMotion.scale + (isEngaged && !isActive ? 0.006 : 0);
            const targetOpacity = isEngaged && !isActive ? Math.min(layerMotion.opacity + 0.12, 1) : layerMotion.opacity;
            const channelPath = linePath(layer.channel.start, layer.channel.end);
            const channelHighlightPath = linePath(
              offsetPoint(layer.channel.start, -2.05),
              offsetPoint(layer.channel.end, -2.05),
            );
            const channelShadowPath = linePath(
              offsetPoint(layer.channel.start, 2.05),
              offsetPoint(layer.channel.end, 2.05),
            );

            return (
              <motion.g
                key={layer.key}
                role="button"
                tabIndex={0}
                aria-label={layer.ariaLabel}
                aria-pressed={isActive}
                className="cursor-pointer outline-none [&:focus-visible_.focus-ring]:opacity-100"
                initial={false}
                animate={{
                  y: targetY,
                  opacity: targetOpacity,
                  scale: targetScale,
                  filter: isMuted ? 'saturate(0.55) brightness(0.78)' : 'saturate(1) brightness(1)'
                }}
                whileHover={
                  prefersReducedMotion
                    ? undefined
                    : {
                        y: targetY - 2.8,
                        scale: targetScale + 0.005,
                      }
                }
                whileTap={
                  prefersReducedMotion
                    ? undefined
                    : {
                        y: targetY + 1.8,
                        scale: Math.max(targetScale - 0.01, 0.975),
                      }
                }
                transition={
                  prefersReducedMotion
                    ? reducedTransition
                    : { ...layerTransition, filter: { duration: 0.55, ease: CALM_EASE } }
                }
                style={{
                  transformBox: 'fill-box',
                  transformOrigin: 'center',
                  WebkitTapHighlightColor: 'transparent',
                  touchAction: 'manipulation',
                  willChange: activeLayer !== null || isEngaged ? 'transform, opacity, filter' : 'auto',
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType !== 'mouse') return;
                  setHoveredLayer(layer.key);
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType !== 'mouse') return;
                  setHoveredLayer((current) => (current === layer.key ? null : current));
                }}
                onFocus={() => setFocusedLayer(layer.key)}
                onBlur={() => setFocusedLayer((current) => (current === layer.key ? null : current))}
                onClick={(event) => {
                  event.stopPropagation();
                  handleLayerActivate(layer.key);
                }}
                onKeyDown={(event) => handleLayerKeyDown(event, layer.key)}
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
                        ? { opacity: isActive ? 0.25 : isEngaged ? 0.14 : 0.05 }
                        : {
                            opacity: isActive
                              ? [0.15, 0.32, 0.15]
                              : isEngaged
                                ? [0.08, 0.18, 0.08]
                                : [0.03, 0.065, 0.03],
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
                  strokeOpacity="0.88"
                  strokeWidth="8"
                  strokeLinecap="round"
                  filter={fill('groove-shadow')}
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <path
                  d={channelPath}
                  fill="none"
                  stroke={fill('groove-core')}
                  strokeWidth="4.6"
                  strokeLinecap="round"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <motion.path
                  d={channelPath}
                  fill="none"
                  stroke={fill('groove-amber')}
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                  initial={false}
                  animate={
                    prefersReducedMotion
                      ? { opacity: isActive ? 0.45 : 0 }
                      : { opacity: isActive ? [0.25, 0.55, 0.25] : isEngaged ? [0.12, 0.3, 0.12] : 0 }
                  }
                  transition={pulseTransition}
                />

                <path
                  d={channelHighlightPath}
                  fill="none"
                  stroke={fill('groove-highlight')}
                  strokeWidth="0.9"
                  strokeLinecap="round"
                  opacity={isActive ? 0.82 : isEngaged ? 0.7 : 0.6}
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <path
                  d={channelShadowPath}
                  fill="none"
                  stroke="#000000"
                  strokeOpacity="0.8"
                  strokeWidth="1.05"
                  strokeLinecap="round"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <path
                  d={layer.hitPath}
                  fill="none"
                  stroke="#010202"
                  strokeOpacity="0.95"
                  strokeWidth="4.6"
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
                    strokeOpacity: isActive ? layer.rimOpacity + 0.18 : isEngaged ? layer.rimOpacity + 0.15 : layer.rimOpacity,
                    strokeWidth: isEngaged ? 1.6 : 1.35
                  }}
                  transition={{ duration: 0.2 }}
                  strokeLinejoin="miter"
                  filter={fill('edge-glow')}
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />

                <motion.path
                  d={layer.hitPath}
                  fill="none"
                  stroke={fill('active-edge-amber')}
                  strokeWidth="0.9"
                  strokeLinejoin="miter"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                  initial={false}
                  animate={
                    prefersReducedMotion
                      ? { opacity: isActive ? 0.48 : isEngaged ? 0.28 : 0 }
                      : {
                          opacity: isActive
                            ? [0.3, 0.6, 0.3]
                            : isEngaged
                              ? [0.12, 0.3, 0.12]
                              : 0,
                        }
                  }
                  transition={pulseTransition}
                />

                <path
                  d={layer.hitPath}
                  fill="none"
                  stroke={fill('hairline-rim')}
                  strokeOpacity={isActive ? 0.9 : isEngaged ? 0.78 : 0.62}
                  strokeWidth="0.45"
                  strokeLinejoin="miter"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
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

                {/* Active-only corner micro-glints — subtle white sparks at the layer extents */}
                {isActive && layer.key !== 'top' && (
                  <g pointerEvents="none">
                    {[
                      pointOnEdge(PYRAMID_OUTER.leftBase, layer.key === 'heart' ? PYRAMID_Y.heartTop : PYRAMID_Y.baseTop),
                      pointOnEdge(PYRAMID_OUTER.rightBase, layer.key === 'heart' ? PYRAMID_Y.heartTop : PYRAMID_Y.baseTop),
                    ].map((pt, idx) => (
                      <motion.circle
                        key={`glint-${layer.key}-${idx}`}
                        cx={pt[0]}
                        cy={pt[1]}
                        r="1.4"
                        fill="#fff8e6"
                        initial={{ opacity: 0, scale: 0.4 }}
                        animate={
                          prefersReducedMotion
                            ? { opacity: 0.8, scale: 1 }
                            : { opacity: [0.3, 0.95, 0.3], scale: [0.6, 1.1, 0.6] }
                        }
                        transition={{ ...pulseTransition, delay: idx * 0.4 }}
                        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                      />
                    ))}
                  </g>
                )}

                {/* Ambient Apex Sparkle (Top layer only) */}
                {layer.key === 'top' && (
                  <g pointerEvents="none">
                    <motion.path
                      d={`M${PYRAMID_CENTER_X} 14 L${PYRAMID_CENTER_X+3} 24 L${PYRAMID_CENTER_X+13} 27 L${PYRAMID_CENTER_X+3} 30 L${PYRAMID_CENTER_X} 40 L${PYRAMID_CENTER_X-3} 30 L${PYRAMID_CENTER_X-13} 27 L${PYRAMID_CENTER_X-3} 24 Z`}
                      fill="#ffffff"
                      filter={fill('sparkle-blur')}
                      initial={false}
                      animate={prefersReducedMotion ? { opacity: 0.5, scale: 0.6 } : { opacity: [0.2, 0.8, 0.2], scale: [0.4, 0.85, 0.4] }}
                      transition={pulseTransition}
                      style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                    />
                    {/* Crisp pinpoint core layered on top of the diffused sparkle */}
                    <motion.circle
                      cx={PYRAMID_CENTER_X}
                      cy="27"
                      r="1.2"
                      fill="#fff8e6"
                      initial={false}
                      animate={prefersReducedMotion ? { opacity: 0.9 } : { opacity: [0.55, 1, 0.55] }}
                      transition={pulseTransition}
                    />
                    {/* Slowly rotating accent ring — only visible when the top layer is active */}
                    <motion.circle
                      cx={PYRAMID_CENTER_X}
                      cy="27"
                      r="9"
                      fill="none"
                      stroke="#ffc766"
                      strokeWidth="0.5"
                      strokeDasharray="1.6 3.2"
                      vectorEffect="non-scaling-stroke"
                      initial={false}
                      animate={
                        prefersReducedMotion
                          ? { opacity: isActive ? 0.55 : 0, rotate: 0 }
                          : { opacity: isActive ? 0.6 : 0, rotate: 360 }
                      }
                      transition={{
                        opacity: { duration: 0.45, ease: CALM_EASE },
                        rotate: prefersReducedMotion ? reducedTransition : { duration: 18, ease: 'linear', repeat: Infinity },
                      }}
                      style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                    />
                  </g>
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
                  initial={{ opacity: 0, scale: 0.38, y: dot.key === 'upper-gap-dot' ? 3 : -3 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.38, y: dot.key === 'upper-gap-dot' ? -2 : 2 }}
                  transition={prefersReducedMotion ? reducedTransition : { duration: 0.42, ease: CALM_EASE }}
                  style={{
                    transformBox: 'view-box',
                    transformOrigin: `${PYRAMID_CENTER_X}px ${dot.y}px`,
                  }}
                >
                  {/* Cross-hair guides — fine technical sighting lines extending horizontally */}
                  <motion.line
                    x1={PYRAMID_CENTER_X - 22}
                    y1={dot.y}
                    x2={PYRAMID_CENTER_X - 7}
                    y2={dot.y}
                    stroke="#ffc766"
                    strokeOpacity="0.55"
                    strokeWidth="0.5"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    initial={{ opacity: 0, x: 4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 4 }}
                    transition={prefersReducedMotion ? reducedTransition : { duration: 0.5, ease: CALM_EASE }}
                  />
                  <motion.line
                    x1={PYRAMID_CENTER_X + 7}
                    y1={dot.y}
                    x2={PYRAMID_CENTER_X + 22}
                    y2={dot.y}
                    stroke="#ffc766"
                    strokeOpacity="0.55"
                    strokeWidth="0.5"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -4 }}
                    transition={prefersReducedMotion ? reducedTransition : { duration: 0.5, ease: CALM_EASE }}
                  />

                  {/* Expanding Ring Pulse */}
                  <motion.circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="3.5"
                    fill="none"
                    stroke="#fc9d19"
                    strokeWidth="1"
                    initial={{ scale: 1, opacity: 0.8 }}
                    animate={prefersReducedMotion ? {} : { scale: 3.5, opacity: 0 }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut' }}
                  />

                  <motion.circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="11.5"
                    fill={fill('amber-glow')}
                    initial={{ opacity: 0 }}
                    animate={
                      prefersReducedMotion
                        ? { opacity: 0.45, r: 10.5 }
                        : { opacity: [0.28, 0.62, 0.28], r: [9.5, 14.5, 9.5] }
                    }
                    exit={{ opacity: 0 }}
                    transition={pulseTransition}
                  />

                  <motion.circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="2.85"
                    fill={fill('amber-dot')}
                    filter={fill('amber-soft')}
                    animate={
                      prefersReducedMotion
                        ? { opacity: 1, r: 2.85 }
                        : { opacity: [0.85, 1, 0.85], r: [2.75, 3.45, 2.75] }
                    }
                    transition={pulseTransition}
                  />

                  <motion.circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="3.35"
                    fill="none"
                    stroke="#ffc766"
                    strokeOpacity="0.68"
                    strokeWidth="0.45"
                    vectorEffect="non-scaling-stroke"
                    animate={
                      prefersReducedMotion
                        ? { opacity: 0.68, r: 3.35 }
                        : { opacity: [0.42, 0.82, 0.42], r: [3.3, 4.5, 3.3] }
                    }
                    transition={pulseTransition}
                  />
                </motion.g>
              ) : null,
            )}
          </AnimatePresence>

          <g aria-hidden pointerEvents="none" filter={fill('glyph-soft')}>
            <motion.line
              x1="105"
              y1="397"
              x2="164"
              y2="397"
              stroke={fill('glyph-line-left')}
              strokeWidth="0.85"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              animate={prefersReducedMotion ? { opacity: 0.9 } : { opacity: [0.5, 1, 0.5] }}
              transition={pulseTransition}
            />

            <motion.line
              x1="196"
              y1="397"
              x2="255"
              y2="397"
              stroke={fill('glyph-line-right')}
              strokeWidth="0.85"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              animate={prefersReducedMotion ? { opacity: 0.9 } : { opacity: [0.5, 1, 0.5] }}
              transition={pulseTransition}
            />

            <motion.circle
              cx="180"
              cy="397"
              r="9.5"
              fill={fill('amber-glow')}
              animate={prefersReducedMotion ? { opacity: 0.4, r: 9.5 } : { opacity: [0.22, 0.62, 0.22], r: [8.8, 12.8, 8.8] }}
              transition={pulseTransition}
            />

            <motion.circle
              cx="180"
              cy="397"
              r="6.5"
              fill={fill('glyph-sphere')}
              animate={
                prefersReducedMotion
                  ? { opacity: 1, r: 6.5 }
                  : { opacity: [0.78, 1, 0.78], r: [6.3, 7.25, 6.3] }
              }
              transition={pulseTransition}
            />

            <motion.circle
              cx="180"
              cy="397"
              r="6.7"
              fill="none"
              stroke="#ffc766"
              strokeOpacity="0.52"
              strokeWidth="0.45"
              animate={
                prefersReducedMotion
                  ? { opacity: 0.52, r: 6.7 }
                  : { opacity: [0.28, 0.74, 0.28], r: [6.9, 8.9, 6.9] }
              }
              transition={pulseTransition}
            />
          </g>
        </svg>

        {/* Enhanced Hovering Glassmorphic Text UI */}
        <AnimatePresence mode="wait">
          {selectedLayer ? (
            <motion.div
              key={selectedLayer.key}
              initial={{ opacity: 0, y: 16, scale: 0.96, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -12, scale: 0.97, filter: 'blur(4px)' }}
              transition={prefersReducedMotion ? reducedTransition : { duration: 0.45, ease: CALM_EASE }}
              className={`pointer-events-none absolute left-1/2 z-50 w-[90%] max-w-[22.5rem] -translate-x-1/2 overflow-hidden rounded-xl border border-white/10 bg-[#060608]/70 p-5 shadow-[0_12px_40px_-5px_rgba(0,0,0,0.8),inset_0_1px_1px_rgba(255,255,255,0.15),0_0_0_1px_rgba(252,157,25,0.08)] backdrop-blur-xl ${selectedLayer.revealClass}`}
            >
              {/* Inner hairline ring — second border for a true double-ring frame */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-[3px] rounded-lg border border-white/[0.05]"
              />

              {/* One-shot diagonal shimmer sweep across the card on reveal */}
              {!prefersReducedMotion && (
                <motion.span
                  aria-hidden
                  initial={{ x: '-130%', opacity: 0 }}
                  animate={{ x: '130%', opacity: [0, 0.7, 0] }}
                  transition={{ duration: 1.6, delay: 0.18, ease: CALM_EASE }}
                  className="pointer-events-none absolute inset-y-0 left-0 w-1/2 -skew-x-[18deg] bg-gradient-to-r from-transparent via-white/[0.09] to-transparent"
                />
              )}

              {/* Chevron pointer — directs the eye from the card toward the active layer */}
              <motion.span
                aria-hidden
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={prefersReducedMotion ? reducedTransition : { duration: 0.35, ease: CALM_EASE, delay: 0.08 }}
                className={`pointer-events-none absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-[#fc9d19]/40 bg-[#060608]/80 backdrop-blur-xl ${
                  selectedLayer.key === 'top'
                    ? '-bottom-[5px] border-b border-r'
                    : '-top-[5px] border-l border-t'
                }`}
              />

              <motion.div
                animate={prefersReducedMotion ? {} : { y: [0, -4, 0] }}
                transition={floatTransition}
                className="relative flex flex-col items-center justify-center space-y-3.5 text-center"
              >
                {/* Backlight / Drop Shadow with subtle amber wash for warmth */}
                <motion.span
                  aria-hidden
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={prefersReducedMotion ? reducedTransition : { duration: 0.4, ease: CALM_EASE }}
                  className="absolute left-1/2 top-1/2 -z-10 h-36 w-[130%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.95),rgba(20,12,2,0.55)_38%,rgba(252,157,25,0.05)_62%,transparent_75%)] blur-[5px]"
                />

                <motion.div
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={prefersReducedMotion ? reducedTransition : { duration: 0.4, delay: 0.05, ease: CALM_EASE }}
                  className="flex w-full flex-col items-center justify-center space-y-2"
                >
                  <span className="text-[9px] font-bold uppercase tracking-[0.4em] text-white/40">
                    Scent Profile Analysis
                  </span>

                  <span className="block h-px w-40 origin-center bg-gradient-to-r from-transparent via-[#fc9d19]/60 to-transparent" />

                  {/* Luxury Gold Gradient Text */}
                  <h3 className="bg-gradient-to-br from-[#fff3d4] via-[#fc9d19] to-[#8c5a1a] bg-clip-text text-[12px] font-bold uppercase tracking-[0.5em] text-transparent drop-shadow-[0_2px_12px_rgba(252,157,25,0.45)]">
                    {selectedLayer.title}
                  </h3>

                  {/* Animated title underline accent — draws in beneath the heading */}
                  <motion.span
                    aria-hidden
                    initial={{ scaleX: 0, opacity: 0 }}
                    animate={{ scaleX: 1, opacity: 1 }}
                    exit={{ scaleX: 0, opacity: 0 }}
                    transition={
                      prefersReducedMotion
                        ? reducedTransition
                        : { duration: 0.55, delay: 0.18, ease: WEIGHTED_EASE }
                    }
                    className="block h-[1.5px] w-16 origin-center rounded-full bg-gradient-to-r from-transparent via-[#ffc766] to-transparent shadow-[0_0_8px_rgba(252,157,25,0.55)]"
                  />
                </motion.div>

                <motion.p
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={prefersReducedMotion ? reducedTransition : { duration: 0.48, delay: 0.12, ease: CALM_EASE }}
                  className="font-serif text-[1.1rem] italic tracking-wide text-white/95 leading-relaxed [text-shadow:0_3px_20px_rgba(0,0,0,1),0_0_30px_rgba(252,157,25,0.2)] sm:text-[1.15rem]"
                >
                  {formatNotes(selectedLayer.notes)}
                </motion.p>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </section>
  );
};