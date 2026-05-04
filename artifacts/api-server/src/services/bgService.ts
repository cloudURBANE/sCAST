import axios from "axios";
import sharp from "sharp";

const POOF_API = "https://api.poof.bg/v1/remove";

async function padAndCenter(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer)
      .resize(600, 600, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: 30, bottom: 30, left: 30, right: 30, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

async function trimWhiteAndNormalize(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .trim({ threshold: 40 })
      .resize(600, 600, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: 30, bottom: 30, left: 30, right: 30, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

function baseParams() {
  return {
    size: "full",
    format: "png",
    channels: "rgba",
  };
}

async function removeBgByFile(buffer: Buffer, apiKey: string): Promise<Buffer | null> {
  try {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("image_file", buffer, { filename: "image.jpg", contentType: "image/jpeg" });
    Object.entries(baseParams()).forEach(([k, v]) => form.append(k, v));

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

export async function removeBg(input: string, isUrl = false) {
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

    const result = await removeBgByFile(Buffer.from(b64, "base64"), apiKey);
    if (result) {
      const padded = await padAndCenter(result);
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

  const byFile = await removeBgByFile(raw, apiKey);
  if (byFile) {
    const padded = await padAndCenter(byFile);
    return { cleanImage: toDataUri(padded) };
  }

  // Strategy 2: local white-trim normalization as last resort
  const normalized = await trimWhiteAndNormalize(raw);
  return { cleanImage: toDataUri(normalized) };
}
