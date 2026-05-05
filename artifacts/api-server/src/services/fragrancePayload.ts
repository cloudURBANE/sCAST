import { resolveSharedImageUrl } from "./imageHydration";

/** Strip base64 data URLs — they're huge and already stored in the global catalog */
export function sanitizeFragrance(fragrance: Record<string, any>): Record<string, any> {
  const clean = { ...fragrance };
  if (typeof clean.imageUrl === "string" && clean.imageUrl.startsWith("data:")) {
    clean.imageUrl = "";
  }
  return clean;
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

  return {
    ...fragrance,
    ...(name ? { name } : {}),
    ...(brand ? { brand } : {}),
    ...(perfumer ? { perfumer } : {}),
  };
}

/** Fill in imageUrl from the global catalog if the stored record has none */
export async function hydrateImageUrl(fragrance: Record<string, any>): Promise<Record<string, any>> {
  if (fragrance.imageUrl) return fragrance;
  const name = fragrance.name as string | undefined;
  const brand = fragrance.brand as string | undefined;
  if (!name || !brand) return fragrance;
  try {
    const imageUrl = await resolveSharedImageUrl(brand, name);
    if (imageUrl) return { ...fragrance, imageUrl };
  } catch {
    /* non-fatal */
  }
  return fragrance;
}
