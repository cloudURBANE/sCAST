/**
 * Ambient silk-thread definitions shared by the DOM renderer and diagnostics.
 *
 * Keep this file as raw visual data. CSS strings are derived at the rendering
 * boundary so canvas diagnostics can draw without parsing CSS in their hot path.
 */

export type ThreadTone = 'shadow' | 'smoke' | 'gold' | 'champagne' | 'ember';
export type ThreadDepth = 'far' | 'mid' | 'near';
export type ThreadAxis = 'x' | 'y';

export type ThreadGradientStop = {
  offset: number;
  color: string;
};

export type ThreadShadowLayer = {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
};

export type ThreadLine = {
  id: string;
  width: number;
  height: number;
  coreStops: ThreadGradientStop[];
  shadowLayers: ThreadShadowLayer[];
  filter?: string;
  axis: ThreadAxis;
  direction: 1 | -1;
  speed: number;
  fade: number | null;
  presence: number;
  tone: ThreadTone;
  depth: ThreadDepth;
  stillLanePercent: number;
  stillPositionPercent: number;
};

type ThreadLineInput = Omit<ThreadLine, 'coreStops' | 'shadowLayers'> & {
  glow: keyof typeof THREAD_GLOWS;
};

const THREAD_GLOWS = {
  shadowFar: [
    { offsetX: 0, offsetY: 0, blur: 18, color: 'rgba(0, 0, 0, 0.52)' },
    { offsetX: 0, offsetY: 0, blur: 44, color: 'rgba(255, 222, 166, 0.018)' },
  ],
  shadowMid: [
    { offsetX: 0, offsetY: 0, blur: 24, color: 'rgba(0, 0, 0, 0.62)' },
    { offsetX: 0, offsetY: 0, blur: 58, color: 'rgba(255, 222, 166, 0.025)' },
  ],
  smokeFar: [
    { offsetX: 0, offsetY: 0, blur: 18, color: 'rgba(255, 226, 174, 0.055)' },
    { offsetX: 0, offsetY: 0, blur: 42, color: 'rgba(0, 0, 0, 0.36)' },
  ],
  smokeMid: [
    { offsetX: 0, offsetY: 0, blur: 22, color: 'rgba(255, 226, 174, 0.075)' },
    { offsetX: 0, offsetY: 0, blur: 54, color: 'rgba(0, 0, 0, 0.42)' },
  ],
  goldFar: [
    { offsetX: 0, offsetY: 0, blur: 16, color: 'rgba(212, 175, 55, 0.2)' },
    { offsetX: 0, offsetY: 0, blur: 46, color: 'rgba(124, 72, 17, 0.08)' },
  ],
  goldMid: [
    { offsetX: 0, offsetY: 0, blur: 18, color: 'rgba(255, 214, 126, 0.34)' },
    { offsetX: 0, offsetY: 0, blur: 52, color: 'rgba(212, 175, 55, 0.2)' },
  ],
  goldNear: [
    { offsetX: 0, offsetY: 0, blur: 20, color: 'rgba(255, 238, 190, 0.36)' },
    { offsetX: 0, offsetY: 0, blur: 58, color: 'rgba(212, 175, 55, 0.32)' },
    { offsetX: 0, offsetY: 0, blur: 96, color: 'rgba(114, 65, 14, 0.18)' },
  ],
  champagneMid: [
    { offsetX: 0, offsetY: 0, blur: 18, color: 'rgba(255, 247, 236, 0.3)' },
    { offsetX: 0, offsetY: 0, blur: 42, color: 'rgba(212, 175, 55, 0.14)' },
  ],
  champagneNear: [
    { offsetX: 0, offsetY: 0, blur: 20, color: 'rgba(255, 247, 236, 0.44)' },
    { offsetX: 0, offsetY: 0, blur: 52, color: 'rgba(255, 214, 126, 0.2)' },
  ],
  emberMid: [
    { offsetX: 0, offsetY: 0, blur: 16, color: 'rgba(255, 159, 67, 0.22)' },
    { offsetX: 0, offsetY: 0, blur: 44, color: 'rgba(124, 72, 17, 0.12)' },
  ],
  emberNear: [
    { offsetX: 0, offsetY: 0, blur: 20, color: 'rgba(255, 180, 82, 0.32)' },
    { offsetX: 0, offsetY: 0, blur: 58, color: 'rgba(156, 83, 18, 0.2)' },
  ],
} satisfies Record<string, ThreadShadowLayer[]>;

