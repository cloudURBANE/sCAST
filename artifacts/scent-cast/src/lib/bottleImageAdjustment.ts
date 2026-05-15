import type { CSSProperties } from 'react';

export type BottleImageAdjustment = {
  scale?: number;
  x?: number;
  y?: number;
  crop?: number;
};

export type NormalizedBottleImageAdjustment = Required<BottleImageAdjustment>;

export const DEFAULT_BOTTLE_IMAGE_ADJUSTMENT: NormalizedBottleImageAdjustment = {
  scale: 1,
  x: 0,
  y: 0,
  crop: 0,
};

const LIMITS = {
  scale: { min: 0.7, max: 1.45 },
  x: { min: -18, max: 18 },
  y: { min: -18, max: 18 },
  crop: { min: 0, max: 20 },
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

export function normalizeBottleImageAdjustment(
  value?: BottleImageAdjustment | null,
): NormalizedBottleImageAdjustment {
  return {
    scale: round(
      clamp(value?.scale, LIMITS.scale.min, LIMITS.scale.max, DEFAULT_BOTTLE_IMAGE_ADJUSTMENT.scale),
      2,
    ),
    x: round(clamp(value?.x, LIMITS.x.min, LIMITS.x.max, DEFAULT_BOTTLE_IMAGE_ADJUSTMENT.x), 1),
    y: round(clamp(value?.y, LIMITS.y.min, LIMITS.y.max, DEFAULT_BOTTLE_IMAGE_ADJUSTMENT.y), 1),
    crop: round(
      clamp(value?.crop, LIMITS.crop.min, LIMITS.crop.max, DEFAULT_BOTTLE_IMAGE_ADJUSTMENT.crop),
      1,
    ),
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
    '--bottle-frame-crop': `${n.crop}%`,
  } as CSSProperties;
}

export function bottleImageAdjustmentsEqual(
  a?: BottleImageAdjustment | null,
  b?: BottleImageAdjustment | null,
): boolean {
  const aa = normalizeBottleImageAdjustment(a);
  const bb = normalizeBottleImageAdjustment(b);
  return aa.scale === bb.scale && aa.x === bb.x && aa.y === bb.y && aa.crop === bb.crop;
}
