import axios from "axios";
import sharp from "sharp";
import { logger } from "../lib/logger";
import { KeyPool, registerKeyPool } from "../lib/keyPool";
import { hasOpaqueLightBackground, isEffectivelyTransparent } from "./bgServiceCore";
import { localWhiteChromaKey } from "./localChromaKey";
import { trimPackshotForBgService } from "./packshotTrim";
import { fetchExternalImage } from "./safeImageFetch";

export { isEffectivelyTransparent };

const POOF_API = "https://api.poof.bg/v1/remove";

// Pool of Poof background-removal keys. Prefer the plural REMOVE_BG_API_KEYS
// (comma-separated pool) and fall back to the legacy single REMOVE_BG_API_KEY.
// Lazily built so dotenv has loaded by first use.
let removeBgPool: KeyPool | null = null;
export function getRemoveBgPool(): KeyPool {
  if (!removeBgPool) {
    removeBgPool = registerKeyPool(
      KeyPool.fromEnv("removebg", [process.env.REMOVE_BG_API_KEYS, process.env.REMOVE_BG_API_KEY]),
    );
  }
  return removeBgPool;
}

const NORMALIZED_LONG_EDGE = 768;
const EDGE_PADDING_X = 30;
const EDGE_PADDING_TOP = 34;
const EDGE_PADDING_BOTTOM = 26;
const CONTENT_LONG_EDGE =
  NORMALIZED_LONG_EDGE -
  Math.max(EDGE_PADDING_X * 2, EDGE_PADDING_TOP + EDGE_PADDING_BOTTOM);

