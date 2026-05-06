import { loadDataset, type FragranceData } from "./datasetLoader";
import { parseFragrance } from "./scentParser";
import { vectorize, calculatePerformance, calculateContext, type ScentVector, type PerformanceMetrics, type ContextProfile } from "./scentVectorizer";
import { getCatalogEntry, saveCatalogEntry, searchCatalog } from "./catalogService";
import { resolveProcessedFragranceImage } from "./imagePipeline";
import { safeImageUrlForResponse } from "./persistenceGuards";

export interface ScentProfile {
  product: { name: string; brand: string; perfumer?: string };
  scent_vector: ScentVector;
  performance: PerformanceMetrics;
  context: ContextProfile;
  notes: string[];
  pyramid?: { top: string[]; heart: string[]; base: string[] };
  family: string;
  concentration: string;
  accords: string[];
  imageUrl?: string;
  description?: string;
  error?: string;
}

function findFragrance(name: string, brand: string): FragranceData | undefined {
  const dataset = loadDataset();
  const searchName = name.toLowerCase();
  const searchBrand = brand.toLowerCase();
  const combined = `${brand} ${name}`.toLowerCase().trim();

  return dataset.find(item => {
    const itemName = item.name.toLowerCase();
    const itemBrand = item.brand.toLowerCase();
    const full = `${itemBrand} ${itemName}`.toLowerCase();
    return (
      (itemBrand === searchBrand && itemName.includes(searchName)) ||
      (brand === "" && itemName.includes(searchName)) ||
      (brand === "" && full.includes(searchName)) ||
      itemName === searchName ||
      full === combined
    );
  });
}

export function searchFragrances(query: string): FragranceData[] {
  const dataset = loadDataset();
  const q = query.toLowerCase();
  return dataset.filter(item => {
    const itemName = item.name.toLowerCase();
    const itemBrand = item.brand.toLowerCase();
    const full = `${itemBrand} ${itemName}`.toLowerCase();
    return itemName.includes(q) || itemBrand.includes(q) || full.includes(q);
  });
}

export async function buildProfile(
  name: string,
  brand: string,
  fallback?: {
    notes?: string[];
    family?: string;
    description?: string;
    imageUrl?: string;
    pyramid?: { top: string[]; heart: string[]; base: string[] };
    perfumer?: string;
  },
  opts?: {
    /**
     * When false, the catalog *fuzzy* fallback is skipped. The destructive
     * rebuild path uses this so a partial substring match in `searchCatalog`
     * can never replace the user's stored fragrance with a different
     * product (B2). Exact `lookup_key` lookup, dataset/scrape, and image
     * cache resolution still run.
     */
    allowCatalogFuzzy?: boolean;
  },
): Promise<ScentProfile | { error: string }> {
  const allowCatalogFuzzy = opts?.allowCatalogFuzzy ?? true;

  // 1. Check global catalog — exact match first, then fuzzy to catch AI naming variations
  let catalogBase: ScentProfile | null = null;
  const cached = await getCatalogEntry(brand, name);
  if (cached) {
    if (safeImageUrlForResponse(cached.imageUrl)) return cached;
    catalogBase = cached;
  }

  if (!catalogBase && allowCatalogFuzzy) {
    // Fuzzy search handles cases like "Sauvage EDP" matching stored "Sauvage"
    const fuzzy = await searchCatalog(`${brand} ${name}`);
    if (fuzzy) {
      if (safeImageUrlForResponse(fuzzy.imageUrl)) return fuzzy;
      catalogBase = fuzzy;
    }
  }

  const effectiveFallback = catalogBase
    ? {
        notes: catalogBase.notes,
        family: catalogBase.family,
        description: catalogBase.description,
        imageUrl: fallback?.imageUrl,
        pyramid: catalogBase.pyramid,
        perfumer: catalogBase.product.perfumer,
      }
    : fallback;

  // 2. Resolve image through metadata/object cache. This checks image_cache
  // before Serper and writes only object references to Postgres.
  const searchQuery = `${brand} ${name} single fragrance bottle no box HQ product photo studio no plants`;
  const processedImage =
    await resolveProcessedFragranceImage({
      brand,
      name,
      searchQuery,
      removeBackground: true,
    }).catch(() => null) ??
    (effectiveFallback?.imageUrl
      ? await resolveProcessedFragranceImage({
          brand,
          name,
          sourceUrl: effectiveFallback.imageUrl,
          sourceProvider: "manual",
          allowLookupCache: false,
          removeBackground: true,
        }).catch(() => null)
      : null);

  const cleanImageUrl = processedImage?.imageUrl ?? null;

  const match = findFragrance(name, brand);
  const finalName = match?.name || catalogBase?.product.name || name;
  const finalBrand = match?.brand || catalogBase?.product.brand || brand;
  const finalNotes = match?.notes || effectiveFallback?.notes || [];
  const finalFamily = match?.family || effectiveFallback?.family || "Unknown Family";
  const finalDescription = match?.description || effectiveFallback?.description || "";
  const finalPyramid = match?.pyramid || effectiveFallback?.pyramid;
  const finalPerfumer = match?.perfumer || effectiveFallback?.perfumer;

  if (!match && (!effectiveFallback || !effectiveFallback.notes)) {
    return { error: "Could not identify this fragrance. Try a more specific name." };
  }

  const parsed = parseFragrance({
    name: finalName,
    brand: finalBrand,
    notes: finalNotes,
    family: finalFamily,
    description: finalDescription,
    pyramid: finalPyramid,
    perfumer: finalPerfumer,
  } as FragranceData);

  if (!parsed) return { error: "Failed to parse fragrance data." };

  const vector = vectorize(parsed);
  const performance = calculatePerformance(vector, finalFamily, parsed.concentration);
  const context = calculateContext(vector);

  const profile: ScentProfile = {
    product: {
      name: finalName,
      brand: finalBrand,
      ...(parsed.perfumer ? { perfumer: parsed.perfumer } : {}),
    },
    scent_vector: vector,
    performance,
    context,
    notes: finalNotes,
    pyramid: finalPyramid,
    family: finalFamily,
    concentration: parsed.concentration,
    accords: parsed.accords,
    imageUrl: cleanImageUrl ?? undefined,
    description: finalDescription,
  };

  // 3. Save to global catalog so future users skip all the above work
  await saveCatalogEntry(finalBrand, finalName, profile).catch(() => { /* non-fatal */ });

  return profile;
}
