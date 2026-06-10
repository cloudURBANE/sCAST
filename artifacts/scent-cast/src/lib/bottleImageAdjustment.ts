import type { CSSProperties } from 'react';

export type BottleImageAdjustment = {
  scale?: number;
  x?: number;
  y?: number;
  /**
   * Legacy uniform inset (all edges). Used when a stored row only has `crop`, or as the
   * default for any per-edge key that is omitted in the input object.
   */
  crop?: number;
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
};

export type NormalizedBottleImageAdjustment = {
  scale: number;
  x: number;
  y: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  cropLeft: number;
};

export const DEFAULT_BOTTLE_IMAGE_ADJUSTMENT: NormalizedBottleImageAdjustment = {
  scale: 1,
  x: 0,
  y: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  cropLeft: 0,
};

const LIMITS = {
  // Wider framing envelope so unusual packshots can be pushed further off-center
  // and zoomed harder. Container is `overflow-hidden`, so the extra travel only
  // slides the bottle within its clipped slot — it can't break page layout.
  scale: { min: 0.5, max: 1.8 },
  x: { min: -36, max: 36 },
  y: { min: -36, max: 36 },
  /** Stored per-edge crop strength (slider/API), 0-40. */
  cropEdge: { min: 0, max: 40 },
} as const;

/**
 * Shared slider/clamp bounds. The editor sliders bind their min/max to these so
 * the visible track can always reach what `normalizeBottleImageAdjustment` clamps
 * to (no drift between UI range and stored range). The api-server clamp in
 * `services/fragrancePayload.ts` mirrors these values across the package boundary.
 */
export const BOTTLE_FRAME_LIMITS = LIMITS;

/** Max value for crop sliders and PATCH payloads (not equal to CSS inset %). */
export const BOTTLE_CROP_STORED_MAX = LIMITS.cropEdge.max;

/** Max clip-path inset % at full slider. Bottom stays gentler because bottles are baseline-aligned. */
const BOTTLE_CROP_CLIP_CAP_PCT = {
  top: 38,
  right: 38,
  bottom: 24,
  left: 38,
} as const;
/** Keep early slider moves subtle so tight crops survive responsive frame changes. */
const BOTTLE_CROP_CLIP_CURVE_GAMMA = 0.85;

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = finiteNumber(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function normalizeCropEdge(
  value: unknown,
  fallback: number,
): number {
  return round(
    clamp(value, LIMITS.cropEdge.min, LIMITS.cropEdge.max, fallback),
    1,
  );
}

type CropEdge = keyof typeof BOTTLE_CROP_CLIP_CAP_PCT;

/** Maps stored crop strength to real `inset()` percentages on the fitted packshot. */
function clipInsetPercentFromStored(stored: number, edge: CropEdge): string {
  if (stored <= 0) return '0%';
  const t = Math.min(stored, LIMITS.cropEdge.max) / LIMITS.cropEdge.max;
  const pct = BOTTLE_CROP_CLIP_CAP_PCT[edge] * t ** BOTTLE_CROP_CLIP_CURVE_GAMMA;
  return `${round(pct, 2)}%`;
}

export function normalizeBottleImageAdjustment(
  value?: BottleImageAdjustment | null,
): NormalizedBottleImageAdjustment {
  const legacyCrop = round(
    clamp(
      value?.crop,
      LIMITS.cropEdge.min,
      LIMITS.cropEdge.max,
      DEFAULT_BOTTLE_IMAGE_ADJUSTMENT.cropTop,
    ),
    1,
  );

  return {
    scale: round(
      clamp(value?.scale, LIMITS.scale.min, LIMITS.scale.max, DEFAULT_BOTTLE_IMAGE_ADJUSTMENT.scale),
      2,
    ),
    x: round(clamp(value?.x, LIMITS.x.min, LIMITS.x.max, DEFAULT_BOTTLE_IMAGE_ADJUSTMENT.x), 1),
    y: round(clamp(value?.y, LIMITS.y.min, LIMITS.y.max, DEFAULT_BOTTLE_IMAGE_ADJUSTMENT.y), 1),
    cropTop: normalizeCropEdge(value?.cropTop, legacyCrop),
    cropRight: normalizeCropEdge(value?.cropRight, legacyCrop),
    cropBottom: normalizeCropEdge(value?.cropBottom, legacyCrop),
    cropLeft: normalizeCropEdge(value?.cropLeft, legacyCrop),
  };
}

export function bottleImageAdjustmentStyle(
  value?: BottleImageAdjustment | null,
): CSSProperties {
  const n = normalizeBottleImageAdjustment(value);
  return {
    '--bottle-frame-scale': String(n.scale),
    '--bottle-frame-x': `${n.x}%`,
    '--bottle-frame-y': `${n.y}%`,
    '--bottle-frame-crop-top': clipInsetPercentFromStored(n.cropTop, 'top'),
    '--bottle-frame-crop-right': clipInsetPercentFromStored(n.cropRight, 'right'),
    '--bottle-frame-crop-bottom': clipInsetPercentFromStored(n.cropBottom, 'bottom'),
    '--bottle-frame-crop-left': clipInsetPercentFromStored(n.cropLeft, 'left'),
  } as CSSProperties;
}

export function bottleImageAdjustmentsEqual(
  a?: BottleImageAdjustment | null,
  b?: BottleImageAdjustment | null,
): boolean {
  const aa = normalizeBottleImageAdjustment(a);
  const bb = normalizeBottleImageAdjustment(b);
  return (
    aa.scale === bb.scale &&
    aa.x === bb.x &&
    aa.y === bb.y &&
    aa.cropTop === bb.cropTop &&
    aa.cropRight === bb.cropRight &&
    aa.cropBottom === bb.cropBottom &&
    aa.cropLeft === bb.cropLeft
  );
}
