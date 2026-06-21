import sharp from "sharp";
import { logger } from "../lib/logger";
import { removeBgBuffer, type RemoveBgReason, type RemoveBgStatus } from "./bgService";
import { getCatalogEntry, makeLookupKey, saveCatalogEntry } from "./catalogService";
import {
  buildProcessedImageStorageKey,
  hashBuffer,
  hashString,
  recordImageFailure,
  recordImageReady,
  type CachedImageReference,
} from "./imageCacheService";
import {
  ImageObjectStorageConfigurationError,
  getImageObjectStorage,
} from "./imageObjectStorage";
import { safeImageUrlForResponse } from "./persistenceGuards";

// Match the rest of the wardrobe image pipeline so an uploaded packshot frames
// and weighs the same as a Serper/reimagine result.
const MAX_OUTPUT_DIMENSION = 1024;
const WEBP_QUALITY = 90;

/**
 * Thrown when the admin explicitly asked to remove the background but the
 * removal could not be performed (no Poof key, Poof failure, source not on a
 * clean light plate). The route maps this to a 422 so the SPA keeps the
 * original image and shows a clear message instead of silently storing a
 * still-backgrounded image as if removal had worked.
 */
export class BackgroundRemovalFailedError extends Error {
  reason: RemoveBgReason;
  constructor(reason: RemoveBgReason) {
    super("Background removal did not succeed for this image");
    this.name = "BackgroundRemovalFailedError";
    this.reason = reason;
  }
}

export type AdminBottleImageUploadInput = {
  buffer: Buffer;
  brand: string;
  name: string;
  removeBackground: boolean;
  userId?: string | null;
  fragranceId?: string | null;
};

export type AdminBottleImageUploadResult = CachedImageReference & {
  backgroundRemoved: boolean;
};

async function encodeWebp(
  buffer: Buffer,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const out = await sharp(buffer, { failOn: "truncated" })
    .rotate()
    .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .webp({ quality: WEBP_QUALITY, effort: 4, alphaQuality: 95 })
    .toBuffer();

  const meta = await sharp(out).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Uploaded image metadata missing dimensions");
  }
  return { buffer: out, width: meta.width, height: meta.height };
}

/**
 * Process an admin-provided bottle image (already loaded into a buffer) into a
 * hosted, wardrobe-ready WebP and return a `CachedImageReference`. Background
 * removal is opt-in. The returned `imageUrl` is a persistable storage URL the
 * existing `PATCH /api/wardrobe/:id` flow accepts, so the caller (SPA) reuses
 * the normal save/refresh path — no new persistence surface.
 */
export async function processAdminBottleImage(
  input: AdminBottleImageUploadInput,
): Promise<AdminBottleImageUploadResult> {
  // Reject anything sharp can't decode up front so a bad file fails fast with a
  // clear message rather than deep in the encode/upload stage.
  let inputMeta: sharp.Metadata;
  try {
    inputMeta = await sharp(input.buffer).metadata();
  } catch {
    throw new Error("Unsupported or corrupt image file");
  }
  if (!inputMeta.width || !inputMeta.height) {
    throw new Error("Unsupported or corrupt image file");
  }

  const lookupKey = makeLookupKey(input.brand, input.name);
  // Stamp as a deliberate manual pick so hydrate treats the saved row image as
  // authoritative (same intent as the wardrobe PATCH "manual" stamp), and a
  // previously cached generated/reimagined image never overrides it.
  const sourceProvider = "manual" as const;

  let working = input.buffer;
  let backgroundRemoved = false;
  let removeBgStatus: RemoveBgStatus | null = null;
  let removeBgReason: RemoveBgReason | null = null;

  if (input.removeBackground) {
    const removed = await removeBgBuffer(input.buffer, { poofType: "product" });
    if (!removed.backgroundRemoved) {
      // Surface the failure instead of persisting the (still-backgrounded)
      // trim fallback as if removal had worked.
      throw new BackgroundRemovalFailedError(removed.removeBgReason);
    }
    working = removed.buffer;
    backgroundRemoved = true;
    removeBgStatus = removed.removeBgStatus;
    removeBgReason = removed.removeBgReason;
  }

  const encoded = await encodeWebp(working);
  const contentHash = hashBuffer(encoded.buffer);

  // Unique per uploaded output so the (sourceUrlHash, pipelineVersion) index in
  // image_cache does not collide with other images for the same fragrance.
  const sourceUrlForDb = `admin-upload:${input.userId ?? "anon"}:${contentHash}`;
  const sourceUrlHash = hashString(sourceUrlForDb);

  const storage = getImageObjectStorage();
  const storagePath = buildProcessedImageStorageKey({
    sourceProvider,
    lookupKey,
    sourceUrlHash,
    contentHash,
  });

  try {
    const uploaded = await storage.uploadProcessedImage({
      buffer: encoded.buffer,
      contentType: "image/webp",
      key: storagePath,
    });

    const publicUrl = safeImageUrlForResponse(uploaded.publicUrl ?? uploaded.signedUrl ?? "");
    if (!publicUrl) throw new Error("Storage upload did not return a usable URL");

    const recorded = await recordImageReady({
      userId: input.userId ?? null,
      fragranceId: input.fragranceId ?? null,
      lookupKey,
      sourceProvider,
      sourceUrl: sourceUrlForDb,
      sourceUrlHash,
      searchQueryHash: null,
      contentHash,
      storageProvider: uploaded.provider,
      storagePath: uploaded.storagePath,
      publicUrl,
      mimeType: "image/webp",
      width: encoded.width,
      height: encoded.height,
      sizeBytes: uploaded.sizeBytes || encoded.buffer.length,
      backgroundRemoved,
      removeBgStatus,
      removeBgReason,
    });

    if (!recorded.isPersisted) {
      logger.warn(
        { lookupKey, sourceUrlHash, storagePath: recorded.storagePath },
        "[admin-upload] image_cache row not persisted (DB unavailable); URL still returned for this request",
      );
    }

    const catalogEntry = await getCatalogEntry(input.brand, input.name);
    if (catalogEntry) {
      const updatedProfile = {
        ...catalogEntry,
        imageUrl: publicUrl,
        imageHash: contentHash,
        sourceProvider,
        storagePath: uploaded.storagePath,
        storageProvider: uploaded.provider,
      };
      await saveCatalogEntry(input.brand, input.name, updatedProfile).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), lookupKey },
          "[admin-upload] failed to update global catalog with new image",
        );
      });
    }

    return { ...recorded, backgroundRemoved };
  } catch (err) {
    if (err instanceof ImageObjectStorageConfigurationError) throw err;
    const reason = err instanceof Error ? err.message : "admin upload storage failed";
    await recordImageFailure({
      userId: input.userId ?? null,
      fragranceId: input.fragranceId ?? null,
      lookupKey,
      sourceProvider,
      sourceUrl: sourceUrlForDb,
      sourceUrlHash,
      searchQueryHash: null,
      // Same variant slot as this upload's ready row (recordImageReady above
      // writes this `backgroundRemoved`) so the negative cache stays isolated.
      backgroundRemoved,
      failureReason: reason,
    }).catch(() => {});
    throw err;
  }
}
