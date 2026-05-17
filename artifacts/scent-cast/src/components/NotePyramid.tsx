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
  channelPath: string;
  seamClass: string;
  grainOpacity: number;
  notes: string[];
};

const layerMotion: Record<ActiveLayer | 'idle', Record<ActiveLayer, number>> = {
  idle: { top: 0, heart: 0, base: 0 },
  top: { top: -14, heart: 0, base: 0 },
  heart: { top: -7, heart: -2, base: 12 },
  base: { top: -5, heart: -10, base: 6 },
};

const transition = {
  duration: 0.42,
  ease: [0.22, 1, 0.36, 1],
} as const;

const PYRAMID_CENTER_X = 180;
const PYRAMID_OUTER = {
  apex: [PYRAMID_CENTER_X, 26] as Point,
  leftBase: [20, 376] as Point,
  rightBase: [340, 376] as Point,
};

const PYRAMID_Y = {
  topBottom: 137,
  heartTop: 142,
  heartBottom: 255,
  baseTop: 260,
  baseBottom: 376,
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
    channelPath: linePath([PYRAMID_CENTER_X, PYRAMID_Y.baseTop + 4], [PYRAMID_CENTER_X, PYRAMID_Y.baseBottom - 4]),
  },
  heart: {
    hitPath: tierHitPath(PYRAMID_Y.heartTop, PYRAMID_Y.heartBottom),
    faces: tierFaces(PYRAMID_Y.heartTop, PYRAMID_Y.heartBottom),
    channelPath: linePath([PYRAMID_CENTER_X, PYRAMID_Y.heartTop + 4], [PYRAMID_CENTER_X, PYRAMID_Y.heartBottom - 4]),
  },
  top: {
    hitPath: polygonPath([
      PYRAMID_OUTER.apex,
      pointOnEdge(PYRAMID_OUTER.rightBase, PYRAMID_Y.topBottom),
      pointOnEdge(PYRAMID_OUTER.leftBase, PYRAMID_Y.topBottom),
    ]),
    faces: apexFaces(PYRAMID_Y.topBottom),
    channelPath: linePath([PYRAMID_CENTER_X, PYRAMID_OUTER.apex[1] + 7], [PYRAMID_CENTER_X, PYRAMID_Y.topBottom - 4]),
  },
} satisfies Record<ActiveLayer, Pick<LayerConfig, 'hitPath' | 'faces' | 'channelPath'>>;

function formatNotes(notes: string[]) {
  return notes.length > 0 ? notes.join(', ') : 'No notes detected.';
}

