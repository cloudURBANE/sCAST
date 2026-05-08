import sharp from "sharp";

/** Bump when trim logic changes (e.g. for cache keys). */
export const PACKSHOT_TRIM_VERSION = 3;

const DEFAULT_MAX_INPUT_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_LONG_EDGE = 4096;
const DEFAULT_TRIM_THRESHOLD = 40;
/** Allows very padded vendor packshots while still rejecting crop boxes that are basically noise. */
const DEFAULT_MAX_TRIM_FRACTION = 0.985;
const DEFAULT_SAFE_CROP_PADDING_RATIO = 0.025;
const MIN_ALPHA_CONTENT = 24;

export type PackshotTrimLog = {
  debug: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
};

export type PackshotTrimBg = "corners" | { r: number; g: number; b: number };

export type PackshotTrimOutput =
  | { format: "jpeg"; quality?: number }
  | { format: "png"; ensureAlpha: boolean };

export type TrimPackshotOptions = {
  maxInputBytes?: number;
  maxLongEdge?: number;
  trimThreshold?: number;
  maxTrimFraction?: number;
  background: PackshotTrimBg;
  output: PackshotTrimOutput;
  /** Server injects pino; omit in tests. */
  log?: PackshotTrimLog;
};

export type TrimPackshotOk = {
  ok: true;
  buffer: Buffer;
  contentType: string;
  inW: number;
  inH: number;
  outW: number;
  outH: number;
};

export type TrimPackshotResult = TrimPackshotOk | { ok: false; reason: string };

type Rgb = { r: number; g: number; b: number };

type CropBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  rawWidth: number;
  rawHeight: number;
  contentPixels: number;
};

/** Median of the outer edge ring on a downscaled raster - stable vs one bad corner. */
async function sampleEdgeBackground(
  buf: Buffer,
): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(buf)
    .resize(96, 96, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const c = info.channels;
  const points: Array<readonly [number, number, number]> = [];
  const add = (x: number, y: number) => {
    const xi = Math.min(Math.max(0, x), w - 1);
    const yi = Math.min(Math.max(0, y), h - 1);
    const i = (yi * w + xi) * c;
    const alpha = c >= 4 ? (data[i + 3] ?? 255) : 255;
    if (alpha <= MIN_ALPHA_CONTENT) return;
    points.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0] as const);
  };

  const steps = 12;
  for (let n = 0; n <= steps; n += 1) {
    const x = Math.round((n / steps) * (w - 1));
    const y = Math.round((n / steps) * (h - 1));
    add(x, 0);
    add(x, h - 1);
    add(0, y);
    add(w - 1, y);
  }

  if (points.length === 0) return { r: 255, g: 255, b: 255 };
  const median1 = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };

  return {
    r: median1(points.map((p) => p[0])),
    g: median1(points.map((p) => p[1])),
    b: median1(points.map((p) => p[2])),
  };
}

function resolveBackground(
  mode: PackshotTrimBg,
  work: Buffer,
): Promise<{ r: number; g: number; b: number }> {
  if (mode === "corners") return sampleEdgeBackground(work);
  return Promise.resolve(mode);
}

function channelDistance(a: Rgb, b: Rgb): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
  );
}

function isLikelyContentPixel(
  data: Buffer,
  i: number,
  channels: number,
  background: Rgb,
  trimThreshold: number,
): boolean {
  const alpha = channels >= 4 ? (data[i + 3] ?? 255) : 255;
  if (alpha <= MIN_ALPHA_CONTENT) return false;
  if (alpha < 245) return true;

  return (
    channelDistance(
      {
        r: data[i] ?? 0,
        g: data[i + 1] ?? 0,
        b: data[i + 2] ?? 0,
      },
      background,
    ) > trimThreshold
  );
}

