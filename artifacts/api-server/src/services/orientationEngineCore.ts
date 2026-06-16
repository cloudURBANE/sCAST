import sharp from "sharp";

// Server-side Orientation Engine: normalize a background-removed packshot onto a
// uniform square canvas so every bottle renders at an identical relative size and
// sits on the same baseline, independent of the source file's aspect ratio or
// internal margins.
//
// This runs AFTER background removal, so the input is expected to carry a real
// alpha channel (the bottle is opaque, everything else is transparent). That is
// what makes the bounding box clean: floor reflections and drop shadows on the
// original plate are already alpha=0 by the time we get here, so a simple alpha
// threshold gives a tight, shadow-free box without the flood-fill gymnastics.
//
// Fail-safe contract (mirrors packshotTrimCore.trimPackshotBuffer): on ANY doubt
// — no alpha, empty box, geometry that won't fit the canvas — return
// `{ ok: false, reason }`. The caller must then pass the original buffer through
// unchanged rather than emit a broken canvas.
//
// Pure enough to unit-test: only `sharp` is imported (no pino / db / axios).

/**
 * Bump when the geometry changes in a way that should re-normalize existing rows.
 * Stored per image so a backfill can upgrade in place WITHOUT re-running Serper /
 * Poof (which cost money) — see services/userImageBackfill style consumers.
 */
export const ORIENTATION_VERSION = "1.1.0";

/** Downscaled raster size for the bbox + centroid scan (CPU/memory budget). */
const SCAN_MAX = 512;
/** Refuse to extract from absurdly large originals (raw RGBA would blow memory). */
const DEFAULT_MAX_INPUT_PIXELS = 40_000_000; // ~6300x6300

export interface OrientationOptions {
  /** Output square edge in px. Default 1024 (matches MAX_OUTPUT_DIMENSION). */
  canvasSize?: number;
  /** Bottle height as a fraction of the canvas. Default 0.88 (901px @ 1024). */
  targetHeightPct?: number;
  /** Cap bottle width (flat-lays / gift boxes) as a fraction. Default 0.56. */
  maxWidthPct?: number;
  /** Transparent gap from canvas bottom to the bottle base, in px. Default 35 (~3.4% @ 1024). */
  baselineOffset?: number;
  /** Pixels with alpha at-or-below this are background. Default 25. */
  alphaThreshold?: number;
  /** Center on the alpha centroid (handles asymmetric nozzles). Default true. */
  useCenterOfMass?: boolean;
  maxInputPixels?: number;
}

export interface OrientationBoundingBox {
  /** All four are fractions of the ORIGINAL image, in [0, 1]. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrientationMetadata {
  originalWidth: number;
  originalHeight: number;
  /** Detected bottle box, normalized against the original image. */
  boundingBox: OrientationBoundingBox;
  /** bbox width / height in pixels (>1 wide, <1 tall). */
  aspectRatio: number;
  orientationVersion: string;
  /** Fraction of canvas height where the bottle base sits (1 - offset/canvas). */
  baselineAlignment: number;
}

export type OrientPackshotResult =
  | { ok: true; buffer: Buffer; metadata: OrientationMetadata }
  | { ok: false; reason: string };

interface ScanResult {
  /** Bounding box in ORIGINAL pixel coordinates, with safety margin applied. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Alpha centroid X in ORIGINAL pixel coordinates (absolute), or null. */
  centroidXOrig: number | null;
}

/**
 * Single downscaled raw pass that yields BOTH the alpha bounding box and the
 * horizontal alpha centroid. Computing the centroid here (over every foreground
 * pixel — background pixels have alpha<=threshold and contribute nothing) is
 * identical to the reference's separate per-bbox centroid pass, so we save a
 * whole decode/extract round trip.
 */
