import { getCatalogEntry, searchCatalog } from "./catalogService";
import { getOrCreateCachedImage } from "./firebaseCache";

function hasImageUrl(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the most reliable image for a fragrance across shared stores:
 * 1) exact catalog key (Postgres), 2) fuzzy catalog lookup, 3) Firestore cache.
 */
export async function resolveSharedImageUrl(
  brand: string,
  name: string,
): Promise<string | null> {
  try {
    const exact = await getCatalogEntry(brand, name);
    if (hasImageUrl(exact?.imageUrl)) return exact.imageUrl;
  } catch {
    /* non-fatal */
  }

  try {
    const fuzzy = await searchCatalog(`${brand} ${name}`);
    if (hasImageUrl(fuzzy?.imageUrl)) return fuzzy.imageUrl;
  } catch {
    /* non-fatal */
  }

  try {
    // Read-through from Firestore cache only; do not trigger new image generation here.
    const cached = await getOrCreateCachedImage(brand, name, async () => null);
    if (hasImageUrl(cached)) return cached;
  } catch {
    /* non-fatal */
  }

  return null;
}
