import { getCatalogEntry, searchCatalog } from "./catalogService";
import { isLikelySameFragranceIdentity } from "./fragranceNameResolver";
import { resolveCachedFragranceImage } from "./imagePipeline";
import { safeImageUrlForResponse } from "./persistenceGuards";
export { usableImageUrlForResponse } from "./imageReference";
import { usableImageUrlForResponse } from "./imageReference";

function hasImageUrl(value: unknown): value is string {
  return safeImageUrlForResponse(value).length > 0;
}

/**
 * Resolve the most reliable image for a fragrance across shared stores:
 * 1) verified processed image cache, 2) exact catalog key (Postgres),
 * 3) fuzzy catalog lookup gated by the resolver scorer.
 */
export async function resolveSharedImageUrl(
  brand: string,
  name: string,
): Promise<string | null> {
  try {
    // Metadata-only read-through from image_cache. Prefer this over saved
    // catalog URLs so older persisted refs cannot pin production to stale
    // processed objects after the pipeline has produced a newer clean image.
    const cached = await resolveCachedFragranceImage(brand, name);
    if (cached?.backgroundRemoved && hasImageUrl(cached.imageUrl)) return cached.imageUrl;
  } catch {
    /* non-fatal */
  }

  try {
    const exact = await getCatalogEntry(brand, name);
    const exactImageUrl = await usableImageUrlForResponse(exact?.imageUrl);
    if (exactImageUrl) return exactImageUrl;
  } catch {
    /* non-fatal */
  }

  try {
    const fuzzy = await searchCatalog(`${brand} ${name}`);
    if (fuzzy && hasImageUrl(fuzzy.imageUrl)) {
      const fuzzyName = fuzzy.product?.name ?? "";
      const fuzzyBrand = fuzzy.product?.brand ?? "";
      if (
        isLikelySameFragranceIdentity(
          { brand, name },
          { brand: fuzzyBrand, name: fuzzyName },
        )
      ) {
        const fuzzyImageUrl = await usableImageUrlForResponse(fuzzy.imageUrl);
        if (fuzzyImageUrl) return fuzzyImageUrl;
      }
    }
  } catch {
    /* non-fatal */
  }

  return null;
}
