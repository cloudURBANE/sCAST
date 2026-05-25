import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { imageCacheTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";
import type { RemoveBgReason, RemoveBgStatus } from "./bgService";
import {
  isLocalImageObjectUrlPersistable,
  localImageObjectExists,
  storagePathFromLocalImageObjectUrl,
  type ImageStorageProvider,
} from "./imageObjectStorage";
import { shouldRetryFailedImageStatus } from "./imagePipelineCachePolicy";
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

const DEFAULT_FAILED_STATUS_RETRY_MS = 6 * 60 * 60 * 1000;

function failedStatusRetryMs(): number {
  const raw = process.env.IMAGE_FAILED_STATUS_RETRY_MS;
  if (!raw) return DEFAULT_FAILED_STATUS_RETRY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FAILED_STATUS_RETRY_MS;
  return Math.min(parsed, 7 * 24 * 60 * 60 * 1000);
}

export type CachedImageReference = {
  imageUrl: string;
  storagePath: string;
  imageHash: string | null;
  sourceUrlHash: string;
  sourceProvider: string;
  storageProvider: ImageStorageProvider;
  cached: boolean;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  sizeBytes: number | null;
  backgroundRemoved: boolean;
  removeBgStatus?: RemoveBgStatus | null;
  removeBgReason?: RemoveBgReason | null;
  /**
   * True when the reference is backed by a persisted `image_cache` row. False
   * when the DB was unavailable at write-time and the reference was synthesized
   * from the input — callers must treat such references as one-shot and expect
   * the next request for the same source to re-run the full pipeline.
   */
  isPersisted: boolean;
};

let imageCacheMissingWarned = false;

function warnImageCacheMissingOnce(): void {
  if (imageCacheMissingWarned) return;
  imageCacheMissingWarned = true;
  logger.warn(
    "image_cache table is missing; processed image cache persistence is disabled. Run pnpm --filter @workspace/db push.",
  );
}

export function isImageCacheUnavailableError(err: unknown): boolean {
  const value = err as { code?: unknown; message?: unknown } | null;
  const isMissing =
    value?.code === "42P01" ||
    (typeof value?.message === "string" &&
      /relation ["']?image_cache["']? does not exist/i.test(value.message));
  if (isMissing) warnImageCacheMissingOnce();
  return isMissing;
}

function rowToReference(row: typeof imageCacheTable.$inferSelect, cached: boolean): CachedImageReference | null {
  const imageUrl = safeImageUrlForResponse(row.publicUrl);
  if (!imageUrl || !row.storagePath) return null;

  return {
    imageUrl,
    storagePath: row.storagePath,
    imageHash: row.contentHash,
    sourceUrlHash: row.sourceUrlHash,
    sourceProvider: row.sourceProvider,
    storageProvider: row.storageProvider as ImageStorageProvider,
    cached,
    width: row.width,
    height: row.height,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    backgroundRemoved: row.backgroundRemoved,
    removeBgStatus: row.removeBgStatus as RemoveBgStatus | null,
    removeBgReason: row.removeBgReason as RemoveBgReason | null,
    isPersisted: true,
  };
}

async function rowToUsableReference(
  row: typeof imageCacheTable.$inferSelect,
  cached: boolean,
): Promise<CachedImageReference | null> {
  const ref = rowToReference(row, cached);
  if (!ref) return null;

  if (ref.storageProvider === "local" || ref.imageUrl.startsWith("/api/image-objects/")) {
    if (!isLocalImageObjectUrlPersistable()) return null;
    const storagePath = ref.storagePath || storagePathFromLocalImageObjectUrl(ref.imageUrl);
    if (!storagePath) return null;
    if (!(await localImageObjectExists(storagePath))) return null;
  }

  return ref;
}

function readyInputToReference(input: {
  sourceUrlHash: string;
  sourceProvider: string;
  contentHash: string;
  storageProvider: ImageStorageProvider;
  storagePath: string;
  publicUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  backgroundRemoved: boolean;
  removeBgStatus?: RemoveBgStatus | null;
  removeBgReason?: RemoveBgReason | null;
}): CachedImageReference {
  return {
    imageUrl: safeImageUrlForResponse(input.publicUrl),
    storagePath: input.storagePath,
    imageHash: input.contentHash,
    sourceUrlHash: input.sourceUrlHash,
    sourceProvider: input.sourceProvider,
    storageProvider: input.storageProvider,
    cached: false,
    width: input.width,
    height: input.height,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    backgroundRemoved: input.backgroundRemoved,
    removeBgStatus: input.removeBgStatus ?? null,
    removeBgReason: input.removeBgReason ?? null,
    isPersisted: false,
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
      .orderBy(
        desc(sql<number>`case when ${imageCacheTable.sourceProvider} = 'manual' then 1 else 0 end`),
        desc(imageCacheTable.backgroundRemoved),
        desc(imageCacheTable.lastUsedAt),
        desc(imageCacheTable.createdAt),
      )
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
  let rows: { processingStatus: string; updatedAt: Date | null }[];
  try {
    rows = await db
      .select({ processingStatus: imageCacheTable.processingStatus, updatedAt: imageCacheTable.updatedAt })
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
  const row = rows[0];
  const status = row?.processingStatus;
  if (
    shouldRetryFailedImageStatus(
      status as "ready" | "failed" | "processing" | null,
      row?.updatedAt,
      failedStatusRetryMs(),
    )
  ) {
    return null;
  }
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
  removeBgStatus?: RemoveBgStatus | null;
  removeBgReason?: RemoveBgReason | null;
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
        removeBgStatus: input.removeBgStatus ?? null,
        removeBgReason: input.removeBgReason ?? null,
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
          removeBgStatus: input.removeBgStatus ?? null,
          removeBgReason: input.removeBgReason ?? null,
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