async function detectContentCropBox(
  work: Buffer,
  background: Rgb,
  trimThreshold: number,
  maxTrimFraction: number,
): Promise<CropBox | null> {
  const { data, info } = await sharp(work)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  const C = info.channels;
  const colCounts = new Uint32Array(W);
  const rowCounts = new Uint32Array(H);
  let rawLeft = W;
  let rawTop = H;
  let rawRight = -1;
  let rawBottom = -1;
  let contentPixels = 0;

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * C;
      if (!isLikelyContentPixel(data, i, C, background, trimThreshold))
        continue;

      contentPixels += 1;
      colCounts[x] += 1;
      rowCounts[y] += 1;
      if (x < rawLeft) rawLeft = x;
      if (x > rawRight) rawRight = x;
      if (y < rawTop) rawTop = y;
      if (y > rawBottom) rawBottom = y;
    }
  }

  const imageArea = W * H;
  const minContentPixels = Math.max(32, Math.floor(imageArea * 0.00045));
  if (
    contentPixels < minContentPixels ||
    rawRight < rawLeft ||
    rawBottom < rawTop
  ) {
    return null;
  }

  const minColPixels = Math.max(2, Math.floor(H * 0.0035));
  const minRowPixels = Math.max(2, Math.floor(W * 0.0035));
  let left = rawLeft;
  let right = rawRight;
  let top = rawTop;
  let bottom = rawBottom;

  while (left <= right && colCounts[left] < minColPixels) left += 1;
  while (right >= left && colCounts[right] < minColPixels) right -= 1;
  while (top <= bottom && rowCounts[top] < minRowPixels) top += 1;
  while (bottom >= top && rowCounts[bottom] < minRowPixels) bottom -= 1;

  if (right < left || bottom < top) {
    left = rawLeft;
    right = rawRight;
    top = rawTop;
    bottom = rawBottom;
  }

  const rawWidth = right - left + 1;
  const rawHeight = bottom - top + 1;
  const minFrac = 1 - maxTrimFraction;
  if (rawWidth < W * minFrac || rawHeight < H * minFrac) {
    return null;
  }

  const paddingX = Math.max(
    3,
    Math.ceil(rawWidth * DEFAULT_SAFE_CROP_PADDING_RATIO),
  );
  const paddingY = Math.max(
    3,
    Math.ceil(rawHeight * DEFAULT_SAFE_CROP_PADDING_RATIO),
  );
  const paddedLeft = Math.max(0, left - paddingX);
  const paddedTop = Math.max(0, top - paddingY);
  const paddedRight = Math.min(W - 1, right + paddingX);
  const paddedBottom = Math.min(H - 1, bottom + paddingY);
  const width = paddedRight - paddedLeft + 1;
  const height = paddedBottom - paddedTop + 1;

  if (width < 8 || height < 8) return null;
  if (width >= W * 0.985 && height >= H * 0.985) return null;

  return {
    left: paddedLeft,
    top: paddedTop,
    width,
    height,
    rawWidth,
    rawHeight,
    contentPixels,
  };
}

/**
 * Conservative packshot edge trim: detect a content box from alpha/background contrast,
 * add a small safety pad, then crop with sanity checks.
 * On any doubt returns `{ ok: false }` — caller must pass through original bytes.
 */
