import sharp from "sharp";

/** Bump when trim logic changes (e.g. for cache keys). */
export const PACKSHOT_TRIM_VERSION = 1;

const DEFAULT_MAX_INPUT_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_LONG_EDGE = 4096;
const DEFAULT_TRIM_THRESHOLD = 40;
/** If trimmed width/height is smaller than this fraction of the working image, treat as over-trim and abort. */
const DEFAULT_MAX_TRIM_FRACTION = 0.42;

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

async function sampleCornerBackground(buf: Buffer): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(buf)
    .resize(64, 64, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const c = info.channels;
  const sample = (x: number, y: number) => {
    const xi = Math.min(Math.max(0, x), w - 1);
    const yi = Math.min(Math.max(0, y), h - 1);
    const i = (yi * w + xi) * c;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0] as const;
  };

  const corners = [sample(0, 0), sample(w - 1, 0), sample(0, h - 1), sample(w - 1, h - 1)];
  const median1 = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };

  return {
    r: median1(corners.map((p) => p[0])),
    g: median1(corners.map((p) => p[1])),
    b: median1(corners.map((p) => p[2])),
  };
}

function resolveBackground(mode: PackshotTrimBg, work: Buffer): Promise<{ r: number; g: number; b: number }> {
  if (mode === "corners") return sampleCornerBackground(work);
  return Promise.resolve(mode);
}

/**
 * Conservative packshot edge trim: flatten to a reference background, Sharp trim, sanity checks.
 * On any doubt returns `{ ok: false }` — caller must pass through original bytes.
 */
export async function trimPackshotBuffer(input: Buffer, options: TrimPackshotOptions): Promise<TrimPackshotResult> {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
  const trimThreshold = options.trimThreshold ?? DEFAULT_TRIM_THRESHOLD;
  const maxTrimFraction = options.maxTrimFraction ?? DEFAULT_MAX_TRIM_FRACTION;
  const log = options.log;

  if (input.length > maxInputBytes) {
    log?.debug({ len: input.length, maxInputBytes }, "packshot-trim: skip oversized input");
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
    if (maxDim > maxLongEdge) {
      work = await sharp(input)
        .resize(maxLongEdge, maxLongEdge, { fit: "inside", withoutEnlargement: true })
        .toBuffer();
    }
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

  let outBuf: Buffer;
  try {
    let pipeline = sharp(work).flatten({ background: bg }).trim({ threshold: trimThreshold, background: bg });

    if (options.output.format === "png") {
      if (options.output.ensureAlpha) pipeline = pipeline.ensureAlpha();
      outBuf = await pipeline.png().toBuffer();
    } else {
      const q = options.output.quality ?? 85;
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

  const minFrac = 1 - maxTrimFraction;
  if (after.width < W * minFrac || after.height < H * minFrac) {
    log?.debug(
      { W, H, outW: after.width, outH: after.height, minFrac },
      "packshot-trim: skip suspicious aggressive trim",
    );
    return { ok: false, reason: "trim_too_aggressive" };
  }

  const contentType = options.output.format === "png" ? "image/png" : "image/jpeg";

  log?.info(
    {
      inW: W,
      inH: H,
      outW: after.width,
      outH: after.height,
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
): Promise<{ ok: true; buffer: Buffer; contentType: "image/jpeg" } | { ok: false }> {
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
export async function trimPackshotForBgService(input: Buffer, log?: PackshotTrimLog): Promise<Buffer | null> {
  const r = await trimPackshotBuffer(input, {
    background: { r: 255, g: 255, b: 255 },
    output: { format: "png", ensureAlpha: true },
    log,
  });
  return r.ok ? r.buffer : null;
}