const THREAD_CORE_STOPS: Record<ThreadTone, ThreadGradientStop[]> = {
  shadow: [
    { offset: 0, color: 'transparent' },
    { offset: 0.12, color: 'rgba(0, 0, 0, 0.08)' },
    { offset: 0.35, color: 'rgba(0, 0, 0, 0.56)' },
    { offset: 0.48, color: 'rgba(0, 0, 0, 0.82)' },
    { offset: 0.53, color: 'rgba(255, 229, 175, 0.07)' },
    { offset: 0.69, color: 'rgba(0, 0, 0, 0.58)' },
    { offset: 1, color: 'transparent' },
  ],
  smoke: [
    { offset: 0, color: 'transparent' },
    { offset: 0.1, color: 'rgba(92, 72, 49, 0.04)' },
    { offset: 0.31, color: 'rgba(166, 132, 78, 0.13)' },
    { offset: 0.49, color: 'rgba(255, 244, 220, 0.2)' },
    { offset: 0.7, color: 'rgba(86, 61, 32, 0.1)' },
    { offset: 1, color: 'transparent' },
  ],
  gold: [
    { offset: 0, color: 'transparent' },
    { offset: 0.09, color: 'rgba(92, 50, 9, 0.08)' },
    { offset: 0.28, color: 'rgba(156, 101, 28, 0.34)' },
    { offset: 0.48, color: 'rgba(255, 234, 167, 0.8)' },
    { offset: 0.57, color: 'rgba(212, 175, 55, 0.72)' },
    { offset: 0.79, color: 'rgba(112, 65, 17, 0.32)' },
    { offset: 1, color: 'transparent' },
  ],
  champagne: [
    { offset: 0, color: 'transparent' },
    { offset: 0.13, color: 'rgba(255, 247, 236, 0.08)' },
    { offset: 0.34, color: 'rgba(255, 239, 197, 0.42)' },
    { offset: 0.49, color: 'rgba(255, 255, 252, 0.86)' },
    { offset: 0.64, color: 'rgba(236, 184, 83, 0.28)' },
    { offset: 0.82, color: 'rgba(255, 247, 236, 0.1)' },
    { offset: 1, color: 'transparent' },
  ],
  ember: [
    { offset: 0, color: 'transparent' },
    { offset: 0.12, color: 'rgba(105, 45, 8, 0.08)' },
    { offset: 0.34, color: 'rgba(180, 91, 20, 0.38)' },
    { offset: 0.51, color: 'rgba(255, 183, 83, 0.7)' },
    { offset: 0.72, color: 'rgba(132, 58, 11, 0.36)' },
    { offset: 1, color: 'transparent' },
  ],
};

function angleFor(axis: ThreadAxis): string {
  return axis === 'x' ? '90deg' : '180deg';
}

export function threadGradientToCss(axis: ThreadAxis, stops: ThreadGradientStop[]): string {
  const cssStops = stops.map((stop) => `${stop.color} ${stop.offset * 100}%`).join(', ');
  return `linear-gradient(${angleFor(axis)}, ${cssStops})`;
}

export function threadShadowToCss(layers: ThreadShadowLayer[]): string {
  return layers
    .map((layer) => `${layer.offsetX}px ${layer.offsetY}px ${layer.blur}px ${layer.color}`)
    .join(', ');
}

export function getThreadTravelSize(thread: ThreadLine): number {
  return thread.axis === 'x' ? thread.width : thread.height;
}

function thread(input: ThreadLineInput): ThreadLine {
  const { glow, ...line } = input;
  return {
    ...line,
    coreStops: THREAD_CORE_STOPS[line.tone],
    shadowLayers: THREAD_GLOWS[glow],
  };
}

