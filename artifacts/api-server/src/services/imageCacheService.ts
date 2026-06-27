import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { imageCacheTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";
import type { RemoveBgReason, RemoveBgStatus } from "./bgService";
import type { OrientationBoundingBox, OrientationMetadata } from "./orientationEngine";
import {
  isLocalImageObjectUrlPersistable,
  localImageObjectExists,
  storagePathFromLocalImageObjectUrl,
  type ImageStorageProvider,
} from "./imageObjectStorage";
import {
  positiveCacheRequiresBackgroundRemoved,
  shouldRetryFailedImageStatus,
} from "./imagePipelineCachePolicy";
import { assertNoPersistedBase64Image, safeImageUrlForResponse } from "./persistenceGuards";
import {
  isImageCacheConflictTargetMissing,
  isImageCacheRelationMissing,
} from "./imageCacheErrorClassifier";
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
const CACHE_HIT_FLUSH_DELAY_MS = 1500;

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
  sourceUrl?: string | null;
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
   * Orientation Engine geometry, reconstructed from the persisted columns, when
   * the stored image was normalized to a uniform square. Null for legacy /
   * non-normalized rows. The SPA gates baseline-aligned rendering on its presence.
   */
  imageProperties?: OrientationMetadata | null;
  /**
   * True when the reference is backed by a persisted `image_cache` row. False
   * when the DB was unavailable at write-time and the reference was synthesized
   * from the input — callers must treat such references as one-shot and expect
   * the next request for the same source to re-run the full pipeline.
   */
  isPersisted: boolean;
};

/**
 * Reconstruct the Orientation Engine metadata from the flat `image_cache`
 * columns. Returns null unless the row carries a complete, normalized geometry
 * (version + dimensions + bounding box) — partial/legacy rows stay un-normalized.
 */
function rowToImageProperties(
  row: typeof imageCacheTable.$inferSelect,
): OrientationMetadata | null {
  if (!row.orientationVersion) return null;
  if (row.originalWidth == null || row.originalHeight == null) return null;
  const bb = row.boundingBox as OrientationBoundingBox | null;
  if (!bb || typeof bb.width !== "number" || typeof bb.height !== "number") return null;
  return {
    originalWidth: row.originalWidth,
    originalHeight: row.originalHeight,
    boundingBox: bb,
    aspectRatio: row.aspectRatio ?? (bb.height ? bb.width / bb.height : 0),
    orientationVersion: row.orientationVersion,
    baselineAlignment: row.baselineAlignment ?? 0,
  };
}

let imageCacheMissingWarned = false;

function warnImageCacheMissingOnce(): void {
  if (imageCacheMissingWarned) return;
  imageCacheMissingWarned = true;
  logger.warn(
    "image_cache table is missing; processed image cache persistence is disabled. Run pnpm --filter @workspace/db push.",
  );
}

export function isImageCacheUnavailableError(err: unknown): boolean {
  const isMissing = isImageCacheRelationMissing(err);
  if (isMissing) warnImageCacheMissingOnce();
  return isMissing;
}

let imageCacheConflictIndexWarned = false;

function warnImageCacheConflictIndexMissingOnce(): void {
  if (imageCacheConflictIndexWarned) return;
  imageCacheConflictIndexWarned = true;
  logger.error(
    "image_cache is missing the (source_url_hash, pipeline_version, background_removed) unique index, " +
      "so every processed-image upsert fails (Postgres 42P10) and images cannot be cached — processed " +
      "objects still upload and serve for the current request, but nothing persists. Apply migration " +
      "lib/db/migrations/0001_image_cache_bg_variant_unique.sql (creates image_cache_source_pipeline_bg_unique_idx) " +
      "against the production database to restore caching.",
  );
}

/**
 * Detects the un-migrated ON CONFLICT index error (SQLSTATE 42P10) and logs a
 * one-time, actionable error. Pure detection lives in imageCacheErrorClassifier
 * so it can be unit-tested without importing this module's db/logger deps.
 */
export function isImageCacheConflictTargetMissingError(err: unknown): boolean {
  const matches = isImageCacheConflictTargetMissing(err);
  if (matches) warnImageCacheConflictIndexMissingOnce();
  return matches;
}