async function scanAlpha(
  imageBuffer: Buffer,
  origW: number,
  origH: number,
  alphaThreshold: number,
): Promise<ScanResult | null> {
  let data: Buffer;
  let dw: number;
  let dh: number;
  try {
    const out = await sharp(imageBuffer)
      .resize(SCAN_MAX, SCAN_MAX, { fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = out.data;
    dw = out.info.width;
    dh = out.info.height;
    if (out.info.channels < 4) return null;
  } catch {
    return null;
  }

  let minX = dw;
  let maxX = -1;
  let minY = dh;
  let maxY = -1;
  let totalAlpha = 0;
  let weightedXSum = 0;

  for (let y = 0; y < dh; y++) {
    const row = y * dw;
    for (let x = 0; x < dw; x++) {
      const alpha = data[(row + x) * 4 + 3];
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        totalAlpha += alpha;
        weightedXSum += x * alpha;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null; // no foreground at all

  const scaleX = origW / dw;
  const scaleY = origH / dh;
  const left = Math.max(0, Math.floor(minX * scaleX) - 2);
  const top = Math.max(0, Math.floor(minY * scaleY) - 2);
  const right = Math.min(origW - 1, Math.ceil((maxX + 1) * scaleX) + 2);
  const bottom = Math.min(origH - 1, Math.ceil((maxY + 1) * scaleY) + 2);

  const centroidXOrig =
    totalAlpha > 0 ? (weightedXSum / totalAlpha) * scaleX : null;

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    centroidXOrig,
  };
}

/**
 * Crop, scale, center, and baseline-align a background-removed packshot onto a
 * transparent square canvas. Returns the canvas PNG plus the geometry metadata,
 * or `{ ok: false }` when the input isn't a usable cut-out.
 */
export async function orientPackshot(
  imageBuffer: Buffer,
  options: OrientationOptions = {},
): Promise<OrientPackshotResult> {
  const canvasSize = options.canvasSize ?? 1024;
  const targetHeightPct = options.targetHeightPct ?? 0.88;
  const maxWidthPct = options.maxWidthPct ?? 0.56;
  const baselineOffset = options.baselineOffset ?? 35;
  const alphaThreshold = options.alphaThreshold ?? 25;
  const useCenterOfMass = options.useCenterOfMass ?? true;
  const maxInputPixels = options.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS;

  let origW: number;
  let origH: number;
  let hasAlpha: boolean;
  try {
    const meta = await sharp(imageBuffer).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: "missing_dimensions" };
    origW = meta.width;
    origH = meta.height;
    hasAlpha = meta.hasAlpha === true;
  } catch {
    return { ok: false, reason: "metadata_failed" };
  }

  // The engine only makes sense on a real cut-out. A flat opaque packshot has no
  // alpha to box, so we bail and let the caller keep its trim/normalize fallback.
  if (!hasAlpha) return { ok: false, reason: "no_alpha" };
  if (origW * origH > maxInputPixels) return { ok: false, reason: "oversized_input" };

  const scan = await scanAlpha(imageBuffer, origW, origH, alphaThreshold);
  if (!scan) return { ok: false, reason: "empty_bbox" };

  const bw = scan.width;
  const bh = scan.height;
  if (bw <= 0 || bh <= 0) return { ok: false, reason: "degenerate_bbox" };

  const targetHeight = Math.round(canvasSize * targetHeightPct);
  const maxWidth = Math.round(canvasSize * maxWidthPct);

  let scale = targetHeight / bh;
  if (bw * scale > maxWidth) scale = maxWidth / bw;

  const wScaled = Math.max(1, Math.round(bw * scale));
  const hScaled = Math.max(1, Math.round(bh * scale));

  const bottomPad = baselineOffset;
  const topPad = canvasSize - hScaled - bottomPad;
  // Should be impossible given targetHeightPct + baselineOffset < 1, but a hostile
  // option set could violate it — fail safe rather than throw into the pipeline.
  if (topPad < 0 || wScaled > canvasSize) {
    return { ok: false, reason: "canvas_constraint" };
  }

  // Horizontal placement: center on the alpha centroid so asymmetric components
  // (spray nozzles, pump triggers) don't visually drag the bottle off-center.
  let leftPad: number;
  if (useCenterOfMass && scan.centroidXOrig != null) {
    const centroidInBbox = scan.centroidXOrig - scan.left;
    const scaledCentroid = centroidInBbox * scale;
    leftPad = Math.round(canvasSize / 2 - scaledCentroid);
    leftPad = Math.max(0, Math.min(leftPad, canvasSize - wScaled));
  } else {
    leftPad = Math.round((canvasSize - wScaled) / 2);
  }
  const rightPad = canvasSize - wScaled - leftPad;

  let buffer: Buffer;
  try {
    const cropped = await sharp(imageBuffer)
      .extract({ left: scan.left, top: scan.top, width: bw, height: bh })
      .resize(wScaled, hScaled, { fit: "fill" })
      .ensureAlpha()
      .toBuffer();

    buffer = await sharp(cropped)
      .extend({
        top: topPad,
        bottom: bottomPad,
        left: leftPad,
        right: rightPad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  } catch {
    return { ok: false, reason: "pipeline_failed" };
  }

  const metadata: OrientationMetadata = {
    originalWidth: origW,
    originalHeight: origH,
    boundingBox: {
      x: scan.left / origW,
      y: scan.top / origH,
      width: bw / origW,
      height: bh / origH,
    },
    aspectRatio: bw / bh,
    orientationVersion: ORIENTATION_VERSION,
    baselineAlignment: (canvasSize - baselineOffset) / canvasSize,
  };

  return { ok: true, buffer, metadata };
}
