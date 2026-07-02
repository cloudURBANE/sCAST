import sharp from "sharp";

/**
 * Returns true when the buffer decodes to an image whose visible content is
 * fully or near-fully transparent (i.e. nothing the user could ever see).
 *
 * We have observed Poof intermittently returning a successful HTTP 200 with a
 * fully transparent PNG when the input format/encoding confuses its model.
 * Persisting that as `backgroundRemoved: true` results in invisible packshots
 * in the wardrobe/share grid. Callers should treat this state as a Poof
 * failure and engage the local trim fallback path instead.
 *
 * Heuristic:
 *   - If the decoded image has no alpha channel, it cannot be transparent.
 *   - If the alpha channel's max is <=4/255 OR its mean is <=0.5/255, every
 *     pixel is effectively invisible. Both conditions defend against rounding
 *     artifacts at the encode boundary.
 *   - If decoding fails for any reason, conservatively report "not empty" so
 *     this guard never causes a false-positive fallback on healthy output.
 *
 * Threshold note: `alpha.mean` is the 0–255 average over the decoded alpha
 * channel (sharp's `stats()` reports raw 8-bit values, not normalized 0–1).
 * Real packshots — even ones with generous transparent padding — measure
 * `alpha.mean` ≈ 60–100. "Ghost" Poof outputs (a barely-visible silhouette of
 * the bottle that escapes the old `<= 0.5` guard) measure `alpha.mean` ≈ 1–4.
 * `<= 5.0` rejects ghosts while leaving a wide safety margin over real
 * subjects. Keep this number in lockstep with `packshotTrim.test.ts`'s
 * subject/opaque fixtures so the guard contract stays test-visible.
 *
 * Kept in a pure, dependency-light module so the test runner can load it
 * without pulling axios / form-data / pino transitively.
 */
export async function isEffectivelyTransparent(buffer: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.hasAlpha) return false;
    const stats = await sharp(buffer).stats();
    const alpha = stats.channels[stats.channels.length - 1];
    if (!alpha) return false;
    // Whole-image guard (original): fully invisible, or a near-empty ghost whose
    // average alpha is below the floor.
    if (alpha.max <= 4 || alpha.mean <= 5.0) return true;
    // Center/subject-region guard: a real packshot always carries the bottle in
    // the middle of the frame, so the CENTER's mean alpha is high. A whole-image
    // mean can clear the 5.0 floor on a Poof "ghost" whose only opaque pixels are
    // a small speck off to one side; sampling the center region instead catches
    // those (image-pipeline transparency guard fix). Conservative: any failure to
    // measure the center falls through to "not transparent".
    return await isCenterRegionTransparent(buffer);
  } catch {
    return false;
  }
}

// Fraction of the frame (centered) inspected for subject alpha. The bottle is
// centered in every normalized packshot, so a transparent center means there is
// effectively no visible subject regardless of stray edge pixels.
const CENTER_REGION_FRACTION = 0.5;
// Mean alpha (0–255) the center crop must clear to count as "has a subject".
// Real centered bottles measure well above this; ghost outputs measure ~0–4.
const CENTER_REGION_ALPHA_MIN = 8.0;

async function isCenterRegionTransparent(buffer: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w <= 0 || h <= 0) return false;
    const cw = Math.max(1, Math.floor(w * CENTER_REGION_FRACTION));
    const ch = Math.max(1, Math.floor(h * CENTER_REGION_FRACTION));
    const left = Math.floor((w - cw) / 2);
    const top = Math.floor((h - ch) / 2);
    const stats = await sharp(buffer)
      .extract({ left, top, width: cw, height: ch })
      .stats();
    const alpha = stats.channels[stats.channels.length - 1];
    if (!alpha) return false;
    return alpha.max <= 4 || alpha.mean <= CENTER_REGION_ALPHA_MIN;
  } catch {
    return false;
  }
}

// --- hasOpaqueLightBackground helpers --------------------------------------

const SAMPLE_EDGE = 96;
// Width (in pixels of the resized 96x96 sample) of the outer ring we inspect.
// 3 keeps us strictly on the *background* edge — the bottle is centered.
const BORDER_WIDTH = 3;
const ALPHA_OPAQUE_MIN = 240;
const RGB_LIGHT_MIN = 235;
// Fraction of sampled border pixels that must be opaque-light before we flag
// the image. Set high so a transparent halo around the bottle does not trip it
// — a real product-mode white rectangle covers nearly 100% of the border.
const OPAQUE_LIGHT_RATIO_THRESHOLD = 0.85;

function isOpaqueLightPixel(r: number, g: number, b: number, a: number): boolean {
  return (
    a >= ALPHA_OPAQUE_MIN &&
    r >= RGB_LIGHT_MIN &&
    g >= RGB_LIGHT_MIN &&
    b >= RGB_LIGHT_MIN
  );
}

/**
 * Returns true when the decoded image's outer border / corners are
 * predominantly opaque + near-white. This catches Poof outputs where the model
 * returned HTTP 200 but left the original product-shot white rectangle around
 * the bottle (a common failure mode of Poof's `type=product` preset).
 *
 * Conservative by design: we only inspect a thin ring of edge pixels on a
 * downscaled copy of the image. The bottle itself sits in the middle of the
 * frame and is never sampled, so a correctly-removed background (transparent
 * outer ring) trivially fails the threshold.
 */
export async function hasOpaqueLightBackground(buffer: Buffer): Promise<boolean> {
  try {
    const { data, info } = await sharp(buffer)
      .resize(SAMPLE_EDGE, SAMPLE_EDGE, {
        fit: "fill",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    if (channels < 4 || width <= 0 || height <= 0) return false;

    let sampled = 0;
    let opaqueLight = 0;

    const inspect = (x: number, y: number): void => {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      sampled++;
      if (isOpaqueLightPixel(r, g, b, a)) opaqueLight++;
    };

    // Top + bottom border bands.
    for (let y = 0; y < BORDER_WIDTH && y < height; y++) {
      for (let x = 0; x < width; x++) inspect(x, y);
    }
    for (let y = Math.max(0, height - BORDER_WIDTH); y < height; y++) {
      for (let x = 0; x < width; x++) inspect(x, y);
    }
    // Left + right border bands, skipping the corner cells already counted.
    for (let y = BORDER_WIDTH; y < height - BORDER_WIDTH; y++) {
      for (let x = 0; x < BORDER_WIDTH && x < width; x++) inspect(x, y);
      for (let x = Math.max(0, width - BORDER_WIDTH); x < width; x++) inspect(x, y);
    }

    if (sampled === 0) return false;
    return opaqueLight / sampled >= OPAQUE_LIGHT_RATIO_THRESHOLD;
  } catch {
    // Conservative: never report a false positive when we cannot decode.
    return false;
  }
}
