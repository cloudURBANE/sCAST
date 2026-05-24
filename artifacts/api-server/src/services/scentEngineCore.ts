/**
 * Pure, dependency-free core of the scent engine.
 *
 * No runtime imports — everything the orchestration needs is injected via
 * `ScentEngineDeps`. The DB-backed / network-backed wrappers live in
 * scentEngine.ts and wire concrete implementations. This separation lets the
 * node:test runner load and unit-test the branching matrix in isolation
 * (see scentEngineCore.test.ts), since the bare runner cannot follow the
 * extensionless relative imports used by catalogService / imagePipeline.
 */

import type { ParsedFragrance, Concentration } from "./scentParser";
import { resolveConcentrationFast } from "./concentrationResolver";
import type {
  ScentVector,
  PerformanceMetrics,
  ContextProfile,
} from "./scentVectorizer";
import type { FragranceData } from "./datasetLoader";

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

export interface ProcessedImageRef {
  imageUrl?: string;
  storagePath?: string;
  imageHash?: string | null;
  storageProvider?: string;
}

export interface ResolveImageOpts {
  brand: string;
  name: string;
  searchQuery?: string;
  sourceUrl?: string;
  sourceProvider?: "manual" | "serper";
  allowLookupCache?: boolean;
  removeBackground?: boolean;
}

export interface FragranceIdentity {
  brand: string;
  name: string;
  corrected?: boolean;
  confidence?: number;
}

export interface ScentEngineDeps {
  // Pure helpers (injected so the Core stays dependency-free)
  parseFragrance: (data: FragranceData | undefined) => ParsedFragrance | null;
  vectorize: (parsed: ParsedFragrance) => ScentVector;
  calculatePerformance: (
    vector: ScentVector,
    family: string,
    concentration: string,
  ) => PerformanceMetrics;
  calculateContext: (vector: ScentVector) => ContextProfile;

  // Identity resolution + dataset lookup
  resolveFragranceIdentity: (brand: string, name: string) => FragranceIdentity;
  findDatasetFragrance: (brand: string, name: string) => FragranceData | undefined;

  // Catalog (DB-backed in production)
  getCatalogEntry: (brand: string, name: string) => Promise<ScentProfile | null>;
  searchCatalog: (query: string) => Promise<ScentProfile | null>;
  saveCatalogEntry: (
    brand: string,
    name: string,
    profile: ScentProfile,
  ) => Promise<unknown>;

