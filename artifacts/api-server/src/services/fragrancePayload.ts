import { resolveSharedImageUrl } from "./imageHydration";
import {
  safeImageUrlForResponse,
  stripBase64ImageDataUrls,
} from "./persistenceGuards";

/** Strip base64 data URLs. Postgres must never be used as the image CDN. */
export function sanitizeFragrance(fragrance: Record<string, any>): Record<string, any> {
  return stripBase64ImageDataUrls(fragrance);
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

  return {
    ...fragrance,
    imageUrl,
    ...(name ? { name } : {}),
    ...(brand ? { brand } : {}),
    ...(perfumer ? { perfumer } : {}),
  };
}

/** Fill in imageUrl from shared metadata/object cache if the stored record has none. */
export async function hydrateImageUrl(fragrance: Record<string, any>): Promise<Record<string, any>> {
  const current = safeImageUrlForResponse(fragrance.imageUrl);
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