export async function trimPackshotBuffer(
  input: Buffer,
  options: TrimPackshotOptions,
): Promise<TrimPackshotResult> {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
  const trimThreshold = options.trimThreshold ?? DEFAULT_TRIM_THRESHOLD;
  const maxTrimFraction = options.maxTrimFraction ?? DEFAULT_MAX_TRIM_FRACTION;
  const log = options.log;

  if (input.length > maxInputBytes) {
    log?.debug(
      { len: input.length, maxInputBytes },
      "packshot-trim: skip oversized input",
    );
    return { ok: false, reason: "oversized_input" };
  }

  let meta0: sharp.Metadata;
  try {
    meta0 = await sharp(input).metadata();
  } catch {
    return { ok: false, reason: "metadata_failed" };
  }

  if (!meta0.width || !meta0.height) {
    return { ok: false, reason: "missing_dimensions" };
  }

  if (meta0.format === "svg") {
    return { ok: false, reason: "svg_pass_through" };
  }

  let work: Buffer = input;
  try {
    const maxDim = Math.max(meta0.width, meta0.height);
    let pipeline = sharp(input, { failOn: "truncated" }).rotate();
    if (maxDim > maxLongEdge) {
      pipeline = pipeline.resize(maxLongEdge, maxLongEdge, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    work = await pipeline.toBuffer();
  } catch {
    return { ok: false, reason: "resize_failed" };
  }

  let before: sharp.Metadata;
  try {
    before = await sharp(work).metadata();
  } catch {
    return { ok: false, reason: "work_metadata_failed" };
  }

  const W = before.width!;
  const H = before.height!;

  let bg: { r: number; g: number; b: number };
  try {
    bg = await resolveBackground(options.background, work);
  } catch {
    return { ok: false, reason: "background_sample_failed" };
  }

  let crop: CropBox | null;
  try {
    crop = await detectContentCropBox(work, bg, trimThreshold, maxTrimFraction);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.debug({ err: msg }, "packshot-trim: crop detection failed");
    return { ok: false, reason: "crop_detection_failed" };
  }

  if (!crop) {
    log?.debug(
      { W, H },
      "packshot-trim: no reliable content crop, passthrough original",
    );
    return { ok: false, reason: "no_reliable_crop" };
  }

  let outBuf: Buffer;
  try {
    let pipeline = sharp(work).extract({
      left: crop.left,
      top: crop.top,
      width: crop.width,
      height: crop.height,
    });

    if (options.output.format === "png") {
      if (options.output.ensureAlpha) pipeline = pipeline.ensureAlpha();
      outBuf = await pipeline.png().toBuffer();
    } else {
      const q = options.output.quality ?? 85;
      pipeline = pipeline.flatten({ background: bg });
      outBuf = await pipeline.jpeg({ quality: q, mozjpeg: true }).toBuffer();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.debug({ err: msg }, "packshot-trim: sharp pipeline failed");
    return { ok: false, reason: "pipeline_failed" };
  }

  let after: sharp.Metadata;
  try {
    after = await sharp(outBuf).metadata();
  } catch {
    return { ok: false, reason: "output_metadata_failed" };
  }

  if (!after.width || !after.height) {
    return { ok: false, reason: "output_missing_dimensions" };
  }

  if (after.width === W && after.height === H) {
    log?.debug(
      { W, H },
      "packshot-trim: no border removed, passthrough original",
    );
    return { ok: false, reason: "no_trim_benefit" };
  }

  const minFrac = 1 - maxTrimFraction;
  if (after.width < W * minFrac || after.height < H * minFrac) {
    log?.debug(
      { W, H, outW: after.width, outH: after.height, minFrac },
      "packshot-trim: skip suspicious aggressive trim",
    );
    return { ok: false, reason: "trim_too_aggressive" };
  }

  const contentType =
    options.output.format === "png" ? "image/png" : "image/jpeg";

  log?.info(
    {
      inW: W,
      inH: H,
      outW: after.width,
      outH: after.height,
      rawCropW: crop.rawWidth,
      rawCropH: crop.rawHeight,
      contentPixels: crop.contentPixels,
      contentType,
      background: options.background === "corners" ? "corners" : "fixed",
    },
    "packshot-trim: applied",
  );

  return {
    ok: true,
    buffer: outBuf,
    contentType,
    inW: W,
    inH: H,
    outW: after.width,
    outH: after.height,
  };
}

/** `/api/image-proxy?trim=1` — JPEG output for browsers. */
export async function trimPackshotForImageProxy(
  input: Buffer,
  log?: PackshotTrimLog,
): Promise<
  { ok: true; buffer: Buffer; contentType: "image/jpeg" } | { ok: false }
> {
  const r = await trimPackshotBuffer(input, {
    background: "corners",
    output: { format: "jpeg", quality: 85 },
    log,
  });
  if (!r.ok) return { ok: false };
  return { ok: true, buffer: r.buffer, contentType: "image/jpeg" };
}

/**
 * BG removal fallback pipeline — same guards as proxy; PNG with alpha for bottle canvas normalize.
 * Returns `null` when trim should be skipped (use original buffer into canvas normalize).
 */
export async function trimPackshotForBgService(
  input: Buffer,
  log?: PackshotTrimLog,
): Promise<Buffer | null> {
  const r = await trimPackshotBuffer(input, {
    background: "corners",
    output: { format: "png", ensureAlpha: true },
    log,
  });
  return r.ok ? r.buffer : null;
}