function MagneticTether({
  y,
  active,
}: {
  y: number;
  active: boolean;
}) {
  return (
    <motion.g
      aria-hidden
      initial={false}
      animate={{ opacity: active ? 0.85 : 0.24, scaleY: active ? 1 : 0.68 }}
      transition={transition}
      style={{ transformOrigin: `180px ${y}px` }}
    >
      <line
        x1="159"
        y1={y - 2}
        x2="180"
        y2={y + 18}
        stroke="url(#pyramid-tether)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="201"
        y1={y - 2}
        x2="180"
        y2={y + 18}
        stroke="url(#pyramid-tether)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx="180"
        cy={y + 11}
        r="2.8"
        fill="#050403"
        stroke="rgba(201,139,44,0.65)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </motion.g>
  );
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
  const state = activeLayer ?? 'idle';

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
      faceFills: ['url(#pyramid-base-left)', 'url(#pyramid-base-right)'],
      seamClass: 'top-[77%]',
      grainOpacity: 0.18,
      notes: baseNotes,
    },
    {
      key: 'heart',
      title: 'Heart Notes',
      ariaLabel: 'Reveal heart notes',
      ...layerGeometry.heart,
      faceFills: ['url(#pyramid-heart-left)', 'url(#pyramid-heart-right)'],
      seamClass: 'top-[53%]',
      grainOpacity: 0.15,
      notes: heartNotes,
    },
    {
      key: 'top',
      title: 'Top Notes',
      ariaLabel: 'Reveal top notes',
      ...layerGeometry.top,
      faceFills: ['url(#pyramid-top-left)', 'url(#pyramid-top-right)'],
      seamClass: 'top-[28%]',
      grainOpacity: 0.2,
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

  return (
    <section
      ref={rootRef}
      className={`flex h-full min-h-0 flex-col items-center justify-center px-3 py-5 sm:px-5 ${className}`}
      onClick={() => setActiveLayer(null)}
    >
      <div
        className="relative w-full max-w-[23rem] aspect-[1/1.08] shrink-0 sm:max-w-[25rem]"
        onClick={(event) => event.stopPropagation()}
      >
        <svg
          viewBox="0 0 360 420"
          className="h-full w-full overflow-visible"
          role="img"
          aria-label="Interactive fragrance note pyramid"
        >
          <defs>
            <linearGradient id="pyramid-top-left" x1="130" y1="82" x2="181" y2="82" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#3b2510" />
              <stop offset="0.62" stopColor="#946024" />
              <stop offset="1" stopColor="#d79c43" />
            </linearGradient>
            <linearGradient id="pyramid-top-right" x1="180" y1="82" x2="231" y2="82" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#f0c46d" />
              <stop offset="0.36" stopColor="#a96f29" />
              <stop offset="1" stopColor="#2b1b0d" />
            </linearGradient>
            <linearGradient id="pyramid-heart-left" x1="75" y1="198" x2="180" y2="198" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#0d1112" />
              <stop offset="0.58" stopColor="#20342f" />
              <stop offset="1" stopColor="#58645c" />
            </linearGradient>
            <linearGradient id="pyramid-heart-right" x1="180" y1="198" x2="285" y2="198" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#6f756b" />
              <stop offset="0.32" stopColor="#263a35" />
              <stop offset="1" stopColor="#0b0f10" />
            </linearGradient>
            <linearGradient id="pyramid-base-left" x1="20" y1="318" x2="180" y2="318" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#030405" />
              <stop offset="0.62" stopColor="#131617" />
              <stop offset="1" stopColor="#44443f" />
            </linearGradient>
            <linearGradient id="pyramid-base-right" x1="180" y1="318" x2="340" y2="318" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#54534e" />
              <stop offset="0.34" stopColor="#171819" />
              <stop offset="1" stopColor="#030303" />
            </linearGradient>
            <linearGradient id="pyramid-face-polish" x1="88" y1="196" x2="272" y2="196" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.02" />
              <stop offset="0.48" stopColor="#fff0bc" stopOpacity="0.13" />
              <stop offset="0.54" stopColor="#ffffff" stopOpacity="0.04" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.2" />
            </linearGradient>
            <linearGradient id="pyramid-ridge" x1="180" y1="26" x2="180" y2="376" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff6da" stopOpacity="0.88" />
              <stop offset="0.42" stopColor="#ebb34e" stopOpacity="0.52" />
              <stop offset="1" stopColor="#fff6da" stopOpacity="0.16" />
            </linearGradient>
            <linearGradient id="pyramid-tether" x1="180" y1="0" x2="180" y2="32" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#c98b2c" stopOpacity="0.78" />
              <stop offset="0.56" stopColor="#fff4da" stopOpacity="0.48" />
              <stop offset="1" stopColor="#c98b2c" stopOpacity="0" />
            </linearGradient>
            <pattern id="pyramid-grain" width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(22)">
              <path d="M0 0 H11" stroke="#ffffff" strokeOpacity="0.12" strokeWidth="0.7" />
            </pattern>
            <filter id="pyramid-shadow" x="-20%" y="-20%" width="140%" height="150%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="12" stdDeviation="8" floodColor="#000000" floodOpacity="0.48" />
              <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#c98b2c" floodOpacity="0.1" />
            </filter>
            <filter id="pyramid-active-glow" x="-20%" y="-20%" width="140%" height="150%" colorInterpolationFilters="sRGB">
              <feDropShadow dx="0" dy="12" stdDeviation="8" floodColor="#000000" floodOpacity="0.5" />
              <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#d69a3b" floodOpacity="0.32" />
            </filter>
            <linearGradient id="pyramid-ground-line" x1="42" y1="379.5" x2="318" y2="379.5" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#c98b2c" stopOpacity="0" />
              <stop offset="0.14" stopColor="#c98b2c" stopOpacity="0.42" />
              <stop offset="0.5" stopColor="#f2d089" stopOpacity="0.95" />
              <stop offset="0.86" stopColor="#c98b2c" stopOpacity="0.42" />
              <stop offset="1" stopColor="#c98b2c" stopOpacity="0" />
            </linearGradient>
            <filter id="pyramid-ground-line-soft" x="-12%" y="-800%" width="124%" height="1600%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.35" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g aria-hidden pointerEvents="none">
            <line
              x1="34"
              y1="379.5"
              x2="326"
              y2="379.5"
              stroke="#030303"
              strokeOpacity="0.62"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <g filter="url(#pyramid-ground-line-soft)">
              <line
                x1="42"
                y1="379.5"
                x2="318"
                y2="379.5"
                stroke="url(#pyramid-ground-line)"
                strokeWidth={1.1}
                strokeLinecap="round"
                opacity={prefersReducedMotion ? 0.78 : 0.55}
              >
                {!prefersReducedMotion ? (
                  <animate
                    attributeName="opacity"
                    values="0.34;0.95;0.34"
                    dur="2.4s"
                    repeatCount="indefinite"
                    calcMode="spline"
                    keySplines="0.42 0 0.58 1;0.42 0 0.58 1"
                    keyTimes="0;0.5;1"
                  />
                ) : null}
              </line>
            </g>
            {!prefersReducedMotion ? (
              <line
                x1="42"
                y1="379.5"
                x2="318"
                y2="379.5"
                stroke="#fff4d4"
                strokeOpacity="0.28"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray="42 274"
                fill="none"
              >
                <animate attributeName="stroke-dashoffset" from="0" to="-316" dur="5.8s" repeatCount="indefinite" />
                <animate
                  attributeName="opacity"
                  values="0.06;0.28;0.06"
                  dur="2.4s"
                  repeatCount="indefinite"
                  calcMode="spline"
                  keySplines="0.42 0 0.58 1;0.42 0 0.58 1"
                  keyTimes="0;0.5;1"
                />
              </line>
            ) : null}
          </g>
          <line
            x1="180"
            y1="18"
            x2="180"
            y2="386"
            stroke="#c98b2c"
            strokeOpacity="0.14"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />

          <MagneticTether y={139.5} active={activeLayer === 'top' || activeLayer === 'heart'} />
          <MagneticTether y={257.5} active={activeLayer === 'heart' || activeLayer === 'base'} />

          {layers.map((layer) => {
            const isActive = activeLayer === layer.key;
            const isMuted = Boolean(activeLayer && !isActive);

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
                  opacity: isMuted ? 0.54 : 1,
                  scale: 1,
                }}
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
                <g filter={isActive ? 'url(#pyramid-active-glow)' : 'url(#pyramid-shadow)'}>
                  {layer.faces.map((facePath, faceIndex) => (
                    <path
                      key={`${layer.key}-${faceIndex}`}
                      d={facePath}
                      fill={layer.faceFills[faceIndex]}
                    />
                  ))}
                  <path d={layer.hitPath} fill="url(#pyramid-grain)" opacity={layer.grainOpacity} />
                  <path d={layer.hitPath} fill="url(#pyramid-face-polish)" opacity={isActive ? 0.82 : 0.62} />
                </g>
                <path
                  d={layer.channelPath}
                  fill="none"
                  stroke="#050403"
                  strokeOpacity="0.92"
                  strokeWidth="3.4"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={layer.channelPath}
                  fill="none"
                  stroke="url(#pyramid-ridge)"
                  strokeWidth="0.75"
                  strokeLinecap="round"
                  opacity={isActive ? 0.9 : 0.64}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={layer.hitPath}
                  fill="none"
                  stroke="#050403"
                  strokeOpacity="0.82"
                  strokeWidth="3.4"
                  strokeLinejoin="miter"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={layer.hitPath}
                  fill="none"
                  stroke={isActive ? '#ffdd92' : '#d99d3e'}
                  strokeOpacity={isActive ? 0.78 : 0.44}
                  strokeWidth="0.82"
                  strokeLinejoin="miter"
                  vectorEffect="non-scaling-stroke"
                />
              </motion.g>
            );
          })}
        </svg>

        <AnimatePresence mode="wait">
          {selectedLayer ? (
            <motion.div
              key={selectedLayer.key}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className={`absolute left-1/2 z-50 w-[84%] max-w-[20rem] -translate-x-1/2 ${selectedLayer.seamClass}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border border-scent-accent/28 bg-black/72 px-3.5 py-3 text-center shadow-[0_14px_34px_rgba(0,0,0,0.58),0_0_26px_rgba(201,139,44,0.2),inset_0_1px_0_rgba(255,231,179,0.12)] backdrop-blur-md">
                <p className="text-[9px] font-bold uppercase tracking-[0.24em] text-scent-accent/88">
                  {selectedLayer.title}
                </p>
                <p className="mx-auto mt-1.5 max-w-[18rem] font-serif text-sm italic leading-snug text-white/82 sm:text-[0.95rem]">
                  {formatNotes(selectedLayer.notes)}
                </p>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="idle-pulse"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-none absolute left-1/2 top-[91%] z-50 flex -translate-x-1/2 items-center gap-2"
            >
              <span className="h-px w-10 bg-gradient-to-r from-transparent to-scent-accent/45" />
              <span className="h-1.5 w-1.5 rounded-full border border-scent-accent/40 bg-black shadow-[0_0_10px_rgba(201,139,44,0.38)]" />
              <span className="h-px w-10 bg-gradient-to-l from-transparent to-scent-accent/45" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
};
