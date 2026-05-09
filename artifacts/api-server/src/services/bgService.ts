import axios from "axios";
import sharp from "sharp";
import { logger } from "../lib/logger";
import { isEffectivelyTransparent } from "./bgServiceCore";
import { trimPackshotForBgService } from "./packshotTrim";
import { fetchExternalImage } from "./safeImageFetch";

export { isEffectivelyTransparent };

const POOF_API = "https://api.poof.bg/v1/remove";
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
  | "local_trim_fallback";

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

export async function removeBgBuffer(
  rawInput: Buffer,
  opts?: RemoveBgOptions,
): Promise<RemoveBgBufferResult> {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    const normalized = await trimWhiteAndNormalize(rawInput);
    return { buffer: normalized, contentType: "image/png", backgroundRemoved: false, removeBgStatus: "skipped", removeBgReason: "missing_api_key" };
  }

  const result = await removeBgByFile(rawInput, apiKey, opts);
  if (result.ok) {
    const padded = await normalizeToBottleArtwork(result.buffer);
    return { buffer: padded, contentType: "image/png", backgroundRemoved: true, removeBgStatus: "removed", removeBgReason: "removed" };
  }

  const normalized = await trimWhiteAndNormalize(rawInput);
  return { buffer: normalized, contentType: "image/png", backgroundRemoved: false, removeBgStatus: "fallback", removeBgReason: result.reason };
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
