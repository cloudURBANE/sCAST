import { Router } from "express";
import axios from "axios";
import { logger } from "../lib/logger";

const router = Router();

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

router.get("/image-proxy", async (req, res) => {
  const { url } = req.query as { url?: string };

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

    const contentType: string = upstream.headers["content-type"] ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      res.status(400).json({ error: "URL does not point to an image" });
      return;
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(Buffer.from(upstream.data));
  } catch (err: any) {
    logger.error({ err: err.message, url }, "image-proxy: fetch failed");
    res.status(502).json({ error: "Failed to fetch image" });
  }
});

export default router;
