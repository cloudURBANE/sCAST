import axios from "axios";
import sharp from "sharp";
import { logger } from "../lib/logger";
import { trimPackshotForBgService } from "./packshotTrim";

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
  try {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("image_file", buffer, { filename: "image.jpg", contentType: "image/jpeg" });
    Object.entries(baseParams()).forEach(([k, v]) => form.append(k, v));
    if (opts?.poofType === "product") {
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
}

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.google.com/",
      },
    });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

export async function removeBg(input: string, isUrl = false, opts?: RemoveBgOptions) {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  const toDataUri = (buf: Buffer) => `data:image/png;base64,${buf.toString("base64")}`;

  // --- Handle base64 / data URI inputs (never cached — no stable key) ---
  if (!isUrl || input.startsWith("data:")) {
    const b64 = input.startsWith("data:") ? input.split(",")[1] : null;
    if (!b64) return { cleanImage: input };

    if (!apiKey) {
      const normalized = await trimWhiteAndNormalize(Buffer.from(b64, "base64"));
      return { cleanImage: toDataUri(normalized) };
    }

    const result = await removeBgByFile(Buffer.from(b64, "base64"), apiKey, opts);
    if (result) {
      const padded = await normalizeToBottleCanvas(result);
      return { cleanImage: toDataUri(padded) };
    }

    const normalized = await trimWhiteAndNormalize(Buffer.from(b64, "base64"));
    return { cleanImage: toDataUri(normalized) };
  }

  // --- Handle http/https URL inputs ---

  if (!apiKey) {
    const raw = await downloadImage(input);
    if (raw) {
      const normalized = await trimWhiteAndNormalize(raw);
      return { cleanImage: toDataUri(normalized) };
    }
    return { cleanImage: input };
  }

  // Strategy 1: download ourselves, send as binary file to Poof API
  const raw = await downloadImage(input);
  if (!raw) return { cleanImage: input };

  const byFile = await removeBgByFile(raw, apiKey, opts);
  if (byFile) {
    const padded = await normalizeToBottleCanvas(byFile);
    return { cleanImage: toDataUri(padded) };
  }

  // Strategy 2: local white-trim normalization as last resort
  logger.warn("[bgService] Poof remove failed; using local normalization fallback");
  const normalized = await trimWhiteAndNormalize(raw);
  return { cleanImage: toDataUri(normalized) };
}
