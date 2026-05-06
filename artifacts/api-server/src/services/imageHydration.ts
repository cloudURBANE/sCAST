import { getCatalogEntry, searchCatalog } from "./catalogService";
import { resolveCachedFragranceImage } from "./imagePipeline";
import { safeImageUrlForResponse } from "./persistenceGuards";

function hasImageUrl(value: unknown): value is string {
  return safeImageUrlForResponse(value).length > 0;
}

/**
 * Token-set check: every whitespace token of `needle` must appear inside
 * `haystack` (case-insensitive). Used to validate that a fuzzy catalog
 * hit actually represents the same product as the input — otherwise a
 * search for "Bleu de Chanel" could pick up "Bleu" or "Coco Chanel" and
 * we'd hand back the wrong image (B3).
 */
function tokensSubsetOf(needle: string, haystack: string): boolean {
  const h = haystack.toLowerCase();
  const tokens = needle
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 1); // drop short noise like "a"/"l"
  if (tokens.length === 0) return false;
  return tokens.every(t => h.includes(t));
}

/**
 * Resolve the most reliable image for a fragrance across shared stores:
 * 1) exact catalog key (Postgres), 2) fuzzy catalog lookup (gated on
 *    name/brand match), 3) Firestore cache.
 */
export async function resolveSharedImageUrl(
  brand: string,
  name: string,
): Promise<string | null> {
  try {
    const exact = await getCatalogEntry(brand, name);
    if (hasImageUrl(exact?.imageUrl)) return safeImageUrlForResponse(exact?.imageUrl);
  } catch {
    /* non-fatal */
  }

  try {
    const fuzzy = await searchCatalog(`${brand} ${name}`);
    if (fuzzy && hasImageUrl(fuzzy.imageUrl)) {
      const fuzzyName = fuzzy.product?.name ?? "";
      const fuzzyBrand = fuzzy.product?.brand ?? "";
      // Only trust the fuzzy hit if both the requested name and brand
      // tokens appear in the matched catalog row — otherwise we'd be
      // hydrating the dashboard with a different fragrance's image.
      if (
        tokensSubsetOf(name, fuzzyName) &&
        tokensSubsetOf(brand, fuzzyBrand)
      ) {
        return safeImageUrlForResponse(fuzzy.imageUrl);
      }
    }
  } catch {
    /* non-fatal */
  }

  try {
    // Metadata-only read-through from image_cache. This does not trigger Serper,
    // downloads, or background removal.
    const cached = await resolveCachedFragranceImage(brand, name);
    if (hasImageUrl(cached?.imageUrl)) return cached.imageUrl;
  } catch {
    /* non-fatal */
  }

  return null;
}