  // Image pipeline (Serper/Poof/storage in production)
  resolveProcessedFragranceImage: (
    opts: ResolveImageOpts,
  ) => Promise<ProcessedImageRef | null>;
  usableImageUrlForResponse: (url?: string) => Promise<string | null>;
  reportNonFatalError?: (
    area: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
}

export interface BuildProfileFallback {
  notes?: string[];
  family?: string;
  description?: string;
  imageUrl?: string;
  pyramid?: { top: string[]; heart: string[]; base: string[] };
  perfumer?: string;
}

export interface BuildProfileOpts {
  /**
   * When false, the catalog *fuzzy* fallback is skipped. The destructive
   * rebuild path uses this so a partial substring match in `searchCatalog`
   * can never replace the user's stored fragrance with a different
   * product (B2). Exact `lookup_key` lookup, dataset/scrape, and image
   * cache resolution still run.
   */
  allowCatalogFuzzy?: boolean;
  /**
   * When true (external fragrance engine already supplied notes/metadata):
   * do not return an early full-catalog hit; skip fuzzy catalog search;
   * prefer `fallback` for notes/pyramid/etc.; always re-run vectorization
   * and the image pipeline so `global_fragrances` stores engine + image
   * together.
   */
  preferEngineData?: boolean;
  /** Overrides parsed concentration (performance metrics + stored profile). */
  concentrationOverride?: Concentration;
}

export async function buildProfileWithDeps(
  deps: ScentEngineDeps,
  name: string,
  brand: string,
  fallback?: BuildProfileFallback,
  opts?: BuildProfileOpts,
): Promise<ScentProfile | { error: string }> {
  const allowCatalogFuzzy = opts?.allowCatalogFuzzy ?? true;
  const preferEngineData = opts?.preferEngineData ?? false;
  const concentrationOverride = opts?.concentrationOverride;
  const identity = deps.resolveFragranceIdentity(brand, name);
  const profileBrand = identity.brand;
  const profileName = identity.name;

  // 1. Check global catalog — exact match first, then fuzzy to catch AI naming variations
  let catalogBase: ScentProfile | null = null;
  const cached = await deps.getCatalogEntry(profileBrand, profileName);
  if (cached && !preferEngineData) {
    const cachedImageUrl = await deps.usableImageUrlForResponse(cached.imageUrl);
    if (cachedImageUrl) return { ...cached, imageUrl: cachedImageUrl };
    catalogBase = cached;
  } else if (cached && preferEngineData) {
    catalogBase = cached;
  }

  if (!catalogBase && allowCatalogFuzzy && !preferEngineData) {
    // Fuzzy search handles cases like "Sauvage EDP" matching stored "Sauvage"
    const fuzzy = await deps.searchCatalog(`${profileBrand} ${profileName}`);
    if (fuzzy) {
      const fuzzyImageUrl = await deps.usableImageUrlForResponse(fuzzy.imageUrl);
      if (fuzzyImageUrl) return { ...fuzzy, imageUrl: fuzzyImageUrl };
      catalogBase = fuzzy;
    }
  }

  const engineFallbackComplete =
    preferEngineData &&
    fallback &&
    Array.isArray(fallback.notes) &&
    fallback.notes.length > 0;

  const effectiveFallback = engineFallbackComplete
    ? {
        notes: fallback!.notes,
        family: fallback!.family ?? catalogBase?.family,
        description: fallback!.description ?? catalogBase?.description,
        imageUrl: fallback!.imageUrl,
        pyramid: fallback!.pyramid ?? catalogBase?.pyramid,
        perfumer: fallback!.perfumer ?? catalogBase?.product.perfumer,
      }
    : catalogBase
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
  const searchQuery = `${profileBrand} ${profileName} single fragrance bottle no box HQ product photo studio no plants`;
  const imageSearchContext = {
    brand: profileBrand,
    name: profileName,
    mode: "search",
  };
  const processedImage =
    (await deps
      .resolveProcessedFragranceImage({
        brand: profileBrand,
        name: profileName,
        searchQuery,
        removeBackground: true,
      })
      .catch((err) => {
        deps.reportNonFatalError?.("scentEngine.imageResolution", err, imageSearchContext);
        return null;
      })) ??
    (effectiveFallback?.imageUrl
      ? await deps
          .resolveProcessedFragranceImage({
            brand: profileBrand,
            name: profileName,
            sourceUrl: effectiveFallback.imageUrl,
            sourceProvider: "manual",
            allowLookupCache: false,
            removeBackground: true,
          })
          .catch((err) => {
            deps.reportNonFatalError?.("scentEngine.imageResolution", err, {
              brand: profileBrand,
              name: profileName,
              mode: "manual",
              sourceUrl: effectiveFallback.imageUrl,
            });
            return null;
          })
      : null);

  const cleanImageUrl = processedImage?.imageUrl ?? null;

  const match = deps.findDatasetFragrance(profileBrand, profileName);
  const finalName = match?.name || catalogBase?.product.name || profileName;
  const finalBrand = match?.brand || catalogBase?.product.brand || profileBrand;
  const finalNotes: string[] = engineFallbackComplete
    ? effectiveFallback?.notes ?? []
    : match?.notes ?? effectiveFallback?.notes ?? [];
  const finalFamily =
    engineFallbackComplete && effectiveFallback?.family
      ? effectiveFallback.family
      : match?.family || effectiveFallback?.family || "Unknown Family";
  const finalDescription =
    engineFallbackComplete && effectiveFallback?.description != null
      ? String(effectiveFallback.description)
      : match?.description || effectiveFallback?.description || "";
  const finalPyramid =
    engineFallbackComplete && effectiveFallback?.pyramid
      ? effectiveFallback.pyramid
      : match?.pyramid || effectiveFallback?.pyramid;
  const finalPerfumer =
    engineFallbackComplete && effectiveFallback?.perfumer
      ? effectiveFallback.perfumer
      : match?.perfumer || effectiveFallback?.perfumer;

  const hasUsableNotes = Array.isArray(finalNotes) && finalNotes.length > 0;
  if (!match && !hasUsableNotes) {
    return { error: "Could not identify this fragrance. Try a more specific name." };
  }

  let parsed = deps.parseFragrance({
    name: finalName,
    brand: finalBrand,
    notes: finalNotes,
    family: finalFamily,
    description: finalDescription,
    pyramid: finalPyramid,
    perfumer: finalPerfumer,
  } as FragranceData);

  if (!parsed) return { error: "Failed to parse fragrance data." };

  if (parsed.concentration === "Unknown") {
    const fast = resolveConcentrationFast(finalName, finalBrand, finalDescription);
    if (fast && fast.confidence >= 75) {
      parsed = { ...parsed, concentration: fast.concentration };
    }
  }

  if (concentrationOverride) {
    parsed = { ...parsed, concentration: concentrationOverride };
  }

  const vector = deps.vectorize(parsed);
  const performance = deps.calculatePerformance(vector, finalFamily, parsed.concentration);
  const context = deps.calculateContext(vector);

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
  await deps.saveCatalogEntry(finalBrand, finalName, profile).catch((err) => {
    deps.reportNonFatalError?.("scentEngine.catalogSave", err, {
      brand: finalBrand,
      name: finalName,
    });
  });

  return profile;
}
