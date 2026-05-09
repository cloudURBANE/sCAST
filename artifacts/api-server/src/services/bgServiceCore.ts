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
    return alpha.max <= 4 || alpha.mean <= 0.5;
  } catch {
    return false;
  }
}