function rowToReference(row: typeof imageCacheTable.$inferSelect, cached: boolean): CachedImageReference | null {
  const imageUrl = safeImageUrlForResponse(row.publicUrl);
  if (!imageUrl || !row.storagePath) return null;

  return {
    imageUrl,
    storagePath: row.storagePath,
    imageHash: row.contentHash,
    sourceUrl: row.sourceUrl,
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
    imageProperties: rowToImageProperties(row),
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
  sourceUrl: string;
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
  orientation?: OrientationMetadata | null;
}): CachedImageReference {
  return {
    imageUrl: safeImageUrlForResponse(input.publicUrl),
    storagePath: input.storagePath,
    imageHash: input.contentHash,
    sourceUrl: input.sourceUrl,
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
    imageProperties: input.orientation ?? null,
    isPersisted: false,
  };
}

function sourceProviderPrioritySql() {
  return sql<number>`case
    when ${imageCacheTable.sourceProvider} in ('openai', 'openai-reimagine', 'openai_reimagine')
      or ${imageCacheTable.sourceUrl} like 'openai-reimagine:%' then 2
    when ${imageCacheTable.sourceProvider} = 'manual' then 1
    else 0
  end`;
}

const pendingCacheHits = new Map<string, { count: number; lastUsedAt: Date }>();
let cacheHitFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCacheHitFlush(): void {
  if (cacheHitFlushTimer) return;
  cacheHitFlushTimer = setTimeout(() => {
    cacheHitFlushTimer = null;
    void flushCacheHits();
  }, CACHE_HIT_FLUSH_DELAY_MS);
}

async function flushCacheHits(): Promise<void> {
  const batch = Array.from(pendingCacheHits.entries());
  pendingCacheHits.clear();
  if (batch.length === 0) return;

  await Promise.all(
    batch.map(async ([id, hit]) => {
      try {
        await db
          .update(imageCacheTable)
          .set({
            hitCount: sql`${imageCacheTable.hitCount} + ${hit.count}`,
            lastUsedAt: hit.lastUsedAt,
            updatedAt: hit.lastUsedAt,
          })
          .where(eq(imageCacheTable.id, id));
      } catch (err) {
        if (!isImageCacheUnavailableError(err)) {
          logger.warn({ err, id }, "image_cache hit accounting failed");
        }
      }
    }),
  );
}

function markCacheHitDeferred(id: string): void {
  const current = pendingCacheHits.get(id);
  if (current) {
    pendingCacheHits.set(id, { count: current.count + 1, lastUsedAt: new Date() });
  } else {
    pendingCacheHits.set(id, { count: 1, lastUsedAt: new Date() });
  }
  scheduleCacheHitFlush();
}

export async function getReadyCachedImageBySourceHash(
  sourceUrlHash: string,
  removeBackground: boolean,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<CachedImageReference | null> {
  // Positive-cache variant isolation: when BG removal is requested, a
  // background-removed row satisfies it OR a deterministic "fallback" row — one
  // where removal was attempted on this source and produced an unusable cutout,
  // so the stored white-bg image is the best obtainable (image-pipeline C1).
  // A plain white-bg row (a no-bg request's output) must NOT satisfy it. When BG
  // removal is not requested, either variant is acceptable, but prefer the
  // transparent one when both exist (ordering below) since it renders anywhere.
  const variantFilter = positiveCacheRequiresBackgroundRemoved(removeBackground)
    ? [or(eq(imageCacheTable.backgroundRemoved, true), eq(imageCacheTable.removeBgStatus, "fallback"))]
    : [];
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
          ...variantFilter,
        ),
      )
      .orderBy(desc(imageCacheTable.backgroundRemoved))
      .limit(1);
  } catch (err) {
    if (isImageCacheUnavailableError(err)) return null;
    throw err;
  }
  const row = rows[0];
  if (!row) return null;
  const ref = await rowToUsableReference(row, true);
  if (ref) markCacheHitDeferred(row.id);
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
        desc(sourceProviderPrioritySql()),
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
      markCacheHitDeferred(row.id);
      return ref;
    }
  }
  return null;
}

export async function getLatestReadyCachedImageBySearchQueryHash(
  searchQueryHash: string,
  // When provided, the lookup is scoped to this fragrance. The search-query
  // hash only normalizes a query string, so two different fragrances whose
  // queries collide would otherwise cross-serve each other's bottle. Callers
  // resolving a specific fragrance MUST pass lookupKey; the hash then only
  // disambiguates refine variants WITHIN that fragrance. (Optional so the
  // reimagine path, which stores a self-scoping identity hash, is unaffected.)
  lookupKey?: string,
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
          ...(lookupKey ? [eq(imageCacheTable.lookupKey, lookupKey)] : []),
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
      markCacheHitDeferred(row.id);
      return ref;
    }
  }
  return null;
}

