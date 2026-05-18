import { resolveSharedImageUrl } from "./imageHydration";
import { usableImageUrlForResponse } from "./imageReference";
import {
  safeImageUrlForResponse,
  stripBase64ImageDataUrls,
} from "./persistenceGuards";
import { resolveFragranceIdentity } from "./fragranceNameResolver";

import {
  CURRENT_VAULT_SCHEMA_VERSION,
  stampVaultSchemaVersion,
} from "./fragrancePayloadCore";

export {
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

  return {
    ...fragrance,
    imageUrl,
    ...(imageAdjustment ? { imageAdjustment } : {}),
    ...(normalizedProduct ? { product: normalizedProduct } : {}),
    ...(normalizedName ? { name: normalizedName } : {}),
    ...(normalizedBrand ? { brand: normalizedBrand } : {}),
    ...(perfumer ? { perfumer } : {}),
  };
}

/** Fill in imageUrl from shared metadata/object cache if the stored record has none. */
export async function hydrateImageUrl(fragrance: Record<string, any>): Promise<Record<string, any>> {
  const current = await usableImageUrlForResponse(fragrance.imageUrl);
  if (current) return { ...fragrance, imageUrl: current };
  const name = fragrance.name as string | undefined;
  const brand = fragrance.brand as string | undefined;
  if (!name || !brand) return { ...fragrance, imageUrl: "" };
  try {
    const imageUrl = await resolveSharedImageUrl(brand, name);
    if (imageUrl) return { ...fragrance, imageUrl };
  } catch {
    /* non-fatal */
  }
  return { ...fragrance, imageUrl: "" };
}