export const THREAD_LINES: ThreadLine[] = [
  thread({
    id: 'shadow-warp-01',
    width: 172,
    height: 2.4,
    axis: 'x',
    direction: 1,
    speed: 1.28,
    fade: 110,
    presence: 0.62,
    tone: 'shadow',
    glow: 'shadowMid',
    depth: 'far',
    stillLanePercent: 16,
    stillPositionPercent: 8,
  }),
  thread({
    id: 'gold-filament-01',
    width: 198,
    height: 2.8,
    axis: 'x',
    direction: 1,
    speed: 1.86,
    fade: 124,
    presence: 0.82,
    tone: 'gold',
    glow: 'goldNear',
    filter: 'saturate(1.08)',
    depth: 'near',
    stillLanePercent: 24,
    stillPositionPercent: 18,
  }),
  thread({
    id: 'smoke-weft-01',
    width: 132,
    height: 1.6,
    axis: 'x',
    direction: -1,
    speed: 0.82,
    fade: 90,
    presence: 0.54,
    tone: 'smoke',
    glow: 'smokeFar',
    depth: 'far',
    stillLanePercent: 31,
    stillPositionPercent: 72,
  }),
  thread({
    id: 'champagne-needle-01',
    width: 116,
    height: 1.4,
    axis: 'x',
    direction: 1,
    speed: 2.22,
    fade: 82,
    presence: 0.68,
    tone: 'champagne',
    glow: 'champagneMid',
    depth: 'mid',
    stillLanePercent: 38,
    stillPositionPercent: 38,
  }),
  thread({
    id: 'ember-low-01',
    width: 148,
    height: 2,
    axis: 'x',
    direction: -1,
    speed: 1.08,
    fade: 96,
    presence: 0.56,
    tone: 'ember',
    glow: 'emberMid',
    depth: 'mid',
    stillLanePercent: 46,
    stillPositionPercent: 82,
  }),
  thread({
    id: 'shadow-warp-02',
    width: 92,
    height: 1.2,
    axis: 'x',
    direction: -1,
    speed: 0.58,
    fade: 70,
    presence: 0.44,
    tone: 'shadow',
    glow: 'shadowFar',
    depth: 'far',
    stillLanePercent: 53,
    stillPositionPercent: 58,
  }),
  thread({
    id: 'gold-filament-02',
    width: 154,
    height: 2.1,
    axis: 'x',
    direction: 1,
    speed: 1.44,
    fade: 96,
    presence: 0.68,
    tone: 'gold',
    glow: 'goldMid',
    depth: 'mid',
    stillLanePercent: 61,
    stillPositionPercent: 30,
  }),
  thread({
    id: 'champagne-needle-02',
    width: 74,
    height: 1.1,
    axis: 'x',
    direction: -1,
    speed: 1.92,
    fade: 58,
    presence: 0.72,
    tone: 'champagne',
    glow: 'champagneNear',
    filter: 'saturate(1.04)',
    depth: 'near',
    stillLanePercent: 68,
    stillPositionPercent: 68,
  }),
  thread({
    id: 'smoke-weft-02',
    width: 214,
    height: 1,
    axis: 'x',
    direction: 1,
    speed: 0.42,
    fade: 140,
    presence: 0.38,
    tone: 'smoke',
    glow: 'smokeFar',
    depth: 'far',
    stillLanePercent: 73,
    stillPositionPercent: 44,
  }),
  thread({
    id: 'gold-filament-03',
    width: 88,
    height: 1.8,
    axis: 'x',
    direction: 1,
    speed: 2.48,
    fade: 64,
    presence: 0.76,
    tone: 'gold',
    glow: 'goldMid',
    depth: 'near',
    stillLanePercent: 82,
    stillPositionPercent: 23,
  }),
  thread({
    id: 'shadow-warp-03',
    width: 126,
    height: 2,
    axis: 'x',
    direction: -1,
    speed: 1.18,
    fade: 90,
    presence: 0.5,
    tone: 'shadow',
    glow: 'shadowMid',
    depth: 'mid',
    stillLanePercent: 88,
    stillPositionPercent: 91,
  }),
  thread({
    id: 'ember-low-02',
    width: 104,
    height: 1.5,
    axis: 'x',
    direction: 1,
    speed: 0.72,
    fade: 78,
    presence: 0.52,
    tone: 'ember',
    glow: 'emberMid',
    depth: 'far',
    stillLanePercent: 92,
    stillPositionPercent: 52,
  }),
  thread({
    id: 'gold-vertical-01',
    width: 2.1,
    height: 164,
    axis: 'y',
    direction: 1,
    speed: 1.02,
    fade: 112,
    presence: 0.62,
    tone: 'gold',
    glow: 'goldMid',
    depth: 'mid',
    stillLanePercent: 12,
    stillPositionPercent: 12,
  }),
  thread({
    id: 'shadow-vertical-01',
    width: 1.3,
    height: 132,
    axis: 'y',
    direction: -1,
    speed: 0.62,
    fade: 92,
    presence: 0.46,
    tone: 'shadow',
    glow: 'shadowFar',
    depth: 'far',
    stillLanePercent: 21,
    stillPositionPercent: 76,
  }),
  thread({
    id: 'champagne-vertical-01',
    width: 1.4,
    height: 96,
    axis: 'y',
    direction: 1,
    speed: 1.7,
    fade: 72,
    presence: 0.7,
    tone: 'champagne',
    glow: 'champagneMid',
    depth: 'near',
    stillLanePercent: 27,
    stillPositionPercent: 34,
  }),
  thread({
    id: 'smoke-vertical-01',
    width: 1,
    height: 188,
    axis: 'y',
    direction: -1,
    speed: 0.48,
    fade: 130,
    presence: 0.36,
    tone: 'smoke',
    glow: 'smokeFar',
    depth: 'far',
    stillLanePercent: 36,
    stillPositionPercent: 62,
  }),
  thread({
    id: 'ember-vertical-01',
    width: 1.8,
    height: 118,
    axis: 'y',
    direction: -1,
    speed: 0.92,
    fade: 86,
    presence: 0.5,
    tone: 'ember',
    glow: 'emberMid',
    depth: 'mid',
    stillLanePercent: 43,
    stillPositionPercent: 88,
  }),
  thread({
    id: 'gold-vertical-02',
    width: 1.7,
    height: 86,
    axis: 'y',
    direction: 1,
    speed: 1.34,
    fade: 64,
    presence: 0.58,
    tone: 'gold',
    glow: 'goldFar',
    depth: 'far',
    stillLanePercent: 52,
    stillPositionPercent: 20,
  }),
  thread({
    id: 'shadow-vertical-02',
    width: 1.5,
    height: 108,
    axis: 'y',
    direction: 1,
    speed: 0.72,
    fade: 76,
    presence: 0.42,
    tone: 'shadow',
    glow: 'shadowMid',
    depth: 'mid',
    stillLanePercent: 59,
    stillPositionPercent: 48,
  }),
  thread({
    id: 'champagne-vertical-02',
    width: 1.2,
    height: 142,
    axis: 'y',
    direction: -1,
    speed: 1.18,
    fade: 96,
    presence: 0.54,
    tone: 'champagne',
    glow: 'champagneMid',
    depth: 'mid',
    stillLanePercent: 67,
    stillPositionPercent: 70,
  }),
  thread({
    id: 'smoke-vertical-02',
    width: 0.9,
    height: 72,
    axis: 'y',
    direction: 1,
    speed: 0.38,
    fade: 58,
    presence: 0.32,
    tone: 'smoke',
    glow: 'smokeFar',
    depth: 'far',
    stillLanePercent: 76,
    stillPositionPercent: 40,
  }),
  thread({
    id: 'gold-vertical-03',
    width: 2.4,
    height: 122,
    axis: 'y',
    direction: -1,
    speed: 1.56,
    fade: 90,
    presence: 0.68,
    tone: 'gold',
    glow: 'goldNear',
    filter: 'saturate(1.1)',
    depth: 'near',
    stillLanePercent: 84,
    stillPositionPercent: 80,
  }),
  thread({
    id: 'shadow-vertical-03',
    width: 1.1,
    height: 96,
    axis: 'y',
    direction: -1,
    speed: 0.54,
    fade: 70,
    presence: 0.38,
    tone: 'shadow',
    glow: 'shadowFar',
    depth: 'far',
    stillLanePercent: 91,
    stillPositionPercent: 58,
  }),
  thread({
    id: 'champagne-spark-01',
    width: 52,
    height: 1,
    axis: 'x',
    direction: 1,
    speed: 3.12,
    fade: 44,
    presence: 0.66,
    tone: 'champagne',
    glow: 'champagneNear',
    filter: 'saturate(1.06)',
    depth: 'near',
    stillLanePercent: 19,
    stillPositionPercent: 64,
  }),
  thread({
    id: 'gold-spark-01',
    width: 64,
    height: 1.3,
    axis: 'x',
    direction: -1,
    speed: 2.7,
    fade: 52,
    presence: 0.64,
    tone: 'gold',
    glow: 'goldMid',
    depth: 'near',
    stillLanePercent: 41,
    stillPositionPercent: 6,
  }),
  thread({
    id: 'ember-spark-01',
    width: 58,
    height: 1.2,
    axis: 'x',
    direction: 1,
    speed: 2.04,
    fade: 48,
    presence: 0.46,
    tone: 'ember',
    glow: 'emberNear',
    depth: 'mid',
    stillLanePercent: 57,
    stillPositionPercent: 94,
  }),
  thread({
    id: 'champagne-spark-02',
    width: 1,
    height: 54,
    axis: 'y',
    direction: -1,
    speed: 2.24,
    fade: 46,
    presence: 0.52,
    tone: 'champagne',
    glow: 'champagneMid',
    depth: 'near',
    stillLanePercent: 33,
    stillPositionPercent: 92,
  }),
  thread({
    id: 'gold-spark-02',
    width: 1.1,
    height: 66,
    axis: 'y',
    direction: 1,
    speed: 2.08,
    fade: 52,
    presence: 0.5,
    tone: 'gold',
    glow: 'goldMid',
    depth: 'mid',
    stillLanePercent: 70,
    stillPositionPercent: 10,
  }),
];
