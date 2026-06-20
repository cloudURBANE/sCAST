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
import { resolveConcentrationFast } from "./concentrationResolver.ts";
import type {
  ScentVector,
  PerformanceMetrics,
  ContextProfile,
} from "./scentVectorizer";
import type { FragranceData } from "./datasetLoader";
import { resolvePyramidNotes } from "./fragranceNotes.ts";

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
  sourceProvider?: string;
  description?: string;
  error?: string;
}

export interface ProcessedImageRef {
  imageUrl?: string;
  storagePath?: string;
  imageHash?: string | null;
  storageProvider?: string;
  sourceProvider?: string;
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
  resolveCachedFragranceImage?: (
    brand: string,
    name: string,
  ) => Promise<ProcessedImageRef | null>;
  resolveProcessedFragranceImage: (
    opts: ResolveImageOpts,
  ) => Promise<ProcessedImageRef | null>;
  usableImageUrlForResponse: (url?: string) => Promise<string | null>;
  /**
   * BE-2: backfill a freshly-resolved image into already-persisted user
   * wardrobe rows for this fragrance that are *still imageless*. A deferred
   * save returns `imageUrl: ""`; the frontend persists the wardrobe row before
   * the background Serper pass finishes, so without this the resolved image
   * only ever lands in the shared catalog and the user's own tile stays empty
   * until a full reload. Implementations MUST only fill empty rows (never
   * overwrite an existing image or a user override) and match on brand+name.
   */
  backfillUserFragranceImages?: (
    brand: string,
    name: string,
    image: ProcessedImageRef,
  ) => Promise<void>;
  reportNonFatalError?: (
    area: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
  /**
   * Hybrid server-side resolve: fetch a not-yet-curated fragrance's real
   * notes/family/pyramid through the Python engine (which reaches Fragrantica
   * over Decodo's unblocked egress), so on-demand views render immediately
   * instead of sitting "pending" until the offline worker reaches the job.
   * Returns null on any miss/timeout; only consulted when `serverSideResolve`
   * is set and there is no local match/notes. See services/engineResolve.ts.
   */
  resolveProfileViaEngine?: (
    brand: string,
    name: string,
  ) => Promise<BuildProfileFallback | null>;
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
  /**
   * `inline` preserves legacy behavior. `deferred` uses catalog/cache images if
   * already available, then refreshes expensive image work in the background.
   * `skip` builds a text-only profile and does not enqueue image work.
   */
  imageResolution?: "inline" | "deferred" | "skip";
  /**
   * When true, a real-but-unenriched identity (no curated dataset match and no
   * notes yet — e.g. a freshly-clicked search result whose Fragrantica page has
   * not been scraped) yields a *minimal* neutral profile (family "Unknown
   * Family", neutral vector, concentration from the fast resolver) instead of
   * the hard `{ error: "Could not identify this fragrance" }`. This lets the
   * capture/add flow land the fragrance as a pending card while background
   * enrichment fills in the pyramid, rather than blocking the add outright.
   * The destructive-rebuild path deliberately leaves this off so a partial
   * match can never overwrite a user's stored fragrance with an empty profile.
   */
  allowMinimalFallback?: boolean;
  /**
   * When true, a real identity with no local (catalog/dataset/provided) notes
   * first attempts a synchronous server-side resolve through the Python engine
   * (Decodo egress) before falling back to the minimal pending profile. Opt-in
   * for the on-demand capture/search paths; the destructive-rebuild path leaves
   * it off so a transient engine result can never overwrite stored data.
   */
  serverSideResolve?: boolean;
}

export async function buildProfileWithDeps(
  deps: ScentEngineDeps,
  name: string,
  brand: string,
  fallbackInput?: BuildProfileFallback,
  opts?: BuildProfileOpts,
): Promise<ScentProfile | { error: string }> {
  // Mutable so the hybrid server-side resolve can fold engine-fetched notes in
  // before the rest of the function treats them like a provided fallback.
  let fallback = fallbackInput;
  const allowCatalogFuzzy = opts?.allowCatalogFuzzy ?? true;
  const preferEngineData = opts?.preferEngineData ?? false;
  const imageResolution = opts?.imageResolution ?? "inline";
  const allowMinimalFallback = opts?.allowMinimalFallback ?? false;
  const inputConcentration = resolveConcentrationFast(name, "", "");
  const concentrationOverride =
    opts?.concentrationOverride ??
    (inputConcentration?.confidence === 95 ? inputConcentration.concentration : undefined);
  const identity = deps.resolveFragranceIdentity(brand, name);
  const profileBrand = identity.brand;
  const profileName = identity.name;

  // 1. Check global catalog — exact match first, then fuzzy to catch AI naming variations
  let catalogBase: ScentProfile | null = null;
  const cached = await deps.getCatalogEntry(profileBrand, profileName);
  if (cached) {
    const cachedImageUrl = await deps.usableImageUrlForResponse(cached.imageUrl);
    const cachedWithUsableImage = cachedImageUrl ? { ...cached, imageUrl: cachedImageUrl } : cached;
    if (!preferEngineData && cachedImageUrl && !concentrationOverride) return cachedWithUsableImage;
    catalogBase = cachedWithUsableImage;
  }

  if (!catalogBase && allowCatalogFuzzy && !preferEngineData) {
    // Fuzzy search handles cases like "Sauvage EDP" matching stored "Sauvage"
    const fuzzy = await deps.searchCatalog(`${profileBrand} ${profileName}`);
    if (fuzzy) {
      const fuzzyImageUrl = await deps.usableImageUrlForResponse(fuzzy.imageUrl);
      if (fuzzyImageUrl && !concentrationOverride) return { ...fuzzy, imageUrl: fuzzyImageUrl };
      catalogBase = fuzzyImageUrl ? { ...fuzzy, imageUrl: fuzzyImageUrl } : fuzzy;
    }
  }

  // Dataset match is hoisted here (reused below) so the hybrid resolve only
  // fires when there is genuinely no local data to build from.
  const match = deps.findDatasetFragrance(profileBrand, profileName);

  // Hybrid server-side resolve: a real, not-yet-curated identity with no local
  // notes (no dataset match, no catalog base, no provided notes) is resolved
  // synchronously through the Python engine, which fetches Fragrantica over
  // Decodo's unblocked egress. On a hit we fold the engine's notes/family/
  // pyramid into `fallback` and the rest of the function builds a full profile;
  // on any miss/timeout we leave `fallback` untouched and fall through to the
  // existing minimal-pending behavior. Opt-in via `serverSideResolve`.
  if (
    opts?.serverSideResolve &&
    deps.resolveProfileViaEngine &&
    !match &&
    !catalogBase &&
    !(fallback?.notes && fallback.notes.length > 0) &&
    profileName.trim().length > 0
  ) {
    const resolved = await deps
      .resolveProfileViaEngine(profileBrand, profileName)
      .catch((error) => {
        deps.reportNonFatalError?.("scentEngine.serverSideResolve", error, {
          brand: profileBrand,
          name: profileName,
        });
        return null;
      });
    if (resolved && Array.isArray(resolved.notes) && resolved.notes.length > 0) {
      fallback = {
        notes: resolved.notes,
        family: resolved.family ?? fallback?.family,
        description: resolved.description ?? fallback?.description,
        imageUrl: fallback?.imageUrl ?? resolved.imageUrl,
        pyramid: resolved.pyramid ?? fallback?.pyramid,
        perfumer: resolved.perfumer ?? fallback?.perfumer,
      };
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
  const shouldPreserveCatalogImage = Boolean(concentrationOverride || imageResolution === "deferred");
  const preservedCatalogImage =
    shouldPreserveCatalogImage && catalogBase?.imageUrl
      ? {
          imageUrl: catalogBase.imageUrl,
          storagePath: catalogBase.storagePath,
          imageHash: catalogBase.imageHash ?? null,
          storageProvider: catalogBase.storageProvider,
          sourceProvider: catalogBase.sourceProvider,
        }
      : null;
  const resolveCachedImage = async (): Promise<ProcessedImageRef | null> => {
    if (!deps.resolveCachedFragranceImage) return null;
    return deps.resolveCachedFragranceImage(profileBrand, profileName).catch((err) => {
      deps.reportNonFatalError?.("scentEngine.cachedImageResolution", err, imageSearchContext);
      return null;
    });
  };

  // The engine's already-crawled/direct image URL — processing it costs NO paid
  // Serper image search (the `sourceUrl` path skips Serper entirely). Tried
  // before the Serper search below.
  const resolveImageFromCrawledUrl = async (): Promise<ProcessedImageRef | null> => {
    if (!effectiveFallback?.imageUrl) return null;
    const crawledUrl = effectiveFallback.imageUrl;
    return deps
      .resolveProcessedFragranceImage({
        brand: profileBrand,
        name: profileName,
        sourceUrl: crawledUrl,
        sourceProvider: "manual",
        allowLookupCache: false,
        removeBackground: true,
      })
      .catch((err) => {
        deps.reportNonFatalError?.("scentEngine.imageResolution", err, {
          brand: profileBrand,
          name: profileName,
          mode: "manual",
          sourceUrl: crawledUrl,
        });
        return null;
      });
  };

  // Paid Serper image search. Internally cache-aware: it re-checks the lookup-key
  // and search-query caches before spending a Serper call (see imagePipeline),
  // so that behavior is preserved — this is just the last resort.
  const resolveImageFromSerper = async (): Promise<ProcessedImageRef | null> =>
    deps
      .resolveProcessedFragranceImage({
        brand: profileBrand,
        name: profileName,
        searchQuery,
        removeBackground: true,
      })
      .catch((err) => {
        deps.reportNonFatalError?.("scentEngine.imageResolution", err, imageSearchContext);
        return null;
      });

  // Free crawled URL before the paid Serper search. When the engine already
  // handed us a usable direct image URL we process that (no Serper call); only
  // when it is absent or fails to resolve do we fall back to the Serper search,
  // which itself still consults the lookup-key and search-query caches before
  // spending a call — so that cache behavior is unchanged. (The deferred path
  // already checks the cache up front via resolveCachedImage, so re-checking it
  // here would be redundant.)
  const resolveImageNow = async (): Promise<ProcessedImageRef | null> => {
    if (effectiveFallback?.imageUrl) {
      const fromCrawl = await resolveImageFromCrawledUrl();
      if (fromCrawl) return fromCrawl;
    }
    return resolveImageFromSerper();
  };

  const processedImage =
    imageResolution === "skip"
      ? null
      : preservedCatalogImage ??
        (imageResolution === "deferred"
          ? await resolveCachedImage()
          : await resolveImageNow());

  const cleanImageUrl = processedImage?.imageUrl ?? null;

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
  const finalPyramid = engineFallbackComplete
    ? resolvePyramidNotes(effectiveFallback?.pyramid, match?.pyramid, finalNotes)
    : resolvePyramidNotes(match?.pyramid, effectiveFallback?.pyramid, finalNotes);
  const finalPerfumer =
    engineFallbackComplete && effectiveFallback?.perfumer
      ? effectiveFallback.perfumer
      : match?.perfumer || effectiveFallback?.perfumer;

  const hasUsableNotes = Array.isArray(finalNotes) && finalNotes.length > 0;
  const hasResolvedIdentity = profileName.trim().length > 0;
  if (!match && !hasUsableNotes && !(allowMinimalFallback && hasResolvedIdentity)) {
    // No curated match and no notes. The capture/add flow opts into a minimal
    // neutral profile (so a real, not-yet-scraped fragrance still lands in the
    // vault as a pending card); every other caller still gets the hard error.
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
    const concentrationName = [name, finalName].filter(Boolean).join(" ");
    const concentrationDescription = [brand !== finalBrand ? brand : "", finalDescription]
      .filter(Boolean)
      .join(" ");
    const fast = resolveConcentrationFast(concentrationName, finalBrand, concentrationDescription);
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
    sourceProvider: processedImage?.sourceProvider,
    description: finalDescription,
  };

  // 3. Save to global catalog so future users skip all the above work
  await deps.saveCatalogEntry(finalBrand, finalName, profile).catch((err) => {
    deps.reportNonFatalError?.("scentEngine.catalogSave", err, {
      brand: finalBrand,
      name: finalName,
    });
  });

  if (imageResolution === "deferred" && !processedImage) {
    void resolveImageNow()
      .then(async (image) => {
        if (!image?.imageUrl) return;
        await deps.saveCatalogEntry(finalBrand, finalName, {
          ...profile,
          imageUrl: image.imageUrl,
          storagePath: image.storagePath,
          imageHash: image.imageHash ?? null,
          storageProvider: image.storageProvider,
          sourceProvider: image.sourceProvider,
        });
        // BE-2: the deferred save returned an empty image and the frontend has
        // already persisted the wardrobe row(s) by now. Push the resolved image
        // into any still-imageless user_fragrances rows for this fragrance so
        // the user's tile self-heals without waiting for a full reload.
        await deps
          .backfillUserFragranceImages?.(finalBrand, finalName, image)
          .catch((err) => {
            deps.reportNonFatalError?.("scentEngine.userImageBackfill", err, {
              brand: finalBrand,
              name: finalName,
            });
          });
      })
      .catch((err) => {
        deps.reportNonFatalError?.("scentEngine.deferredImageResolution", err, {
          brand: finalBrand,
          name: finalName,
        });
      });
  }

  return profile;
}
