import type { FragranceData } from "./datasetLoader";
import { parseFragrance } from "./scentParser";
import { vectorize, calculatePerformance, calculateContext, type ScentVector, type PerformanceMetrics, type ContextProfile } from "./scentVectorizer";
import { getCatalogEntry, saveCatalogEntry, searchCatalog } from "./catalogService";
import { resolveProcessedFragranceImage } from "./imagePipeline";
import { usableImageUrlForResponse } from "./imageHydration";
import {
  findDatasetFragrance,
  resolveFragranceIdentity,
  searchFragranceDataset,
} from "./fragranceNameResolver";

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
  storagePath?: string;
  imageHash?: string | null;
  storageProvider?: string;
  description?: string;
  error?: string;
}

function findFragrance(name: string, brand: string): FragranceData | undefined {
  return findDatasetFragrance(brand, name);
}

export function searchFragrances(query: string): FragranceData[] {
  return searchFragranceDataset(query);
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
    /**
     * When set, replaces the brand+name prefix used for the Serper image
     * search. The standard packshot keywords are still appended. Used by
     * the BaseNotes candidate-selection layer so the image lookup uses the
     * authoritative search label rather than the user's typo.
     */
    imageSearchLabel?: string;
    /**
     * When set, fully overrides the dataset/scrape notes used when building
     * the final profile. Pyramid override wins over the legacy classifier.
     */
    notesOverride?: {
      notes?: string[];
      pyramid?: { top: string[]; heart: string[]; base: string[] };
    };
    /**
     * When false, exact-lookup-key catalog lookup is also skipped (in
     * addition to fuzzy). Used by the BaseNotes flow so a previously cached
     * weak profile cannot pre-empt the BaseNotes-authoritative one.
     */
    skipCatalogLookup?: boolean;
  },
): Promise<ScentProfile | { error: string }> {
  const allowCatalogFuzzy = opts?.allowCatalogFuzzy ?? true;
  const skipCatalogLookup = opts?.skipCatalogLookup === true;
  const identity = resolveFragranceIdentity(brand, name);
  const profileBrand = identity.brand;
  const profileName = identity.name;

  // 1. Check global catalog — exact match first, then fuzzy to catch AI naming variations.
  //    The BaseNotes-authoritative path skips both lookups so notes/pyramid coming
  //    from a freshly parsed BaseNotes detail always win over a cached weak profile.
  let catalogBase: ScentProfile | null = null;
  if (!skipCatalogLookup) {
    const cached = await getCatalogEntry(profileBrand, profileName);
    if (cached) {
      const cachedImageUrl = await usableImageUrlForResponse(cached.imageUrl);
      if (cachedImageUrl && !opts?.notesOverride) {
        return { ...cached, imageUrl: cachedImageUrl };
      }
      catalogBase = cached;
    }
  }

  if (!catalogBase && !skipCatalogLookup && allowCatalogFuzzy) {
    // Fuzzy search handles cases like "Sauvage EDP" matching stored "Sauvage"
    const fuzzy = await searchCatalog(`${profileBrand} ${profileName}`);
    if (fuzzy) {
      const fuzzyImageUrl = await usableImageUrlForResponse(fuzzy.imageUrl);
      if (fuzzyImageUrl && !opts?.notesOverride) {
        return { ...fuzzy, imageUrl: fuzzyImageUrl };
      }
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
  // When the caller supplies an authoritative searchLabel (e.g. from a
  // BaseNotes detail), use it as the query subject so the image search
  // is anchored to the selected identity rather than the user's typo.
  const imageSearchSubject = opts?.imageSearchLabel?.trim() || `${profileBrand} ${profileName}`;
  const searchQuery = `${imageSearchSubject} single fragrance bottle no box HQ product photo studio no plants`;
  const processedImage =
    await resolveProcessedFragranceImage({
      brand: profileBrand,
      name: profileName,
      searchQuery,
      removeBackground: true,
    }).catch(() => null) ??
    (effectiveFallback?.imageUrl
      ? await resolveProcessedFragranceImage({
          brand: profileBrand,
          name: profileName,
          sourceUrl: effectiveFallback.imageUrl,
          sourceProvider: "manual",
          allowLookupCache: false,
          removeBackground: true,
        }).catch(() => null)
      : null);

  const cleanImageUrl = processedImage?.imageUrl ?? null;

  const match = findFragrance(profileName, profileBrand);
  const finalName = match?.name || catalogBase?.product.name || profileName;
  const finalBrand = match?.brand || catalogBase?.product.brand || profileBrand;

  // BaseNotes overrides win over dataset/scrape values when available.
  const overridePyramid = opts?.notesOverride?.pyramid;
  const overrideFlatNotes = opts?.notesOverride?.notes;
  const overridePyramidFlattened = overridePyramid
    ? [...overridePyramid.top, ...overridePyramid.heart, ...overridePyramid.base]
    : undefined;
  const finalNotes =
    overridePyramidFlattened?.length
      ? overridePyramidFlattened
      : overrideFlatNotes?.length
        ? overrideFlatNotes
        : match?.notes || effectiveFallback?.notes || [];
  const finalFamily = match?.family || effectiveFallback?.family || "Unknown Family";
  const finalDescription = match?.description || effectiveFallback?.description || "";
  const finalPyramid = overridePyramid || match?.pyramid || effectiveFallback?.pyramid;
  const finalPerfumer = match?.perfumer || effectiveFallback?.perfumer;

  if (!match && (!effectiveFallback || !effectiveFallback.notes) && finalNotes.length === 0) {
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
    storagePath: processedImage?.storagePath,
    imageHash: processedImage?.imageHash ?? null,
    storageProvider: processedImage?.storageProvider,
    description: finalDescription,
  };

  // 3. Save to global catalog so future users skip all the above work
  await saveCatalogEntry(finalBrand, finalName, profile).catch(() => { /* non-fatal */ });

  return profile;
}
