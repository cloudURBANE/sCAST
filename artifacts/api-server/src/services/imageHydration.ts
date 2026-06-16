import { getCatalogEntry, searchCatalog } from "./catalogService";
import { isLikelySameFragranceIdentity } from "./fragranceNameResolver";
import { resolveCachedFragranceImage } from "./imagePipeline";
import { safeImageUrlForResponse } from "./persistenceGuards";
export { usableImageUrlForResponse } from "./imageReference";
import { usableImageUrlForResponse } from "./imageReference";

function hasImageUrl(value: unknown): value is string {
  return safeImageUrlForResponse(value).length > 0;
}

export type SharedImageReference = {
  imageUrl: string;
  sourceProvider?: string | null;
  sourceUrl?: string | null;
  storagePath?: string | null;
  /** Orientation Engine geometry when the cache image is a normalized square. */
  imageProperties?: unknown;
};

async function catalogProfileImageReference(profile: Record<string, unknown> | null | undefined): Promise<SharedImageReference | null> {
  const imageUrl = await usableImageUrlForResponse(profile?.imageUrl);
  if (!imageUrl) return null;
  return {
    imageUrl,
    sourceProvider: typeof profile?.sourceProvider === "string" ? profile.sourceProvider : null,
    sourceUrl: typeof profile?.sourceUrl === "string" ? profile.sourceUrl : null,
    storagePath: typeof profile?.storagePath === "string" ? profile.storagePath : null,
  };
}

/**
 * Resolve the most reliable image for a fragrance across shared stores:
 * 1) verified processed image cache, 2) exact catalog key (Postgres),
 * 3) fuzzy catalog lookup gated by the resolver scorer.
 */
export async function resolveSharedImageReference(
  brand: string,
  name: string,
): Promise<SharedImageReference | null> {
  try {
    // Metadata-only read-through from image_cache. Prefer this over saved
    // catalog URLs so older persisted refs cannot pin production to stale
    // processed objects after the pipeline has produced a newer clean image.
    const cached = await resolveCachedFragranceImage(brand, name);
    if (cached?.backgroundRemoved && hasImageUrl(cached.imageUrl)) {
      return {
        imageUrl: cached.imageUrl,
        sourceProvider: cached.sourceProvider,
        sourceUrl: cached.sourceUrl ?? null,
        storagePath: cached.storagePath,
        imageProperties: cached.imageProperties ?? null,
      };
    }
  } catch {
    /* non-fatal */
  }

  try {
    const exact = await getCatalogEntry(brand, name);
    const exactRef = await catalogProfileImageReference(exact as unknown as Record<string, unknown> | null);
    if (exactRef) return exactRef;
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
        const fuzzyRef = await catalogProfileImageReference(fuzzy as unknown as Record<string, unknown>);
        if (fuzzyRef) return fuzzyRef;
      }
    }
  } catch {
    /* non-fatal */
  }

  return null;
}

export async function resolveSharedImageUrl(
  brand: string,
  name: string,
): Promise<string | null> {
  return (await resolveSharedImageReference(brand, name))?.imageUrl ?? null;
}
