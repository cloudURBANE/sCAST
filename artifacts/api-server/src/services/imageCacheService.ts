import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { imageCacheTable } from "@workspace/db/schema";
import {
  localImageObjectExists,
  storagePathFromLocalImageObjectUrl,
  type ImageStorageProvider,
} from "./imageObjectStorage";
import { assertNoPersistedBase64Image, safeImageUrlForResponse } from "./persistenceGuards";
export {
  buildProcessedImageStorageKey,
  hashBuffer,
  hashSearchQuery,
  hashSourceUrl,
  hashString,
  IMAGE_PIPELINE_VERSION,
  normalizeSourceUrl,
} from "./imageIdentity";
import { IMAGE_PIPELINE_VERSION } from "./imageIdentity";

export type CachedImageReference = {
  imageUrl: string;
  storagePath: string;
  imageHash: string | null;
  sourceUrlHash: string;
  storageProvider: ImageStorageProvider;
  cached: boolean;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  sizeBytes: number | null;
  backgroundRemoved: boolean;
};

export function isImageCacheUnavailableError(err: unknown): boolean {
  const value = err as { code?: unknown; message?: unknown } | null;
  if (value?.code === "42P01") return true;
  const message = typeof value?.message === "string" ? value.message : "";
  return /relation ["']?image_cache["']? does not exist/i.test(message);
}

function rowToReference(row: typeof imageCacheTable.$inferSelect, cached: boolean): CachedImageReference | null {
  const imageUrl = safeImageUrlForResponse(row.publicUrl);
  if (!imageUrl || !row.storagePath) return null;

  return {
    imageUrl,
    storagePath: row.storagePath,
    imageHash: row.contentHash,
    sourceUrlHash: row.sourceUrlHash,
    storageProvider: row.storageProvider as ImageStorageProvider,
    cached,
    width: row.width,
    height: row.height,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    backgroundRemoved: row.backgroundRemoved,
  };
}

async function rowToUsableReference(
  row: typeof imageCacheTable.$inferSelect,
  cached: boolean,
): Promise<CachedImageReference | null> {
  const ref = rowToReference(row, cached);
  if (!ref) return null;

  if (ref.storageProvider === "local" || ref.imageUrl.startsWith("/api/image-objects/")) {
    const storagePath = ref.storagePath || storagePathFromLocalImageObjectUrl(ref.imageUrl);
    if (!storagePath) return null;
    if (!(await localImageObjectExists(storagePath))) return null;
  }

  return ref;
}

function readyInputToReference(input: {
  sourceUrlHash: string;
  contentHash: string;
  storageProvider: ImageStorageProvider;
  storagePath: string;
  publicUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  backgroundRemoved: boolean;
}): CachedImageReference {
  return {
    imageUrl: safeImageUrlForResponse(input.publicUrl),
    storagePath: input.storagePath,
    imageHash: input.contentHash,
    sourceUrlHash: input.sourceUrlHash,
    storageProvider: input.storageProvider,
    cached: false,
    width: input.width,
    height: input.height,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    backgroundRemoved: input.backgroundRemoved,
  };
}

async function markCacheHit(id: string): Promise<void> {
  try {
    await db
      .update(imageCacheTable)
      .set({
        hitCount: sql`${imageCacheTable.hitCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(imageCacheTable.id, id));
  } catch (err) {
    if (!isImageCacheUnavailableError(err)) throw err;
  }
}

export async function getReadyCachedImageBySourceHash(
  sourceUrlHash: string,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<CachedImageReference | null> {
  let rows: (typeof imageCacheTable.$inferSelect)[];
  try {
    rows = await db
      .select()
      .from(imageCacheTable)
      .where(
        and(
          eq(imageCacheTable.sourceUrlHash, sourceUrlHash),
          eq(imageCacheTable.pipelineVersion, pipelineVersion),
          eq(imageCacheTable.processingStatus, "ready"),
        ),
      )
      .limit(1);
  } catch (err) {
    if (isImageCacheUnavailableError(err)) return null;
    throw err;
  }
  const row = rows[0];
  if (!row) return null;
  const ref = await rowToUsableReference(row, true);
  if (ref) await markCacheHit(row.id);
  return ref;
}

export async function getLatestReadyCachedImageByLookupKey(
  lookupKey: string,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<CachedImageReference | null> {
  let rows: (typeof imageCacheTable.$inferSelect)[];
  try {
    rows = await db
      .select()
      .from(imageCacheTable)
      .where(
        and(
          eq(imageCacheTable.lookupKey, lookupKey),
          eq(imageCacheTable.pipelineVersion, pipelineVersion),
          eq(imageCacheTable.processingStatus, "ready"),
        ),
      )
      .orderBy(desc(imageCacheTable.lastUsedAt), desc(imageCacheTable.createdAt))
      .limit(10);
  } catch (err) {
    if (isImageCacheUnavailableError(err)) return null;
    throw err;
  }
  for (const row of rows) {
    const ref = await rowToUsableReference(row, true);
    if (ref) {
      await markCacheHit(row.id);
      return ref;
    }
  }
  return null;
}

export async function getLatestReadyCachedImageBySearchQueryHash(
  searchQueryHash: string,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<CachedImageReference | null> {
  let rows: (typeof imageCacheTable.$inferSelect)[];
  try {
    rows = await db
      .select()
      .from(imageCacheTable)
      .where(
        and(
          eq(imageCacheTable.searchQueryHash, searchQueryHash),
          eq(imageCacheTable.pipelineVersion, pipelineVersion),
          eq(imageCacheTable.processingStatus, "ready"),
        ),
      )
      .orderBy(desc(imageCacheTable.lastUsedAt), desc(imageCacheTable.createdAt))
      .limit(10);
  } catch (err) {
    if (isImageCacheUnavailableError(err)) return null;
    throw err;
  }
  for (const row of rows) {
    const ref = await rowToUsableReference(row, true);
    if (ref) {
      await markCacheHit(row.id);
      return ref;
    }
  }
  return null;
}

export async function getCachedImageStatusBySourceHash(
  sourceUrlHash: string,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<"ready" | "failed" | "processing" | null> {
  let rows: { processingStatus: string }[];
  try {
    rows = await db
      .select({ processingStatus: imageCacheTable.processingStatus })
      .from(imageCacheTable)
      .where(
        and(
          eq(imageCacheTable.sourceUrlHash, sourceUrlHash),
          eq(imageCacheTable.pipelineVersion, pipelineVersion),
        ),
      )
      .limit(1);
  } catch (err) {
    if (isImageCacheUnavailableError(err)) return null;
    throw err;
  }
  const status = rows[0]?.processingStatus;
  if (status === "ready" || status === "failed" || status === "processing") return status;
  return null;
}

export async function recordImageReady(input: {
  userId?: string | null;
  fragranceId?: string | null;
  lookupKey?: string | null;
  sourceProvider: string;
  sourceUrl: string;
  sourceUrlHash: string;
  searchQueryHash?: string | null;
  pipelineVersion?: string;
  contentHash: string;
  storageProvider: ImageStorageProvider;
  storagePath: string;
  publicUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  backgroundRemoved: boolean;
}): Promise<CachedImageReference> {
  assertNoPersistedBase64Image(input.publicUrl, "image_cache.public_url");
  assertNoPersistedBase64Image(input.sourceUrl, "image_cache.source_url");

  const pipelineVersion = input.pipelineVersion ?? IMAGE_PIPELINE_VERSION;
  let row: typeof imageCacheTable.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(imageCacheTable)
      .values({
        userId: input.userId ?? null,
        fragranceId: input.fragranceId ?? null,
        lookupKey: input.lookupKey ?? null,
        sourceProvider: input.sourceProvider,
        sourceUrl: input.sourceUrl,
        sourceUrlHash: input.sourceUrlHash,
        searchQueryHash: input.searchQueryHash ?? null,
        pipelineVersion,
        contentHash: input.contentHash,
        storageProvider: input.storageProvider,
        storagePath: input.storagePath,
        publicUrl: input.publicUrl,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
        sizeBytes: input.sizeBytes,
        backgroundRemoved: input.backgroundRemoved,
        processingStatus: "ready",
        failureReason: null,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [imageCacheTable.sourceUrlHash, imageCacheTable.pipelineVersion],
        set: {
          lookupKey: input.lookupKey ?? null,
          contentHash: input.contentHash,
          storageProvider: input.storageProvider,
          storagePath: input.storagePath,
          publicUrl: input.publicUrl,
          mimeType: input.mimeType,
          width: input.width,
          height: input.height,
          sizeBytes: input.sizeBytes,
          backgroundRemoved: input.backgroundRemoved,
          processingStatus: "ready",
          failureReason: null,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
  } catch (err) {
    if (isImageCacheUnavailableError(err)) return readyInputToReference(input);
    throw err;
  }

  const ref = row ? await rowToUsableReference(row, false) : readyInputToReference(input);
  if (!ref) throw new Error("Recorded image cache row was missing a usable public URL");
  return ref;
}

export async function recordImageFailure(input: {
  userId?: string | null;
  fragranceId?: string | null;
  lookupKey?: string | null;
  sourceProvider: string;
  sourceUrl: string;
  sourceUrlHash: string;
  searchQueryHash?: string | null;
  pipelineVersion?: string;
  failureReason: string;
}): Promise<void> {
  assertNoPersistedBase64Image(input.sourceUrl, "image_cache.source_url");
  const pipelineVersion = input.pipelineVersion ?? IMAGE_PIPELINE_VERSION;
  try {
    await db
      .insert(imageCacheTable)
      .values({
        userId: input.userId ?? null,
        fragranceId: input.fragranceId ?? null,
        lookupKey: input.lookupKey ?? null,
        sourceProvider: input.sourceProvider,
        sourceUrl: input.sourceUrl,
        sourceUrlHash: input.sourceUrlHash,
        searchQueryHash: input.searchQueryHash ?? null,
        pipelineVersion,
        storageProvider: "local",
        storagePath: "",
        processingStatus: "failed",
        failureReason: input.failureReason.slice(0, 500),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [imageCacheTable.sourceUrlHash, imageCacheTable.pipelineVersion],
        set: {
          processingStatus: "failed",
          failureReason: input.failureReason.slice(0, 500),
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    if (!isImageCacheUnavailableError(err)) throw err;
  }
}