export async function getCachedImageStatusBySourceHash(
  sourceUrlHash: string,
  removeBackground: boolean,
  pipelineVersion = IMAGE_PIPELINE_VERSION,
): Promise<"ready" | "failed" | "processing" | null> {
  // Negative-cache variant isolation: a "failed" row is keyed on the requested
  // background-removal variant, so only check the slot for THIS request's
  // variant. A failure recorded for the other variant must not suppress this
  // one (matches recordImageFailure's `backgroundRemoved` write value).
  let rows: { processingStatus: string; updatedAt: Date | null }[];
  try {
    rows = await db
      .select({ processingStatus: imageCacheTable.processingStatus, updatedAt: imageCacheTable.updatedAt })
      .from(imageCacheTable)
      .where(
        and(
          eq(imageCacheTable.sourceUrlHash, sourceUrlHash),
          eq(imageCacheTable.pipelineVersion, pipelineVersion),
          eq(imageCacheTable.backgroundRemoved, removeBackground),
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
  orientation?: OrientationMetadata | null;
}): Promise<CachedImageReference> {
  assertNoPersistedBase64Image(input.publicUrl, "image_cache.public_url");
  assertNoPersistedBase64Image(input.sourceUrl, "image_cache.source_url");

  const pipelineVersion = input.pipelineVersion ?? IMAGE_PIPELINE_VERSION;
  // Flatten the Orientation Engine metadata to columns. Written on both insert
  // and conflict-update so re-processing a source upgrades a legacy row in place.
  const o = input.orientation ?? null;
  const orientationCols = {
    originalWidth: o?.originalWidth ?? null,
    originalHeight: o?.originalHeight ?? null,
    boundingBox: o?.boundingBox ?? null,
    aspectRatio: o?.aspectRatio ?? null,
    orientationVersion: o?.orientationVersion ?? null,
    baselineAlignment: o?.baselineAlignment ?? null,
  };
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
        ...orientationCols,
        processingStatus: "ready",
        failureReason: null,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        // Conflict key matches the (source_url_hash, pipeline_version,
        // background_removed) unique index so re-processing the SAME variant
        // upgrades its row in place, while the OTHER variant keeps its own row.
        target: [
          imageCacheTable.sourceUrlHash,
          imageCacheTable.pipelineVersion,
          imageCacheTable.backgroundRemoved,
        ],
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
          ...orientationCols,
          processingStatus: "ready",
          failureReason: null,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
  } catch (err) {
    // Either the table is missing (42P01) or the unique index the ON CONFLICT
    // targets has not been migrated yet (42P10). In both cases caching is
    // impossible, but the object already uploaded — serve it for this request
    // instead of throwing into the deferred path's silent null ("No image").
    if (isImageCacheUnavailableError(err) || isImageCacheConflictTargetMissingError(err)) {
      return readyInputToReference(input);
    }
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
  // The background-removal variant this failure belongs to. Negative-cache rows
  // are isolated per variant so a deterministic failure for one variant never
  // suppresses retries for the other (see image_cache_source_pipeline_bg_unique_idx).
  backgroundRemoved: boolean;
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
        backgroundRemoved: input.backgroundRemoved,
        storageProvider: "local",
        storagePath: "",
        processingStatus: "failed",
        failureReason: input.failureReason.slice(0, 500),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          imageCacheTable.sourceUrlHash,
          imageCacheTable.pipelineVersion,
          imageCacheTable.backgroundRemoved,
        ],
        set: {
          processingStatus: "failed",
          failureReason: input.failureReason.slice(0, 500),
          // Anchor the negative-cache TTL to the *first* failure: only advance
          // updated_at when transitioning into "failed" from another status. A
          // repeat failure of an already-failed row keeps the original
          // timestamp so the 6h retry window (shouldRetryFailedImageStatus) can
          // actually elapse instead of being reset on every attempt (BE-5).
          updatedAt: sql`case when ${imageCacheTable.processingStatus} = 'failed' then ${imageCacheTable.updatedAt} else now() end`,
        },
      });
  } catch (err) {
    // A missing table (42P01) or un-migrated conflict index (42P10) just means
    // the negative-cache write is a no-op; never let it surface as an error.
    if (!isImageCacheUnavailableError(err) && !isImageCacheConflictTargetMissingError(err)) {
      throw err;
    }
  }
}
