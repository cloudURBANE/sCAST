import sharp from "sharp";

// Local, API-free background removal for packshots that sit on a flat near-white
// studio plate (the gold standard for retailer/official product shots). Used as
// a fallback when Poof is unavailable or fails: the previous fallback only
// trimmed the border and left the solid white plate behind the bottle.
//
// The key safety property is *edge connectivity*: we only clear near-white
// pixels reachable from the frame border by a flood fill. White on the bottle
// itself (a white cap, a white label panel, a clear-glass highlight) is islanded
// from the border by the bottle's darker silhouette, so it is never touched. A
// naive global "white -> transparent" mask would punch holes straight through
// those regions; this does not.
//
// Pure enough to test directly: only `sharp` is imported (no axios / db / pino).

// Above this we skip the flood fill rather than allocate large typed arrays and
// pay an unbounded BFS cost; the caller falls back to the border-trim path.
const MAX_CHROMA_PIXELS = 5_000_000; // ~2240x2240

// A pixel counts as background only when it is bright on every channel *and*
// close to neutral (low channel spread). The spread guard keeps tinted glass
// highlights and coloured reflections out of the background set.
const NEAR_WHITE_MIN = 236;
const CHANNEL_SPREAD_MAX = 18;

// Guard rails on the result. Too little removed => the image was not actually on
// a white plate (don't dignify noise as a cut-out). Too much removed => we have
// likely eaten a near-white product and would emit a near-empty image; bail and
// let the caller keep the original via the trim path.
const MIN_REMOVED_FRACTION = 0.04;
const MAX_REMOVED_FRACTION = 0.93;

export type LocalChromaKeyResult = {
  /** PNG bytes with a fresh alpha channel; background pixels set fully transparent. */
  buffer: Buffer;
  /** Fraction of total pixels cleared to transparency, in [0, 1]. */
  removedFraction: number;
};

function isNearWhite(r: number, g: number, b: number): boolean {
  if (r < NEAR_WHITE_MIN || g < NEAR_WHITE_MIN || b < NEAR_WHITE_MIN) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min <= CHANNEL_SPREAD_MAX;
}

/**
 * Strip a flat near-white background from a packshot using an edge-connected
 * flood fill. Returns the cut-out PNG plus the removed fraction, or `null` when
 * the heuristic declines (decode failure, image too large, or a removed
 * fraction outside the safe band).
 */
export async function localWhiteChromaKey(input: Buffer): Promise<LocalChromaKeyResult | null> {
  let data: Buffer;
  let width: number;
  let height: number;
  let channels: number;
  try {
    const out = await sharp(input)
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = out.data;
    ({ width, height, channels } = out.info);
  } catch {
    return null;
  }

  if (channels < 4 || width <= 0 || height <= 0) return null;
  const total = width * height;
  if (total > MAX_CHROMA_PIXELS) return null;

  // 1 = pixel belongs to the border-connected background and will be cleared.
  const background = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const isBackgroundPixel = (idx: number): boolean => {
    const p = idx * channels;
    // Already-transparent pixels (e.g. a prior partial cut-out) are background,
    // letting the flood pass through existing holes and clear any residual white.
    if (data[p + 3] === 0) return true;
    return isNearWhite(data[p], data[p + 1], data[p + 2]);
  };

  const enqueue = (idx: number): void => {
    if (!background[idx] && isBackgroundPixel(idx)) {
      background[idx] = 1;
      queue[tail++] = idx;
    }
  };

  // Seed from every border pixel.
  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);
    enqueue(y * width + (width - 1));
  }

  // 4-connected flood fill.
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0) enqueue(idx - 1);
    if (x < width - 1) enqueue(idx + 1);
    if (y > 0) enqueue(idx - width);
    if (y < height - 1) enqueue(idx + width);
  }

  let removed = 0;
  for (let i = 0; i < total; i++) if (background[i]) removed++;
  const removedFraction = removed / total;
  if (removedFraction < MIN_REMOVED_FRACTION || removedFraction > MAX_REMOVED_FRACTION) {
    return null;
  }

  for (let i = 0; i < total; i++) {
    if (background[i]) data[i * channels + 3] = 0;
  }

  const buffer = await sharp(data, {
    raw: { width, height, channels: channels as 1 | 2 | 3 | 4 },
  })
    .png()
    .toBuffer();
  return { buffer, removedFraction };
}
