/**
 * Pure, dependency-free core of the BE-2 user-image backfill.
 *
 * No runtime imports beyond the sibling pure brand core — kept separate from
 * userImageBackfill.ts (which imports the DB pool) so the node:test runner can
 * unit-test the matching/patch semantics in isolation. The SQL in
 * userImageBackfill.ts MUST mirror `matchesBackfillTarget` exactly; these
 * helpers are the single source of truth for that contract and what the tests
 * pin.
 */
import { brandSpellings } from "./brandAliasCore.ts";
import type { ProcessedImageRef } from "./scentEngineCore";

/** SQL parity: `lower(trim(x))`. No internal-whitespace collapse (the SQL does none). */
export function normalizeBackfillText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** The current image of a wardrobe row, or null when it has none (camel or legacy snake key). */
function existingImage(fragranceData: Record<string, unknown>): string | null {
  const camel = typeof fragranceData.imageUrl === "string" ? fragranceData.imageUrl.trim() : "";
  if (camel) return camel;
  const snake = typeof fragranceData.image_url === "string" ? fragranceData.image_url.trim() : "";
  return snake || null;
}

/**
 * Image-bearing keys to merge into `fragrance_data`. Everything else in the row
 * is preserved by the JSONB `||` merge, so only these keys are listed.
 */
export function buildImagePatch(image: ProcessedImageRef): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    imageUrl: image.imageUrl,
    imageHash: image.imageHash ?? null,
  };
  if (image.storagePath !== undefined) patch.storagePath = image.storagePath;
  if (image.storageProvider !== undefined) patch.storageProvider = image.storageProvider;
  if (image.sourceProvider !== undefined) patch.sourceProvider = image.sourceProvider;
  return patch;
}

/**
 * Whether a wardrobe row should receive the backfilled image. Mirrors the SQL
 * WHERE in userImageBackfill.ts exactly:
 *   - name matches (case/trim-insensitive),
 *   - brand is any spelling that canonicalizes to the target brand,
 *   - the row is currently imageless (never overwrite a real image / user override).
 */
export function matchesBackfillTarget(
  fragranceData: Record<string, unknown>,
  brand: string,
  name: string,
): boolean {
  const targetName = normalizeBackfillText(name);
  if (!targetName) return false;
  if (normalizeBackfillText(fragranceData.name) !== targetName) return false;

  const rowBrand = normalizeBackfillText(fragranceData.brand);
  if (!brandSpellings(brand).includes(rowBrand)) return false;

  return existingImage(fragranceData) === null;
}
