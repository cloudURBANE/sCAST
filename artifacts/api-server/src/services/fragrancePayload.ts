import { resolveSharedImageReference } from "./imageHydration";
import { usableImageUrlForResponse } from "./imageReference";
import {
  safeImageUrlForResponse,
  stripBase64ImageDataUrls,
} from "./persistenceGuards";
import { resolveFragranceIdentity } from "./fragranceNameResolver";
import { resolvePyramidNotes } from "./fragranceNotes.ts";
import { logger } from "../lib/logger";

import {
  chooseHydratedImageUrl,
  chooseHydratedImageUrlWithMetadata,
  CURRENT_VAULT_SCHEMA_VERSION,
  stampVaultSchemaVersion,
  type HydratedImageCandidate,
} from "./fragrancePayloadCore";
import { db } from "@workspace/db";
import { globalFragrancesTable, imageCacheTable } from "@workspace/db/schema";
import { and, desc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { makeLookupKey } from "./catalogService";
import { IMAGE_PIPELINE_VERSION } from "./imageIdentity";

export {
  chooseHydratedImageUrl,
  chooseHydratedImageUrlWithMetadata,
  CURRENT_VAULT_SCHEMA_VERSION,
  isLegacyVaultRow,
  stampVaultSchemaVersion,
} from "./fragrancePayloadCore";

export type BottleImageAdjustment = {
  scale: number;
  x: number;
  y: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  cropLeft: number;
};

const DEFAULT_IMAGE_ADJUSTMENT: BottleImageAdjustment = {
  scale: 1,
  x: 0,
  y: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  cropLeft: 0,
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = finiteNumber(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function normalizeImageAdjustment(value: unknown): BottleImageAdjustment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  // Bounds mirror scent-cast `lib/bottleImageAdjustment.ts` (BOTTLE_FRAME_LIMITS)
  // across the package boundary — keep the two in lockstep so the editor sliders
  // and this server-side clamp accept the exact same framing range.
  const legacyCrop = round(clampNumber(input.crop, 0, 40, 0), 1);
  return {
    scale: round(clampNumber(input.scale, 0.5, 1.8, DEFAULT_IMAGE_ADJUSTMENT.scale), 2),
    x: round(clampNumber(input.x, -36, 36, DEFAULT_IMAGE_ADJUSTMENT.x), 1),
    y: round(clampNumber(input.y, -36, 36, DEFAULT_IMAGE_ADJUSTMENT.y), 1),
    cropTop: round(clampNumber(input.cropTop, 0, 40, legacyCrop), 1),
    cropRight: round(clampNumber(input.cropRight, 0, 40, legacyCrop), 1),
    cropBottom: round(clampNumber(input.cropBottom, 0, 40, legacyCrop), 1),
    cropLeft: round(clampNumber(input.cropLeft, 0, 40, legacyCrop), 1),
  };
}

/**
 * Strip base64 data URLs and stamp the current vault schema version.
 *
 * Postgres must never be used as the image CDN, hence the base64 strip.
 * The schema-version stamp is the universal write gate: every code path that
 * persists to user_fragrances funnels through here, so downstream readers can
 * trust `schemaVersion` to reflect the shape the row was last written in.
 */
export function sanitizeFragrance(fragrance: Record<string, any>): Record<string, any> {
  return stampVaultSchemaVersion(stripBase64ImageDataUrls(fragrance) as Record<string, any>);
}

/**
 * SQL projection of `fragrance_data` with the heaviest modal-only fields removed
 * **inside Postgres**, so they never travel Supabase -> Express. That hop is what
 * Supabase meters as database egress, so a real fix must avoid pulling the bytes
 * in the query — trimming the response object after `db.select()` would not save
 * a single metered byte.
 *
 * Strips the full scraped `raw.reviews` text (by far the heaviest part) and
 * `raw.description`. It intentionally **keeps `raw.notes`**, because
 * {@link normalizeFragrance} derives the note pyramid from it for legacy rows
 * that lack `derived_metrics.notes`. Reviews for the one item a user opens are
 * refetched on demand via `GET /api/wardrobe/:id/reviews`.
 *
 * Use this in the high-frequency LIST reads (`GET /api/wardrobe` poll and the
 * community feed) — never on the write path, which must persist the full blob.
 */
export function slimListFragranceData(column: AnyColumn): SQL<Record<string, any>> {
  return sql<Record<string, any>>`${column} #- '{raw_engine_detail,raw,reviews}' #- '{raw_engine_detail,raw,description}'`;
}

/**
 * Older inserts stored a raw ScentProfile (only `product.name`/`product.brand`).
 * Surface canonical top-level fields the dashboard and share page expect.
 */
export function normalizeFragrance(fragrance: Record<string, any>): Record<string, any> {
  const product = fragrance.product as Record<string, any> | undefined;
  const name = fragrance.name || product?.name;
  const brand = fragrance.brand || product?.brand;
  const perfumer = fragrance.perfumer || product?.perfumer;
  const imageUrl = safeImageUrlForResponse(fragrance.imageUrl);
  const imageAdjustment = normalizeImageAdjustment(fragrance.imageAdjustment);
  const identity =
    typeof name === "string" && typeof brand === "string"
      ? resolveFragranceIdentity(brand, name)
      : null;
  const normalizedName = identity?.name || name;
  const normalizedBrand = identity?.brand || brand;
  const normalizedProduct =
    product || normalizedName || normalizedBrand || perfumer
      ? {
          ...(product ?? {}),
          ...(normalizedName ? { name: normalizedName } : {}),
          ...(normalizedBrand ? { brand: normalizedBrand } : {}),
          ...(perfumer ? { perfumer } : {}),
        }
      : product;
  const derivedNotes =
    fragrance.raw_engine_detail?.derived_metrics?.notes ??
    fragrance.derived_metrics?.notes ??
    fragrance.raw_engine_detail?.raw?.notes;
  const normalizedPyramid = resolvePyramidNotes(
    derivedNotes,
    fragrance.pyramid,
    fragrance.notes,
  );

  return {
    ...fragrance,
    imageUrl,
    ...(normalizedPyramid ? { pyramid: normalizedPyramid } : {}),
    ...(imageAdjustment ? { imageAdjustment } : {}),
    ...(normalizedProduct ? { product: normalizedProduct } : {}),
    ...(normalizedName ? { name: normalizedName } : {}),
    ...(normalizedBrand ? { brand: normalizedBrand } : {}),
    ...(perfumer ? { perfumer } : {}),
  };
}

/** Prefer saved manual/generated row images, but let generated cache repair stale Serper/catalog rows. */
export async function hydrateImageUrl(fragrance: Record<string, any>): Promise<Record<string, any>> {
  const current = await usableImageUrlForResponse(fragrance.imageUrl);
  const currentRef: HydratedImageCandidate = {
    imageUrl: current,
    sourceProvider: fragrance.sourceProvider,
    storagePath: fragrance.storagePath,
  };
  const name = fragrance.name as string | undefined;
  const brand = fragrance.brand as string | undefined;
  if (!name || !brand) return { ...fragrance, imageUrl: chooseHydratedImageUrlWithMetadata(null, currentRef) };
  try {
    const sharedRef = await resolveSharedImageReference(brand, name);
    const chosen = chooseHydratedImageUrlWithMetadata(sharedRef, currentRef);
    // Only carry the normalized geometry when the chosen URL is the cache image
    // it describes — never tag a saved/legacy row image as normalized.
    const props = sharedRef && chosen && chosen === sharedRef.imageUrl ? sharedRef.imageProperties : null;
    return { ...fragrance, imageUrl: chosen, ...(props ? { imageProperties: props } : {}) };
  } catch {
    /* non-fatal */
  }
  return { ...fragrance, imageUrl: chooseHydratedImageUrlWithMetadata(null, currentRef) };
}

async function hydrateImageUrlSafely(
  fragrance: Record<string, any>,
  context: string,
): Promise<Record<string, any>> {
  try {
    return await hydrateImageUrl(fragrance);
  } catch (err) {
    logger.warn(
      {
        err,
        context,
        brand: typeof fragrance.brand === "string" ? fragrance.brand : undefined,
        name: typeof fragrance.name === "string" ? fragrance.name : undefined,
      },
      "fragrance image hydration failed; returning row without shared image lookup",
    );
    return {
      ...fragrance,
      imageUrl: chooseHydratedImageUrlWithMetadata(null, {
        imageUrl: fragrance.imageUrl,
        sourceProvider: fragrance.sourceProvider,
        storagePath: fragrance.storagePath,
      }),
    };
  }
}

/**
 * Batch version of hydrateImageUrl for loading a full wardrobe list.
 * Replaces N×2 individual DB queries (one image_cache + one global_fragrances
 * lookup per item) with 2 bulk queries across all items, then maps results back.
 */
export async function batchHydrateImageUrls(
  fragrances: Record<string, any>[],
): Promise<Record<string, any>[]> {
  if (fragrances.length === 0) return [];

  const indexToKey: (string | null)[] = fragrances.map((f) => {
    const name = f.name as string | undefined;
    const brand = f.brand as string | undefined;
    return name && brand ? makeLookupKey(brand, name) : null;
  });

  const uniqueKeys = [...new Set(indexToKey.filter((k): k is string => k !== null))];

  if (uniqueKeys.length === 0) {
    return Promise.all(fragrances.map((fragrance) => hydrateImageUrlSafely(fragrance, "no-shared-key")));
  }

  let imageCacheRows: {
    lookupKey: string | null;
    publicUrl: string | null;
    sourceProvider: string;
    sourceUrl: string;
    storagePath: string;
    backgroundRemoved: boolean;
    originalWidth: number | null;
    originalHeight: number | null;
    boundingBox: unknown;
    aspectRatio: number | null;
    orientationVersion: string | null;
    baselineAlignment: number | null;
  }[];
  let catalogRows: {
    lookupKey: string;
    profileData: unknown;
  }[];

  try {
    // Batch fetch from image_cache and global_fragrances in parallel.
    [imageCacheRows, catalogRows] = await Promise.all([
      db
        .select({
          lookupKey: imageCacheTable.lookupKey,
          publicUrl: imageCacheTable.publicUrl,
          sourceProvider: imageCacheTable.sourceProvider,
          sourceUrl: imageCacheTable.sourceUrl,
          storagePath: imageCacheTable.storagePath,
          backgroundRemoved: imageCacheTable.backgroundRemoved,
          originalWidth: imageCacheTable.originalWidth,
          originalHeight: imageCacheTable.originalHeight,
          boundingBox: imageCacheTable.boundingBox,
          aspectRatio: imageCacheTable.aspectRatio,
          orientationVersion: imageCacheTable.orientationVersion,
          baselineAlignment: imageCacheTable.baselineAlignment,
        })
        .from(imageCacheTable)
        .where(
          and(
            inArray(imageCacheTable.lookupKey, uniqueKeys),
            eq(imageCacheTable.pipelineVersion, IMAGE_PIPELINE_VERSION),
            eq(imageCacheTable.processingStatus, "ready"),
          ),
        )
        .orderBy(
          desc(sql<number>`case
            when ${imageCacheTable.sourceProvider} = 'manual' then 3
            when ${imageCacheTable.sourceProvider} in ('openai', 'openai-reimagine', 'openai_reimagine')
              or ${imageCacheTable.sourceUrl} like 'openai-reimagine:%' then 2
            else 0
          end`),
          desc(imageCacheTable.backgroundRemoved),
          desc(imageCacheTable.lastUsedAt),
          desc(imageCacheTable.createdAt),
        ),
      db
        .select({
          lookupKey: globalFragrancesTable.lookupKey,
          profileData: globalFragrancesTable.profileData,
        })
        .from(globalFragrancesTable)
        .where(inArray(globalFragrancesTable.lookupKey, uniqueKeys)),
    ]);
  } catch (err) {
    logger.warn(
      { err, uniqueKeyCount: uniqueKeys.length },
      "batch fragrance image hydration failed; falling back to per-row hydration",
    );
    return Promise.all(fragrances.map((fragrance) => hydrateImageUrlSafely(fragrance, "batch-fallback")));
  }

  // Pick the first usable URL per lookup key from image_cache (rows are pre-sorted)
  const imageCacheMap = new Map<string, HydratedImageCandidate>();
  for (const row of imageCacheRows) {
    if (!row.lookupKey || imageCacheMap.has(row.lookupKey)) continue;
    const url = await usableImageUrlForResponse(row.publicUrl);
    if (url) {
      const imageProperties =
        row.orientationVersion && row.originalWidth != null && row.originalHeight != null && row.boundingBox
          ? {
              originalWidth: row.originalWidth,
              originalHeight: row.originalHeight,
              boundingBox: row.boundingBox,
              aspectRatio: row.aspectRatio,
              orientationVersion: row.orientationVersion,
              baselineAlignment: row.baselineAlignment,
            }
          : null;
      imageCacheMap.set(row.lookupKey, {
        imageUrl: url,
        sourceProvider: row.sourceProvider,
        sourceUrl: row.sourceUrl,
        storagePath: row.storagePath,
        imageProperties,
      });
    }
  }

  // Pick catalog image URL as secondary fallback
  const catalogMap = new Map<string, HydratedImageCandidate>();
  for (const row of catalogRows) {
    if (!row.lookupKey) continue;
    const profile = row.profileData as Record<string, unknown> | null;
    const url = await usableImageUrlForResponse(profile?.imageUrl);
    if (url) {
      catalogMap.set(row.lookupKey, {
        imageUrl: url,
        sourceProvider: profile?.sourceProvider,
        sourceUrl: profile?.sourceUrl,
        storagePath: profile?.storagePath,
      });
    }
  }

  return Promise.all(
    fragrances.map(async (f, i) => {
      const key = indexToKey[i];
      const current = await usableImageUrlForResponse(f.imageUrl);
      const currentRef: HydratedImageCandidate = {
        imageUrl: current,
        sourceProvider: f.sourceProvider,
        storagePath: f.storagePath,
      };
      const resolved = key ? (imageCacheMap.get(key) ?? catalogMap.get(key) ?? null) : null;
      const chosen = chooseHydratedImageUrlWithMetadata(resolved, currentRef);
      const props =
        resolved && chosen && chosen === resolved.imageUrl ? resolved.imageProperties : null;
      return { ...f, imageUrl: chosen, ...(props ? { imageProperties: props } : {}) };
    }),
  );
}
