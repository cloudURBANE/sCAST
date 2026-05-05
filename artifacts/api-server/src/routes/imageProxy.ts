import { Router } from "express";
import axios from "axios";
import { logger } from "../lib/logger";
import { trimPackshotForImageProxy } from "../services/packshotTrim";

const router = Router();

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function wantsPackshotTrim(req: { query: Record<string, unknown> }): boolean {
  const v = req.query.trim;
  if (typeof v === "string") return v === "1" || /^true$/i.test(v);
  if (Array.isArray(v) && typeof v[0] === "string") return v[0] === "1" || /^true$/i.test(v[0]);
  return false;
}

router.get("/image-proxy", async (req, res) => {
  const { url } = req.query as { url?: string };
  const doTrim = wantsPackshotTrim(req);

  if (!url) {
    res.status(400).json({ error: "url query param is required" });
    return;
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid url" });
    return;
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    res.status(400).json({ error: "Only http/https URLs are allowed" });
    return;
  }

  try {
    const upstream = await axios.get(target.toString(), {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": BROWSER_UA,
        "Referer": target.origin + "/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      maxRedirects: 5,
      timeout: 10000,
      validateStatus: (s) => s < 400,
    });

    const rawCt = upstream.headers["content-type"];
    const contentType: string =
      typeof rawCt === "string"
        ? rawCt
        : Array.isArray(rawCt)
          ? String(rawCt[0] ?? "image/jpeg")
          : "image/jpeg";
    if (!contentType.startsWith("image/")) {
      res.status(400).json({ error: "URL does not point to an image" });
      return;
    }

    let body = Buffer.from(upstream.data);
    let outType = contentType;

    if (doTrim) {
      const trimmed = await trimPackshotForImageProxy(body);
      if (trimmed.ok) {
        body = trimmed.buffer;
        outType = trimmed.contentType;
      } else {
        logger.debug({ url: String(url).slice(0, 120) }, "image-proxy: packshot trim skipped, passthrough");
      }
    }

    res.setHeader("Content-Type", outType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(body);
  } catch (err: any) {
    logger.error({ err: err.message, url }, "image-proxy: fetch failed");
    res.status(502).json({ error: "Failed to fetch image" });
  }
});

export default router;
