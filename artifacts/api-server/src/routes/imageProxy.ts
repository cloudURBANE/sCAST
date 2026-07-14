import { Router } from "express";
import { logger } from "../lib/logger";
import { trimPackshotForImageProxy } from "../services/packshotTrim";
import {
  cacheControlForImageTarget,
  ImageProxyAbortedError,
  imageProxyCache,
  imageProxyCacheKey,
  ImageProxyQueueFullError,
  type ImageProxyPayload,
} from "../services/imageProxyCache";
import { fetchExternalImage, parseAndValidateExternalImageUrl } from "../services/safeImageFetch";
import { getImageObjectStorage, processedStoragePathFromUrl } from "../services/imageObjectStorage";

const router = Router();

/**
 * For one of our own processed objects, read the bytes via AUTHENTICATED provider
 * access (service account / service-role key / local FS) keyed on the recovered
 * `images/processed/...` path. This serves the image same-origin even when the
 * recorded public URL is unreachable from the browser (private bucket, wrong
 * public host, missing download token, CORS/CORP). Returns null when the URL is
 * not a processed object or no provider can read it, so the caller falls back to
 * the ordinary external fetch and behavior never regresses below today.
 */
async function readProcessedObjectBytes(
  targetUrl: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const storagePath = processedStoragePathFromUrl(targetUrl);
  if (!storagePath) return null;
  try {
    const { buffer, contentType } = await getImageObjectStorage().getObjectBytes(storagePath);
    return { body: buffer, contentType };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), storagePath },
      "image-proxy: authenticated processed-object read failed; falling back to direct fetch",
    );
    return null;
  }
}

function wantsPackshotTrim(req: { query: Record<string, unknown> }): boolean {
  const v = req.query.trim;
  if (typeof v === "string") return v === "1" || /^true$/i.test(v);
  if (Array.isArray(v) && typeof v[0] === "string") return v[0] === "1" || /^true$/i.test(v[0]);
  return false;
}

function isAbortError(err: unknown): boolean {
  return err instanceof ImageProxyAbortedError ||
    (err instanceof Error && err.name === "AbortError");
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new ImageProxyAbortedError();
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

  // Key the cache + in-flight dedup on the normalized upstream URL + trim flag
  // (trim changes the bytes). The downstream Cache-Control depends only on the
  // target URL, so it is computed here and stays correct across cache hits.
  const cacheKey = imageProxyCacheKey(target.toString(), doTrim);
  const cacheControl = cacheControlForImageTarget(target);
  const clientAbort = new AbortController();
  let responseFinished = false;
  const abortClientRequest = () => {
    if (!responseFinished && !clientAbort.signal.aborted) {
      clientAbort.abort(new ImageProxyAbortedError("image-proxy client disconnected"));
    }
  };
  const abortIncompleteRequest = () => {
    if (!req.complete) abortClientRequest();
  };
  const markResponseFinished = () => {
    responseFinished = true;
  };

  req.on("aborted", abortClientRequest);
  req.on("close", abortIncompleteRequest);
  res.on("close", abortClientRequest);
  res.on("finish", markResponseFinished);

  try {
    // The client abort signal MUST reach getOrLoad: it detaches this consumer on
    // disconnect, which frees the queue slot and — once the last consumer is
    // gone — aborts the upstream fetch. Without it every disconnect listener
    // above is dead code and abandoned loads pile up behind the concurrency cap.
    const payload = await imageProxyCache.getOrLoad(
      cacheKey,
      async (signal): Promise<ImageProxyPayload> => {
        // Prefer an authenticated read for our own processed objects so a bucket
        // that is not browser-reachable (private, wrong public host, dead token,
        // CORS) still serves same-origin. Processed objects are already-normalized
        // WebPs, so the packshot-trim branch below never applies to them.
        const processed = await readProcessedObjectBytes(target.toString());
        if (processed) {
          throwIfSignalAborted(signal);
          return processed;
        }

        const upstream = await fetchExternalImage(target.toString(), { signal });
        throwIfSignalAborted(signal);
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
          throwIfSignalAborted(signal);
          if (trimmed.ok) {
            body = trimmed.buffer;
            outType = trimmed.contentType;
          } else {
            logger.debug({ url: String(url).slice(0, 120) }, "image-proxy: packshot trim skipped, passthrough");
          }
        }

        return { body, contentType: outType };
      },
      { signal: clientAbort.signal },
    );

    res.setHeader("Content-Type", payload.contentType);
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(payload.body);
  } catch (err: unknown) {
    if (err instanceof ImageProxyQueueFullError) {
      logger.warn({ url: String(url).slice(0, 120) }, "image-proxy: queue full");
      if (!res.headersSent && !res.writableEnded) {
        res.status(429).json({ error: "Image proxy is busy, retry later" });
      }
      return;
    }

    if (clientAbort.signal.aborted || isAbortError(err)) {
      logger.debug({ url: String(url).slice(0, 120) }, "image-proxy: request aborted");
      if (!res.headersSent && !res.writableEnded && !req.socket.destroyed) {
        res.status(499).end();
      }
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, url }, "image-proxy: fetch failed");
    if (!res.headersSent && !res.writableEnded) {
      res.status(502).json({ error: "Failed to fetch image" });
    }
  } finally {
    req.off("aborted", abortClientRequest);
    req.off("close", abortIncompleteRequest);
    res.off("close", abortClientRequest);
    res.off("finish", markResponseFinished);
  }
});

export default router;
