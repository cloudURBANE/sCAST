import sharp from "sharp";
import { logger } from "../lib/logger";
import {
  ORIENTATION_VERSION,
  orientPackshot as orientPackshotCore,
  type OrientationBoundingBox,
  type OrientationMetadata,
  type OrientationOptions,
  type OrientPackshotResult,
} from "./orientationEngineCore";

export {
  ORIENTATION_VERSION,
  type OrientationBoundingBox,
  type OrientationMetadata,
  type OrientationOptions,
  type OrientPackshotResult,
};

/**
 * Orient a background-removed packshot onto a uniform square canvas. Logs the
 * applied geometry (or the bail reason) and otherwise defers entirely to the
 * pure core. Callers MUST honor `ok: false` by passing the original buffer
 * through unchanged.
 */
export async function orientPackshot(
  input: Buffer,
  options?: OrientationOptions,
): Promise<OrientPackshotResult> {
  const result = await orientPackshotCore(input, options);
  if (result.ok) {
    logger.info(
      {
        orientationVersion: result.metadata.orientationVersion,
        aspectRatio: Number(result.metadata.aspectRatio.toFixed(3)),
        bbox: result.metadata.boundingBox,
      },
      "[orientationEngine] normalized packshot to square canvas",
    );
  } else {
    logger.debug({ reason: result.reason }, "[orientationEngine] passthrough (not oriented)");
  }
  return result;
}

/**
 * Encode an oriented PNG canvas to WebP for storage, matching the live image
 * pipeline's encode settings. Kept here (rather than in the pure core) so callers
 * outside api-server — e.g. the offline backfill script — get the same bytes.
 */
export async function encodeOrientedWebp(buffer: Buffer, quality = 82): Promise<Buffer> {
  return sharp(buffer).ensureAlpha().webp({ quality, effort: 4 }).toBuffer();
}

/**
 * Probe the pixel dimensions of an encoded image buffer (e.g. the oriented WebP).
 * Lives here so callers outside api-server — like the offline backfill script —
 * can record honest width/height without taking their own `sharp` dependency.
 */
export async function probeImageSize(
  buffer: Buffer,
): Promise<{ width: number | null; height: number | null }> {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width ?? null, height: meta.height ?? null };
}
