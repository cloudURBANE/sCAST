import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { imageCacheTable } from "@workspace/db/schema";
import type { ImageStorageProvider } from "./imageObjectStorage";
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

async function markCacheHit(id: string): Promise<void> {
  await db
    .update(imageCacheTable)
    .set({
      hitCount: sql`${imageCacheTable.hitCount} + 1`,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(imageCacheTable.id, id));
}

export async function getReadyCachedImageBySourceHash(
  sourceUrlHash: string,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<CachedImageReference | null> {
  const rows = await db
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
  const row = rows[0];
  if (!row) return null;
  const ref = rowToReference(row, true);
  if (ref) await markCacheHit(row.id);
  return ref;
}

export async function getLatestReadyCachedImageByLookupKey(
  lookupKey: string,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<CachedImageReference | null> {
  const rows = await db
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
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const ref = rowToReference(row, true);
  if (ref) await markCacheHit(row.id);
  return ref;
}

export async function getLatestReadyCachedImageBySearchQueryHash(
  searchQueryHash: string,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<CachedImageReference | null> {
  const rows = await db
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
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const ref = rowToReference(row, true);
  if (ref) await markCacheHit(row.id);
  return ref;
}

export async function getCachedImageStatusBySourceHash(
  sourceUrlHash: string,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<"ready" | "failed" | "processing" | null> {
  const rows = await db
    .select({ processingStatus: imageCacheTable.processingStatus })
    .from(imageCacheTable)
    .where(
      and(
        eq(imageCacheTable.sourceUrlHash, sourceUrlHash),
        eq(imageCacheTable.pipelineVersion, pipelineVersion),
      ),
    )
    .limit(1);
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
  const [row] = await db
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

  const ref = rowToReference(row, false);
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
}
