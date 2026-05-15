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
  scale: { min: 0.7, max: 1.45 },
  x: { min: -18, max: 18 },
  y: { min: -18, max: 18 },
  cropEdge: { min: 0, max: 20 },
} as const;

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
    '--bottle-frame-crop-top': `${n.cropTop}%`,
    '--bottle-frame-crop-right': `${n.cropRight}%`,
    '--bottle-frame-crop-bottom': `${n.cropBottom}%`,
    '--bottle-frame-crop-left': `${n.cropLeft}%`,
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
