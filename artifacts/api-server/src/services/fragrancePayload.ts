import { resolveSharedImageUrl } from "./imageHydration";
import { usableImageUrlForResponse } from "./imageReference";
import {
  safeImageUrlForResponse,
  stripBase64ImageDataUrls,
} from "./persistenceGuards";
import { resolveFragranceIdentity } from "./fragranceNameResolver";
import { resolvePyramidNotes } from "./fragranceNotes.ts";

import {
  chooseHydratedImageUrl,
  CURRENT_VAULT_SCHEMA_VERSION,
  stampVaultSchemaVersion,
} from "./fragrancePayloadCore";
import { db } from "@workspace/db";
import { globalFragrancesTable, imageCacheTable } from "@workspace/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { makeLookupKey } from "./catalogService";
import { IMAGE_PIPELINE_VERSION } from "./imageIdentity";

export {
  chooseHydratedImageUrl,
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
  const legacyCrop = round(clampNumber(input.crop, 0, 40, 0), 1);
  return {
    scale: round(clampNumber(input.scale, 0.7, 1.45, DEFAULT_IMAGE_ADJUSTMENT.scale), 2),
    x: round(clampNumber(input.x, -18, 18, DEFAULT_IMAGE_ADJUSTMENT.x), 1),
    y: round(clampNumber(input.y, -18, 18, DEFAULT_IMAGE_ADJUSTMENT.y), 1),
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

/** Prefer the shared catalog/cache image; fall back to the stored row URL only if needed. */
export async function hydrateImageUrl(fragrance: Record<string, any>): Promise<Record<string, any>> {
  const current = await usableImageUrlForResponse(fragrance.imageUrl);
  const name = fragrance.name as string | undefined;
  const brand = fragrance.brand as string | undefined;
  if (!name || !brand) return { ...fragrance, imageUrl: chooseHydratedImageUrl(null, current) };
  try {
    const sharedImageUrl = await resolveSharedImageUrl(brand, name);
    return { ...fragrance, imageUrl: chooseHydratedImageUrl(sharedImageUrl, current) };
  } catch {
    /* non-fatal */
  }
  return { ...fragrance, imageUrl: chooseHydratedImageUrl(null, current) };
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
    return Promise.all(fragrances.map(hydrateImageUrl));
  }

  // Batch fetch from image_cache and global_fragrances in parallel
  const [imageCacheRows, catalogRows] = await Promise.all([
    db
      .select({
        lookupKey: imageCacheTable.lookupKey,
        publicUrl: imageCacheTable.publicUrl,
        backgroundRemoved: imageCacheTable.backgroundRemoved,
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

  // Pick the first usable URL per lookup key from image_cache (rows are pre-sorted)
  const imageCacheMap = new Map<string, string>();
  for (const row of imageCacheRows) {
    if (!row.lookupKey || imageCacheMap.has(row.lookupKey)) continue;
    const url = await usableImageUrlForResponse(row.publicUrl);
    if (url) imageCacheMap.set(row.lookupKey, url);
  }

  // Pick catalog image URL as secondary fallback
  const catalogMap = new Map<string, string>();
  for (const row of catalogRows) {
    if (!row.lookupKey) continue;
    const profile = row.profileData as Record<string, unknown> | null;
    const url = await usableImageUrlForResponse(profile?.imageUrl);
    if (url) catalogMap.set(row.lookupKey, url);
  }

  return Promise.all(
    fragrances.map(async (f, i) => {
      const key = indexToKey[i];
      const current = await usableImageUrlForResponse(f.imageUrl);
      const resolved = key ? (imageCacheMap.get(key) ?? catalogMap.get(key) ?? null) : null;
      return { ...f, imageUrl: chooseHydratedImageUrl(resolved, current) };
    }),
  );
}
