import sharp from "sharp";

/** Bump when trim logic changes (e.g. for cache keys). */
export const PACKSHOT_TRIM_VERSION = 4;

const DEFAULT_MAX_INPUT_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_LONG_EDGE = 4096;
// 60 (up from 40) tolerates JPEG edge compression noise around high-contrast
// packshot borders — the lower value was sampling chroma artefacts inside the
// "background" ring and leaving a 1–2px white halo around the trimmed bottle.
const DEFAULT_TRIM_THRESHOLD = 60;
/**
 * Allow tightly-trimming heavy vendor padding (the bottle itself defines the
 * lower bound — Sharp's color trim stops at the first contrasting pixel, so it
 * cannot crop into the bottle even when the trim ratio is large).
 */
const DEFAULT_MAX_TRIM_FRACTION = 0.985;
/** Pixels with alpha at-or-below this are treated as fully transparent. */
const ALPHA_TRANSPARENT_CUTOFF = 8;
/** A corner is "mostly transparent" if it averages below this alpha. */
const CORNER_TRANSPARENT_AVG = 32;

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

/** Median of the outer edge ring on a downscaled raster — stable vs one bad corner. */
async function sampleEdgeBackground(
  buf: Buffer,
): Promise<{ rgb: Rgb; cornerAlphaAvg: number }> {
  const { data, info } = await sharp(buf)
    .resize(96, 96, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const c = info.channels;
  const rgbPoints: Array<readonly [number, number, number]> = [];
  const alphaPoints: number[] = [];
  const add = (x: number, y: number) => {
    const xi = Math.min(Math.max(0, x), w - 1);
    const yi = Math.min(Math.max(0, y), h - 1);
    const i = (yi * w + xi) * c;
    const alpha = c >= 4 ? (data[i + 3] ?? 255) : 255;
    alphaPoints.push(alpha);
    if (alpha <= ALPHA_TRANSPARENT_CUTOFF) return;
    rgbPoints.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0] as const);
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

  const median1 = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };

  const cornerAlphaAvg =
    alphaPoints.length === 0
      ? 255
      : alphaPoints.reduce((a, b) => a + b, 0) / alphaPoints.length;

  if (rgbPoints.length === 0) {
    return { rgb: { r: 255, g: 255, b: 255 }, cornerAlphaAvg };
  }

  return {
    rgb: {
      r: median1(rgbPoints.map((p) => p[0])),
      g: median1(rgbPoints.map((p) => p[1])),
      b: median1(rgbPoints.map((p) => p[2])),
    },
    cornerAlphaAvg,
  };
}

async function resolveBackground(
  mode: PackshotTrimBg,
  work: Buffer,
): Promise<{ rgb: Rgb; cornerAlphaAvg: number }> {
  if (mode === "corners") return sampleEdgeBackground(work);
  // Caller pinned a background — corners alpha unknown, assume opaque.
  return { rgb: mode, cornerAlphaAvg: 255 };
}

/**
 * Conservative packshot edge trim: Sharp native `.trim()` against either the
 * sampled corner background or the alpha channel for transparent canvases.
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
  const inputHasAlpha = before.hasAlpha === true;

  let bgInfo: { rgb: Rgb; cornerAlphaAvg: number };
  try {
    bgInfo = await resolveBackground(options.background, work);
  } catch {
    return { ok: false, reason: "background_sample_failed" };
  }

  // Decide trim background. If the input has a transparent canvas (alpha at
  // the corners is mostly zero), trim by alpha. Otherwise trim by the sampled
  // RGB background. Sharp's color trim stops at the first contrasting pixel
  // so it cannot crop into the bottle.
  const trimByAlpha =
    inputHasAlpha && bgInfo.cornerAlphaAvg <= CORNER_TRANSPARENT_AVG;
  const trimBackground: { r: number; g: number; b: number; alpha: number } =
    trimByAlpha
      ? { r: 0, g: 0, b: 0, alpha: 0 }
      : { ...bgInfo.rgb, alpha: 1 };

  let outBuf: Buffer;
  try {
    let pipeline = sharp(work).trim({
      background: trimBackground,
      threshold: trimThreshold,
    });

    if (options.output.format === "png") {
      if (options.output.ensureAlpha) pipeline = pipeline.ensureAlpha();
      outBuf = await pipeline.png().toBuffer();
    } else {
      const q = options.output.quality ?? 85;
      // JPEG can't represent alpha — flatten onto the sampled RGB so corners
      // match the original canvas color.
      pipeline = pipeline.flatten({ background: bgInfo.rgb });
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
      trimByAlpha,
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
