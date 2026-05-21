import { Router } from "express";
import { logger } from "../lib/logger";
import { trimPackshotForImageProxy } from "../services/packshotTrim";
import { fetchExternalImage, parseAndValidateExternalImageUrl } from "../services/safeImageFetch";

const router = Router();

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
    target = parseAndValidateExternalImageUrl(url);
  } catch {
    res.status(400).json({ error: "Invalid url" });
    return;
  }

  try {
    const upstream = await fetchExternalImage(target.toString());
    let body = upstream.buffer;
    let outType = upstream.contentType;

    // Skip JPEG packshot trim for images that are already processed transparent
    // WebPs from our own pipeline. Trim re-encodes to JPEG, which would flatten
    // alpha onto white and undo background removal in the UI.
    const isWebp = outType === "image/webp";
    const isGif = outType === "image/gif";
    const isProcessedObject = target.toString().includes("/images/processed/");
    if (doTrim && !isWebp && !isGif && !isProcessedObject) {
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
