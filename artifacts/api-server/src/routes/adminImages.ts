import express, { Router } from "express";
import { AuthRequest, requireAdmin, requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import {
  BackgroundRemovalFailedError,
  processAdminBottleImage,
} from "../services/adminBottleImageUpload";
import type { RemoveBgReason } from "../services/bgService";
import { ImageObjectStorageConfigurationError } from "../services/imageObjectStorage";
import { fetchExternalImage } from "../services/safeImageFetch";
import { extractImageUrlsFromSourcePage } from "../services/sourcePageImage";

const router = Router();

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // 12MB — pre-resize source headroom.
// Content types we accept as a raw binary body. `application/octet-stream` lets
// a browser `fetch(file)` work even when the File has no/odd MIME type.
const RAW_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/octet-stream",
];

function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

// Background removal can fall short for several distinct reasons (service down,
// out of credits, rate-limited, oversized source, or a photo the cut-out model
// genuinely can't isolate). The SPA surfaces this route's `error` string
// verbatim and ignores `reason`, so historically every cause collapsed into one
// opaque "didn't succeed" message — leaving the admin (and us) unable to tell an
// ops problem (key/credits) from a bad-source problem. Map each reason to an
// actionable message so the cause is legible; `reason` is still returned in the
// JSON for programmatic callers/logs.
const UNCHECK_HINT =
  "Uncheck “Remove background” to upload it as-is, or try a cleaner source photo.";

function backgroundRemovalFailureMessage(reason: RemoveBgReason): string {
  switch (reason) {
    case "missing_api_key":
      return `Background removal is unavailable — the removal service isn't configured on this server. ${UNCHECK_HINT}`;
    case "poof_unauthorized":
      return `The background-removal service rejected the request (key unauthorized or out of credits). ${UNCHECK_HINT}`;
    case "poof_rate_limited":
      return `The background-removal service is rate-limited right now. Wait a moment and try again. ${UNCHECK_HINT}`;
    case "poof_payload_too_large":
      return `This image is too large for background removal. Use a smaller source image. ${UNCHECK_HINT}`;
    case "poof_server_error":
    case "poof_non_200":
      return `The background-removal service had a transient error. Try again in a moment. ${UNCHECK_HINT}`;
    case "poof_empty_output":
      return `Background removal returned an empty (fully transparent) result — the model couldn't isolate the bottle in this source. ${UNCHECK_HINT}`;
    case "poof_white_background":
      return `Background removal left the original backdrop in place for this source. Try a photo of the bottle on a plain background. ${UNCHECK_HINT}`;
    default:
      return `Background removal didn't succeed for this image. The original was kept — ${UNCHECK_HINT}`;
  }
}

/**
 * Admin-only bottle-image replacement.
 *
 * Two body shapes (gated by `requireAuth` + `requireAdmin`):
 *  - Raw binary file: `Content-Type: image/*` (or octet-stream); brand/name/
 *    removeBackground/fragranceId come from the query string.
 *  - JSON `{ imageUrl, brand, name, removeBackground?, fragranceId? }`: the URL
 *    is fetched server-side (SSRF-safe `fetchExternalImage`) and re-hosted.
 *
 * Returns `{ imageUrl, imageHash, backgroundRemoved }`. The SPA then persists
 * `imageUrl` through the existing `PATCH /api/wardrobe/:id` flow — this route
 * never writes to user_fragrances itself.
 */
router.post(
  "/admin/bottle-image/upload",
  requireAuth,
  requireAdmin,
  express.raw({ type: RAW_IMAGE_TYPES, limit: MAX_UPLOAD_BYTES }),
  async (req: AuthRequest, res) => {
    const user = req.user!;

    let buffer: Buffer | null = null;
    let brand: string;
    let name: string;
    let removeBackground: boolean;
    let fragranceId: string | null;

    try {
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        // Raw binary file upload.
        buffer = req.body;
        brand = firstQueryValue(req.query.brand).trim();
        name = firstQueryValue(req.query.name).trim();
        removeBackground = firstQueryValue(req.query.removeBackground) === "true";
        const qid = firstQueryValue(req.query.fragranceId).trim();
        fragranceId = qid || null;
      } else {
        // JSON `{ imageUrl, ... }` paste-URL path.
        const body = (req.body ?? {}) as Record<string, unknown>;
        brand = typeof body.brand === "string" ? body.brand.trim() : "";
        name = typeof body.name === "string" ? body.name.trim() : "";
        removeBackground = body.removeBackground === true;
        fragranceId = typeof body.fragranceId === "string" && body.fragranceId.trim()
          ? body.fragranceId.trim()
          : null;
        const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
        const sourcePageUrl = typeof body.sourcePageUrl === "string" ? body.sourcePageUrl.trim() : "";
        if (!imageUrl && !sourcePageUrl) {
          res.status(400).json({ error: "Provide an image file, imageUrl, or sourcePageUrl" });
          return;
        }
        try {
          let resolvedImageUrl = imageUrl;
          if (sourcePageUrl) {
            const extracted = await extractImageUrlsFromSourcePage(sourcePageUrl);
            resolvedImageUrl = extracted.imageUrls[0];
            if (!resolvedImageUrl) {
              res.status(400).json({ error: "No usable image found on the source page" });
              return;
            }
          }
          const downloaded = await fetchExternalImage(resolvedImageUrl);
          buffer = downloaded.buffer;
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "[admin-upload] could not fetch image URL",
          );
          res.status(400).json({ error: err instanceof Error ? err.message : "Could not fetch that image URL" });
          return;
        }
      }

      if (!buffer || buffer.length === 0) {
        res.status(400).json({ error: "No image data received" });
        return;
      }
      if (!brand || !name) {
        res.status(400).json({ error: "brand and name are required" });
        return;
      }

      const result = await processAdminBottleImage({
        buffer,
        brand,
        name,
        removeBackground,
        userId: user.id,
        fragranceId,
      });

      res.json({
        imageUrl: result.imageUrl,
        imageHash: result.imageHash,
        backgroundRemoved: result.backgroundRemoved,
      });
    } catch (err) {
      if (err instanceof BackgroundRemovalFailedError) {
        logger.warn(
          { reason: err.reason },
          "[admin-upload] background removal did not succeed",
        );
        res.status(422).json({
          error: backgroundRemovalFailureMessage(err.reason),
          reason: err.reason,
        });
        return;
      }
      if (err instanceof ImageObjectStorageConfigurationError) {
        res.status(503).json({ error: "Image storage is not configured on this server" });
        return;
      }
      const message = err instanceof Error ? err.message : "Upload failed";
      logger.error({ err: message }, "[admin-upload] bottle image upload failed");
      // A decode/validation message is safe to surface; anything else is generic.
      const clientMessage = message === "Unsupported or corrupt image file" ? message : "Upload failed";
      res.status(message === "Unsupported or corrupt image file" ? 400 : 500).json({ error: clientMessage });
    }
  },
);

export default router;
