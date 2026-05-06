import axios from "axios";
import sharp from "sharp";
import { logger } from "../lib/logger";
import { trimPackshotForBgService } from "./packshotTrim";
import { fetchExternalImage } from "./safeImageFetch";

const POOF_API = "https://api.poof.bg/v1/remove";
const CANVAS_SIZE = 768;
const EDGE_PADDING = 30;
const CONTENT_SIZE = CANVAS_SIZE - EDGE_PADDING * 2;

async function normalizeToBottleCanvas(buffer: Buffer): Promise<Buffer> {
  try {
    const normalized = await sharp(buffer)
      .resize(CONTENT_SIZE, CONTENT_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: EDGE_PADDING, bottom: EDGE_PADDING, left: EDGE_PADDING, right: EDGE_PADDING, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "fill", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const meta = await sharp(normalized).metadata();
    if (meta.width !== CANVAS_SIZE || meta.height !== CANVAS_SIZE) {
      throw new Error(`normalize canvas mismatch: ${meta.width}x${meta.height}`);
    }

    return normalized;
  } catch {
    return sharp(buffer)
      .resize(CONTENT_SIZE, CONTENT_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: EDGE_PADDING, bottom: EDGE_PADDING, left: EDGE_PADDING, right: EDGE_PADDING, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  }
}

async function trimWhiteAndNormalize(buffer: Buffer): Promise<Buffer> {
  try {
    const trimmed = await trimPackshotForBgService(buffer);
    if (trimmed) return await normalizeToBottleCanvas(trimmed);
  } catch {
    /* fall through */
  }
  return normalizeToBottleCanvas(buffer);
}

function baseParams() {
  return {
    size: "full",
    format: "png",
    channels: "rgba",
  };
}

export type RemoveBgOptions = {
  /** Poof API removal preset when supported (e.g. product vs auto). */
  poofType?: "auto" | "product";
};

async function removeBgByFile(buffer: Buffer, apiKey: string, opts?: RemoveBgOptions): Promise<Buffer | null> {
  const post = async (o?: RemoveBgOptions): Promise<Buffer | null> => {
    try {
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      form.append("image_file", buffer, { filename: "image.jpg", contentType: "image/jpeg" });
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

      return res.status === 200 ? Buffer.from(res.data) : null;
    } catch {
      return null;
    }
  };

  if (opts?.poofType === "product") {
    const withType = await post(opts);
    if (withType) return withType;
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
};

export async function removeBgBuffer(
  rawInput: Buffer,
  opts?: RemoveBgOptions,
): Promise<RemoveBgBufferResult> {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    const normalized = await trimWhiteAndNormalize(rawInput);
    return { buffer: normalized, contentType: "image/png", backgroundRemoved: false };
  }

  const result = await removeBgByFile(rawInput, apiKey, opts);
  if (result) {
    const padded = await normalizeToBottleCanvas(result);
    return { buffer: padded, contentType: "image/png", backgroundRemoved: true };
  }

  const normalized = await trimWhiteAndNormalize(rawInput);
  return { buffer: normalized, contentType: "image/png", backgroundRemoved: false };
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