async function normalizeToBottleArtwork(buffer: Buffer): Promise<Buffer> {
  try {
    const resized = await sharp(buffer)
      .rotate()
      .resize(CONTENT_LONG_EDGE, CONTENT_LONG_EDGE, {
        fit: "inside",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .ensureAlpha()
      .png()
      .toBuffer();

    const meta = await sharp(resized).metadata();
    if (!meta.width || !meta.height) {
      throw new Error("normalize artwork metadata missing dimensions");
    }

    const outW = meta.width + EDGE_PADDING_X * 2;
    const outH = meta.height + EDGE_PADDING_TOP + EDGE_PADDING_BOTTOM;
    if (Math.max(outW, outH) > NORMALIZED_LONG_EDGE) {
      throw new Error(`normalize artwork too large: ${outW}x${outH}`);
    }

    return sharp(resized)
      .extend({
        top: EDGE_PADDING_TOP,
        bottom: EDGE_PADDING_BOTTOM,
        left: EDGE_PADDING_X,
        right: EDGE_PADDING_X,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  } catch {
    return sharp(buffer)
      .rotate()
      .resize(CONTENT_LONG_EDGE, CONTENT_LONG_EDGE, {
        fit: "inside",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .ensureAlpha()
      .extend({
        top: EDGE_PADDING_TOP,
        bottom: EDGE_PADDING_BOTTOM,
        left: EDGE_PADDING_X,
        right: EDGE_PADDING_X,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  }
}

async function trimWhiteAndNormalize(buffer: Buffer): Promise<Buffer> {
  try {
    const trimmed = await trimPackshotForBgService(buffer);
    if (trimmed) return await normalizeToBottleArtwork(trimmed);
  } catch {
    /* fall through */
  }
  return normalizeToBottleArtwork(buffer);
}

export async function normalizePackshotBuffer(buffer: Buffer): Promise<Buffer> {
  return trimWhiteAndNormalize(buffer);
}

function baseParams() {
  return {
    size: "full",
    format: "png",
    channels: "rgba",
  };
}

export type RemoveBgStatus = "removed" | "fallback" | "skipped";

export type RemoveBgReason =
  | "removed"
  | "skipped"
  | "skipped_by_caller"
  | "missing_api_key"
  | "poof_unauthorized"
  | "poof_rate_limited"
  | "poof_payload_too_large"
  | "poof_non_200"
  | "poof_server_error"
  | "poof_empty_output"
  | "poof_white_background"
  | "local_trim_fallback"
  | "local_chroma_key"
  | "openai_reimagine";

export type RemoveBgOptions = {
  /** Poof API removal preset when supported (e.g. product vs auto). */
  poofType?: "auto" | "product";
};

type PoofAttemptResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: RemoveBgReason; status?: number };

function mapPoofStatusToReason(status: number): RemoveBgReason {
  if (status === 401 || status === 403) return "poof_unauthorized";
  if (status === 429) return "poof_rate_limited";
  if (status === 413) return "poof_payload_too_large";
  return "poof_non_200";
}

async function removeBgByFile(buffer: Buffer, apiKey: string, opts?: RemoveBgOptions): Promise<PoofAttemptResult> {
  const post = async (o?: RemoveBgOptions): Promise<PoofAttemptResult> => {
    try {
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      // Always convert to PNG before upload: Poof reliably supports PNG, and
      // sending WebP/unknown formats can cause Poof to return transparent output.
      const uploadBuffer = await sharp(buffer).ensureAlpha().png().toBuffer();
      form.append("image_file", uploadBuffer, { filename: "image.png", contentType: "image/png" });
      Object.entries(baseParams()).forEach(([k, v]) => form.append(k, v));
      if (o?.poofType === "product") {
        form.append("type", "product");
      }

      const res = await axios.post(POOF_API, form, {
        headers: { ...form.getHeaders(), "x-api-key": apiKey },
        responseType: "arraybuffer",
        timeout: 25000,
        validateStatus: (s) => s < 500,
      });

      if (res.status === 200) {
        const poofBuffer = Buffer.from(res.data);
        // Hard guard: never treat a fully-transparent Poof response as a
        // success. If we did, the pipeline would persist an invisible WebP
        // and the user would see an empty tile in the wardrobe/share grid.
        if (await isEffectivelyTransparent(poofBuffer)) {
          logger.warn(
            { reason: "poof_empty_output", poofType: o?.poofType ?? null },
            "[bgService] Poof returned a fully transparent image; treating as failure",
          );
          return { ok: false, reason: "poof_empty_output", status: 200 };
        }
        if (o?.poofType === "product" && (await hasOpaqueLightBackground(poofBuffer))) {
          logger.warn(
            { reason: "poof_white_background", poofType: o.poofType },
            "[bgService] Poof type=product preserved an opaque light background; retrying fallback path",
          );
          return { ok: false, reason: "poof_white_background", status: 200 };
        }
        return { ok: true, buffer: poofBuffer };
      }

      const reason = mapPoofStatusToReason(res.status);
      logger.warn({ status: res.status, reason, poofType: o?.poofType ?? null }, "[bgService] Poof background removal returned non-200");
      return { ok: false, reason, status: res.status };
    } catch (error) {
      logger.warn({ reason: "poof_server_error", poofType: o?.poofType ?? null, message: error instanceof Error ? error.message : String(error) }, "[bgService] Poof background removal failed");
      return { ok: false, reason: "poof_server_error" };
    }
  };

  if (opts?.poofType === "product") {
    const withType = await post(opts);
    if (withType.ok) return withType;
    logger.warn("[bgService] Poof type=product failed or non-200; retrying without type");
  }
  return post(undefined);
}

function decodeDataImage(input: string): Buffer | null {
  if (!input.startsWith("data:image/")) return null;
  const match = input.match(/^data:image\/(?:png|jpe?g|webp);base64,([a-z0-9+/=]+)$/i);
  if (!match?.[1]) return null;
  if (match[1].length > 6_000_000) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    return (await fetchExternalImage(url)).buffer;
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[bgService] safe image download rejected");
    return null;
  }
}

export type RemoveBgBufferResult = {
  buffer: Buffer;
  contentType: "image/png";
  backgroundRemoved: boolean;
  removeBgStatus: RemoveBgStatus;
  removeBgReason: RemoveBgReason;
};

// Local, API-free cut-out for sources on a flat near-white plate. Returns a
// genuine transparent packshot (status "removed") when the edge-connected chroma
// key succeeds, or null when the source is not on an opaque light background or
// the heuristic declines — in which case the caller keeps its trim fallback.
async function tryLocalChromaKey(rawInput: Buffer): Promise<RemoveBgBufferResult | null> {
  try {
    if (!(await hasOpaqueLightBackground(rawInput))) return null;
    const keyed = await localWhiteChromaKey(rawInput);
    if (!keyed) return null;
    const padded = await normalizeToBottleArtwork(keyed.buffer);
    logger.info(
      { removedFraction: Number(keyed.removedFraction.toFixed(3)) },
      "[bgService] local white chroma-key produced a transparent cut-out",
    );
    return {
      buffer: padded,
      contentType: "image/png",
      backgroundRemoved: true,
      removeBgStatus: "removed",
      removeBgReason: "local_chroma_key",
    };
  } catch (error) {
    logger.warn(
      { message: error instanceof Error ? error.message : String(error) },
      "[bgService] local chroma-key failed; using border-trim fallback",
    );
    return null;
  }
}

export async function removeBgBuffer(
  rawInput: Buffer,
  opts?: RemoveBgOptions,
): Promise<RemoveBgBufferResult> {
  const pool = getRemoveBgPool();
  if (pool.size === 0) {
    const keyed = await tryLocalChromaKey(rawInput);
    if (keyed) return keyed;
    const normalized = await trimWhiteAndNormalize(rawInput);
    return { buffer: normalized, contentType: "image/png", backgroundRemoved: false, removeBgStatus: "skipped", removeBgReason: "missing_api_key" };
  }

  // Carry the most recent per-key failure reason so the fallback result reports
  // why removal didn't happen (rate-limit, unauthorized, server error, …).
  let lastReason: RemoveBgReason = "poof_non_200";
  const outcome = await pool.run<Buffer>(async (apiKey, label) => {
    const result = await removeBgByFile(rawInput, apiKey, opts);
    if (result.ok) return { ok: true, value: result.buffer };

    lastReason = result.reason;
    if (result.reason === "poof_rate_limited") {
      logger.warn({ key: label }, "[bgService] key rate-limited (429); rotating to next key");
      return { ok: false, action: "cooldown" };
    }
    if (result.reason === "poof_unauthorized") {
      logger.warn({ key: label }, "[bgService] key unauthorized / out of credits; retiring");
      return { ok: false, action: "retire" };
    }
    // Payload too large, empty/transparent output, preserved white background,
    // server error, other non-200: not a key-quota problem, so rotating to
    // another key won't help. Stop and fall back to local trim.
    return { ok: false, action: "stop" };
  });

  if (outcome.ok) {
    const padded = await normalizeToBottleArtwork(outcome.value);
    return { buffer: padded, contentType: "image/png", backgroundRemoved: true, removeBgStatus: "removed", removeBgReason: "removed" };
  }

  // Poof failed/fell through. Before settling for a border-trimmed image that
  // still carries the white plate, attempt a local chroma-key cut-out when the
  // source is on an opaque light background.
  const keyed = await tryLocalChromaKey(rawInput);
  if (keyed) return keyed;

  const normalized = await trimWhiteAndNormalize(rawInput);
  return { buffer: normalized, contentType: "image/png", backgroundRemoved: false, removeBgStatus: "fallback", removeBgReason: lastReason };
}

export async function removeBgToBuffer(
  input: string,
  isUrl = false,
  opts?: RemoveBgOptions,
): Promise<RemoveBgBufferResult | null> {
  // Data URI support is only for explicit preview processing. It never becomes
  // a persisted database source URL.
  if (!isUrl || input.startsWith("data:")) {
    const rawInput = decodeDataImage(input);
    if (!rawInput) return null;
    return removeBgBuffer(rawInput, opts);
  }

  const raw = await downloadImage(input);
  if (!raw) return null;
  return removeBgBuffer(raw, opts);
}
