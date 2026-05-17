import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

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

const layerMotion: Record<ActiveLayer | 'idle', Record<ActiveLayer, number>> = {
  idle: { top: 0, heart: 0, base: 0 },
  top: { top: -9, heart: 3, base: 5 },
  heart: { top: -4, heart: -2, base: 6 },
  base: { top: -3, heart: -6, base: 2 },
};

const transition = {
  duration: 0.48,
  ease: [0.22, 1, 0.36, 1],
} as const;

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

const GAP_DOT_Y = {
  upper: (PYRAMID_Y.topBottom + PYRAMID_Y.heartTop) / 2,
  lower: (PYRAMID_Y.heartBottom + PYRAMID_Y.baseTop) / 2,
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
  return notes.length > 0 ? notes.join(', ') : 'No notes detected.';
}

function offsetPoint([x, y]: Point, dx: number): Point {
  return [x + dx, y];
}

export const NotePyramid: React.FC<NotePyramidProps> = ({
  topNotes,
  heartNotes,
  baseNotes,
  className = '',
}) => {
  const [activeLayer, setActiveLayer] = React.useState<ActiveLayer | null>(null);
  const rootRef = React.useRef<HTMLElement | null>(null);
  const ignoreNextClickRef = React.useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const idPrefix = React.useId().replace(/:/g, '');
  const state = activeLayer ?? 'idle';
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

  const layers: LayerConfig[] = [
    {
      key: 'base',
      title: 'Base Notes',
      ariaLabel: 'Reveal base notes',
      ...layerGeometry.base,
      faceFills: [fill('base-left'), fill('base-right')],
      polishFill: fill('base-polish'),
      grainFill: fill('grain-deep'),
      revealClass: 'top-[70%]',
      grainOpacity: 0.3,
      polishOpacity: 0.66,
      rimOpacity: 0.66,
      notes: baseNotes,
    },
    {
      key: 'heart',
      title: 'Heart Notes',
      ariaLabel: 'Reveal heart notes',
      ...layerGeometry.heart,
      faceFills: [fill('heart-left'), fill('heart-right')],
      polishFill: fill('heart-polish'),
      grainFill: fill('grain-satin'),
      revealClass: 'top-[49%]',
      grainOpacity: 0.24,
      polishOpacity: 0.62,
      rimOpacity: 0.76,
      notes: heartNotes,
    },
    {
      key: 'top',
      title: 'Top Notes',
      ariaLabel: 'Reveal top notes',
      ...layerGeometry.top,
      faceFills: [fill('top-left'), fill('top-right')],
      polishFill: fill('top-polish'),
      grainFill: fill('grain-platinum'),
      revealClass: 'top-[23%]',
      grainOpacity: 0.2,
      polishOpacity: 0.72,
      rimOpacity: 0.88,
      notes: topNotes,
    },
  ];

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

  const gapDots = [
    {
      key: 'upper-gap-dot',
      y: GAP_DOT_Y.upper,
      isVisible: activeLayer === 'top' || activeLayer === 'heart',
    },
    {
      key: 'lower-gap-dot',
      y: GAP_DOT_Y.lower,
      isVisible: activeLayer === 'base' || activeLayer === 'heart',
    },
  ];

  const pulseTransition = prefersReducedMotion
  ? ({ duration: 0.01 } as const)
  : ({
      duration: 2.6,
      ease: [0.42, 0, 0.58, 1],
      repeat: Infinity,
      repeatType: 'mirror',
    } as const);

  return (
    <section
      ref={rootRef}
      className={`flex h-full min-h-0 flex-col items-center justify-center px-3 py-5 sm:px-5 ${className}`}
      onClick={() => setActiveLayer(null)}
    >
      <div
        className="relative w-full max-w-[23rem] aspect-[1/1.08] shrink-0 overflow-visible sm:max-w-[25rem]"
        onClick={(event) => event.stopPropagation()}
      >
        <svg
          viewBox="0 0 360 420"
          className="h-full w-full overflow-visible"
          role="img"
          aria-label="Interactive fragrance note pyramid"
        >
          <defs>
            <radialGradient id={id('background-luminance')} cx="50%" cy="49%" r="58%">
              <stop offset="0" stopColor="#303336" stopOpacity="0.18" />
              <stop offset="0.38" stopColor="#181a1c" stopOpacity="0.22" />
              <stop offset="1" stopColor="#050607" stopOpacity="0" />
            </radialGradient>
            <pattern id={id('background-grain')} width="7" height="7" patternUnits="userSpaceOnUse">
              <path d="M0 1 H7 M1 5 H7" stroke="#ffffff" strokeOpacity="0.035" strokeWidth="0.45" />
            </pattern>

            <linearGradient id={id('top-left')} x1="129" y1="83" x2="181" y2="83" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#aeb1b0" />
              <stop offset="0.12" stopColor="#f4f4ef" />
              <stop offset="0.44" stopColor="#e4e5e2" />
              <stop offset="0.78" stopColor="#fbfbf6" />
              <stop offset="1" stopColor="#cbccc8" />
            </linearGradient>
            <linearGradient id={id('top-right')} x1="180" y1="83" x2="231" y2="83" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fcfcf7" />
              <stop offset="0.26" stopColor="#e4e5e1" />
              <stop offset="0.68" stopColor="#d5d6d2" />
              <stop offset="1" stopColor="#a5a8a8" />
            </linearGradient>
            <radialGradient id={id('top-polish')} cx="50%" cy="25%" r="82%">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.64" />
              <stop offset="0.38" stopColor="#ffffff" stopOpacity="0.22" />
              <stop offset="0.7" stopColor="#a9abad" stopOpacity="0.1" />
              <stop offset="1" stopColor="#050607" stopOpacity="0.2" />
            </radialGradient>

            <linearGradient id={id('heart-left')} x1="75" y1="200" x2="180" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#424648" />
              <stop offset="0.2" stopColor="#6e7171" />
              <stop offset="0.58" stopColor="#8f9290" />
              <stop offset="0.82" stopColor="#c2c2bd" />
              <stop offset="1" stopColor="#ddddda" />
            </linearGradient>
            <linearGradient id={id('heart-right')} x1="180" y1="200" x2="285" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ddddda" />
              <stop offset="0.22" stopColor="#b8bab6" />
              <stop offset="0.58" stopColor="#676a69" />
              <stop offset="1" stopColor="#252829" />
            </linearGradient>
            <linearGradient id={id('heart-polish')} x1="72" y1="200" x2="288" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#000000" stopOpacity="0.26" />
              <stop offset="0.28" stopColor="#ffffff" stopOpacity="0.07" />
              <stop offset="0.49" stopColor="#ffffff" stopOpacity="0.48" />
              <stop offset="0.58" stopColor="#ffffff" stopOpacity="0.16" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.34" />
            </linearGradient>

            <linearGradient id={id('base-left')} x1="21" y1="319" x2="180" y2="319" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#0b0d0e" />
              <stop offset="0.24" stopColor="#191c1e" />
              <stop offset="0.58" stopColor="#2b2f31" />
              <stop offset="0.84" stopColor="#4b4d4b" />
              <stop offset="1" stopColor="#696a66" />
            </linearGradient>
            <linearGradient id={id('base-right')} x1="180" y1="319" x2="339" y2="319" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#666762" />
              <stop offset="0.25" stopColor="#424648" />
              <stop offset="0.62" stopColor="#202326" />
              <stop offset="1" stopColor="#08090a" />
            </linearGradient>
            <linearGradient id={id('base-polish')} x1="23" y1="320" x2="337" y2="320" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#000000" stopOpacity="0.32" />
              <stop offset="0.35" stopColor="#ffffff" stopOpacity="0.04" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.36" />
              <stop offset="0.62" stopColor="#ffffff" stopOpacity="0.1" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.42" />
            </linearGradient>

            <linearGradient id={id('vertical-falloff')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.18" />
              <stop offset="0.36" stopColor="#ffffff" stopOpacity="0.05" />
              <stop offset="0.78" stopColor="#000000" stopOpacity="0.2" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.4" />
            </linearGradient>
            <linearGradient id={id('outer-rim')} x1="28" y1="37" x2="332" y2="360" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.86" />
              <stop offset="0.18" stopColor="#e8e9e7" stopOpacity="0.74" />
              <stop offset="0.48" stopColor="#ffffff" stopOpacity="0.96" />
              <stop offset="0.72" stopColor="#aeb2b3" stopOpacity="0.58" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0.76" />
            </linearGradient>
            <linearGradient id={id('hairline-rim')} x1="21" y1="372" x2="339" y2="25" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#aeb1b1" stopOpacity="0.34" />
              <stop offset="0.44" stopColor="#ffffff" stopOpacity="0.82" />
              <stop offset="0.56" stopColor="#ffffff" stopOpacity="0.5" />
              <stop offset="1" stopColor="#c8cbcb" stopOpacity="0.42" />
            </linearGradient>
            <linearGradient id={id('groove-core')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#0c0e10" />
              <stop offset="0.45" stopColor="#282b2d" />
              <stop offset="0.58" stopColor="#0c0d0f" />
              <stop offset="1" stopColor="#060708" />
            </linearGradient>
            <linearGradient id={id('groove-highlight')} x1="180" y1="25" x2="180" y2="372" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.62" />
              <stop offset="0.42" stopColor="#ffffff" stopOpacity="0.34" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0.15" />
            </linearGradient>

            <radialGradient id={id('amber-dot')} cx="36%" cy="30%" r="74%">
              <stop offset="0" stopColor="#fff0c8" />
              <stop offset="0.24" stopColor="#f0c36f" />
              <stop offset="0.55" stopColor="#d1953e" />
              <stop offset="0.8" stopColor="#7c4f18" />
              <stop offset="1" stopColor="#251306" />
            </radialGradient>
            <radialGradient id={id('amber-glow')} cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#e4ad55" stopOpacity="0.52" />
              <stop offset="0.44" stopColor="#d1953e" stopOpacity="0.18" />
              <stop offset="1" stopColor="#d1953e" stopOpacity="0" />
            </radialGradient>

            <linearGradient id={id('glyph-line-left')} x1="106" y1="397" x2="164" y2="397" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#d1953e" stopOpacity="0" />
              <stop offset="0.62" stopColor="#d1953e" stopOpacity="0.46" />
              <stop offset="1" stopColor="#f0c36f" stopOpacity="0.82" />
            </linearGradient>
            <linearGradient id={id('glyph-line-right')} x1="196" y1="397" x2="254" y2="397" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#f0c36f" stopOpacity="0.82" />
              <stop offset="0.38" stopColor="#d1953e" stopOpacity="0.46" />
              <stop offset="1" stopColor="#d1953e" stopOpacity="0" />
            </linearGradient>
            <radialGradient id={id('glyph-sphere')} cx="36%" cy="30%" r="72%">
              <stop offset="0" stopColor="#fff0c8" />
              <stop offset="0.22" stopColor="#f0c36f" />
              <stop offset="0.5" stopColor="#d1953e" />
              <stop offset="0.74" stopColor="#7c4f18" />
              <stop offset="1" stopColor="#fff0c8" />
            </radialGradient>

            <pattern id={id('grain-platinum')} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-13)">
              <path d="M0 1 H7 M0 4 H7" stroke="#384044" strokeOpacity="0.18" strokeWidth="0.35" />
              <path d="M1 6 H6" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="0.25" />
            </pattern>
            <pattern id={id('grain-satin')} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)">
              <path d="M0 1 H7 M0 3.5 H7 M0 6 H7" stroke="#111416" strokeOpacity="0.22" strokeWidth="0.4" />
              <path d="M1 2 H7" stroke="#ffffff" strokeOpacity="0.12" strokeWidth="0.22" />
            </pattern>
            <pattern id={id('grain-deep')} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-17)">
              <path d="M0 1 H6 M0 3 H6 M0 5 H6" stroke="#ffffff" strokeOpacity="0.11" strokeWidth="0.32" />
              <path d="M1 2 H6 M0 4 H5" stroke="#000000" strokeOpacity="0.28" strokeWidth="0.32" />
            </pattern>

            <filter id={id('piece-shadow')} x="-18%" y="-18%" width="136%" height="146%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="8" stdDeviation="5.5" floodColor="#000000" floodOpacity="0.56" />
              <feDropShadow dx="0" dy="0" stdDeviation="1.5" floodColor="#ffffff" floodOpacity="0.12" />
            </filter>
            <filter id={id('piece-active-shadow')} x="-20%" y="-20%" width="140%" height="150%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="10" stdDeviation="6.5" floodColor="#000000" floodOpacity="0.62" />
              <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#e7ecec" floodOpacity="0.18" />
            </filter>
            <filter id={id('edge-glow')} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.05" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id={id('amber-soft')} x="-180%" y="-180%" width="460%" height="460%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.25" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id={id('groove-shadow')} x="-250%" y="-12%" width="600%" height="124%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="-1" dy="0" stdDeviation="0.8" floodColor="#ffffff" floodOpacity="0.22" />
              <feDropShadow dx="1.4" dy="0" stdDeviation="0.9" floodColor="#000000" floodOpacity="0.82" />
              <feDropShadow dx="0" dy="2" stdDeviation="1.1" floodColor="#000000" floodOpacity="0.56" />
            </filter>
            <filter id={id('glyph-soft')} x="-80%" y="-800%" width="260%" height="1700%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.15" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect x="-12" y="-8" width="384" height="438" fill="#050607" />
          <rect x="-12" y="-8" width="384" height="438" fill={fill('background-luminance')} />
          <rect x="-12" y="-8" width="384" height="438" fill={fill('background-grain')} opacity="0.38" />

          {layers.map((layer) => {
            const isActive = activeLayer === layer.key;
            const isMuted = Boolean(activeLayer && !isActive);
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
                className="cursor-pointer outline-none"
                initial={false}
                animate={{
                  y: layerMotion[state][layer.key],
                  opacity: isMuted ? 0.63 : 1,
                  scale: 1,
                }}
                whileHover={
                  prefersReducedMotion
                    ? undefined
                    : {
                        y: layerMotion[state][layer.key] - 1.8,
                      }
                }
                transition={prefersReducedMotion ? { duration: 0.01 } : transition}
                style={{
                  transformBox: 'fill-box',
                  transformOrigin: 'center',
                  WebkitTapHighlightColor: 'transparent',
                  touchAction: 'manipulation',
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (ignoreNextClickRef.current) {
                    ignoreNextClickRef.current = false;
                    return;
                  }
                  handleLayerActivate(layer.key);
                }}
                onPointerUp={(event) => {
                  if (event.pointerType === 'mouse') return;
                  event.stopPropagation();
                  ignoreNextClickRef.current = true;
                  handleLayerActivate(layer.key);
                }}
                onKeyDown={(event) => handleLayerKeyDown(event, layer.key)}
              >
                <path d={layer.hitPath} fill="transparent" />
                <g filter={isActive ? fill('piece-active-shadow') : fill('piece-shadow')}>
                  {layer.faces.map((facePath, faceIndex) => (
                    <path key={`${layer.key}-${faceIndex}`} d={facePath} fill={layer.faceFills[faceIndex]} />
                  ))}
                  <path d={layer.hitPath} fill={fill('vertical-falloff')} opacity="0.56" />
                  <path
                    d={layer.hitPath}
                    fill={layer.polishFill}
                    opacity={isActive ? layer.polishOpacity + 0.08 : layer.polishOpacity}
                  />
                  <path d={layer.hitPath} fill={layer.grainFill} opacity={layer.grainOpacity} />
                </g>

                <path
                  d={channelPath}
                  fill="none"
                  stroke="#020303"
                  strokeOpacity="0.82"
                  strokeWidth="8"
                  strokeLinecap="round"
                  filter={fill('groove-shadow')}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={channelPath}
                  fill="none"
                  stroke={fill('groove-core')}
                  strokeWidth="4.6"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={channelHighlightPath}
                  fill="none"
                  stroke={fill('groove-highlight')}
                  strokeWidth="0.9"
                  strokeLinecap="round"
                  opacity={isActive ? 0.7 : 0.52}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={channelShadowPath}
                  fill="none"
                  stroke="#000000"
                  strokeOpacity="0.7"
                  strokeWidth="1.05"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />

                <path
                  d={layer.hitPath}
                  fill="none"
                  stroke="#020303"
                  strokeOpacity="0.9"
                  strokeWidth="4.6"
                  strokeLinejoin="miter"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={layer.hitPath}
                  fill="none"
                  stroke={fill('outer-rim')}
                  strokeOpacity={isActive ? layer.rimOpacity + 0.12 : layer.rimOpacity}
                  strokeWidth="1.35"
                  strokeLinejoin="miter"
                  filter={fill('edge-glow')}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={layer.hitPath}
                  fill="none"
                  stroke={fill('hairline-rim')}
                  strokeOpacity={isActive ? 0.78 : 0.54}
                  strokeWidth="0.45"
                  strokeLinejoin="miter"
                  vectorEffect="non-scaling-stroke"
                />
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
                  initial={{ opacity: 0, scale: 0.58 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.58 }}
                  transition={prefersReducedMotion ? { duration: 0.01 } : { duration: 0.22, ease: 'easeOut' }}
                  style={{
                    transformBox: 'view-box',
                    transformOrigin: `${PYRAMID_CENTER_X}px ${dot.y}px`,
                  }}
                >
                  <circle cx={PYRAMID_CENTER_X} cy={dot.y} r="8.5" fill={fill('amber-glow')} opacity="0.52" />
                  <circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="2.75"
                    fill={fill('amber-dot')}
                    filter={fill('amber-soft')}
                  />
                  <circle
                    cx={PYRAMID_CENTER_X}
                    cy={dot.y}
                    r="3.15"
                    fill="none"
                    stroke="#f0c36f"
                    strokeOpacity="0.52"
                    strokeWidth="0.45"
                    vectorEffect="non-scaling-stroke"
                  />
                </motion.g>
              ) : null,
            )}
          </AnimatePresence>

          <g aria-hidden pointerEvents="none" filter={fill('glyph-soft')}>
            <line
              x1="105"
              y1="397"
              x2="164"
              y2="397"
              stroke={fill('glyph-line-left')}
              strokeWidth="0.85"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1="196"
              y1="397"
              x2="255"
              y2="397"
              stroke={fill('glyph-line-right')}
              strokeWidth="0.85"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <motion.circle
              cx="180"
              cy="397"
              r="9.5"
              fill={fill('amber-glow')}
              animate={prefersReducedMotion ? { opacity: 0.32 } : { opacity: [0.18, 0.48, 0.18] }}
              transition={pulseTransition}
            />
            <motion.circle
              cx="180"
              cy="397"
              r="6.5"
              fill={fill('glyph-sphere')}
              animate={
                prefersReducedMotion
                  ? { opacity: 0.92, r: 6.5 }
                  : { opacity: [0.68, 1, 0.68], r: [5.9, 6.85, 5.9] }
              }
              transition={pulseTransition}
            />
            <motion.circle
              cx="180"
              cy="397"
              r="6.7"
              fill="none"
              stroke="#f0c36f"
              strokeOpacity="0.42"
              strokeWidth="0.45"
              animate={
                prefersReducedMotion
                  ? { opacity: 0.42, r: 6.7 }
                  : { opacity: [0.22, 0.58, 0.22], r: [6.7, 8.2, 6.7] }
              }
              transition={pulseTransition}
            />
          </g>
        </svg>

        <AnimatePresence mode="wait">
          {selectedLayer ? (
            <motion.div
              key={selectedLayer.key}
              initial={{ opacity: 0, y: 8, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.985 }}
              transition={prefersReducedMotion ? { duration: 0.01 } : { duration: 0.24, ease: 'easeOut' }}
              className={`absolute left-1/2 z-50 w-[76%] max-w-[19rem] -translate-x-1/2 ${selectedLayer.revealClass}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="relative px-3.5 py-2.5 text-center">
                <span
                  className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#d1953e]/55 to-transparent"
                  aria-hidden
                />
                <p className="text-[8px] font-bold uppercase tracking-[0.32em] text-[#d1953e]/72">
                  {selectedLayer.title}
                </p>
                <p className="mx-auto mt-1.5 max-w-[17rem] font-serif text-sm italic leading-snug text-white/84 [text-shadow:0_2px_10px_rgba(0,0,0,0.75)] sm:text-[0.93rem]">
                  {formatNotes(selectedLayer.notes)}
                </p>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
};