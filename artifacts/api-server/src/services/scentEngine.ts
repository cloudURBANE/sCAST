import type { FragranceData } from "./datasetLoader";
import { parseFragrance } from "./scentParser";
import { vectorize, calculatePerformance, calculateContext, assessVectorCoverage } from "./scentVectorizer";
import { getCatalogEntry, saveCatalogEntry, searchCatalog } from "./catalogService";
import { backfillUserFragranceImages } from "./userImageBackfill";
import { resolveCachedFragranceImage, resolveProcessedFragranceImage } from "./imagePipeline";
import { usableImageUrlForResponse } from "./imageHydration";
import { resolveProfileViaEngine } from "./engineResolve";
import { logger } from "../lib/logger";
import {
  findDatasetFragrance,
  resolveFragranceIdentity,
  searchFragranceDataset,
} from "./fragranceNameResolver";
import { makeLookupKey } from "./catalogService";
import {
  buildProfileWithDeps,
  type BuildProfileFallback,
  type BuildProfileOpts,
  type ScentEngineDeps,
  type ScentProfile,
} from "./scentEngineCore";

export type { ScentProfile } from "./scentEngineCore";

// BE-3: backoff for re-attempting the deferred background image resolution when
// the first pass finds no image. Spaced to land within the frontend's new-add
// poll burst (6/12/20/32/48s) and the 60s wardrobe poll, so a recovered image
// surfaces on a tile without a re-add or manual "Find image". Bounded (3 retries)
// to keep Serper re-spend in check.
const DEFERRED_IMAGE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

const DEPS: ScentEngineDeps = {
  deferredImageRetryDelaysMs: DEFERRED_IMAGE_RETRY_DELAYS_MS,
  parseFragrance,
  vectorize,
  calculatePerformance,
  calculateContext,
  assessVectorCoverage,
  resolveFragranceIdentity,
  findDatasetFragrance,
  getCatalogEntry,
  searchCatalog,
  saveCatalogEntry,
  resolveCachedFragranceImage,
  // Automatic resolution paths (the engine-crawled fallback and the auto
  // Serper search — the only callers of this dep) opt into the vision
  // validation gate (image selection audit Tier 3 #10 / Tier 1 #4): the
  // winner must pass a Gemini "single bottle of {brand} {name}?" check before
  // being persisted to image_cache / the catalog. Fail-open — with no Gemini
  // key or on any error the gate is a pass-through. User-curated paths
  // (admin upload/paste-URL, stripBgOnly, manual refresh preview) call
  // resolveProcessedFragranceImage directly and stay ungated: the human is
  // the curator there.
  resolveProcessedFragranceImage: (opts) =>
    resolveProcessedFragranceImage({ ...opts, visionGate: true }),
  usableImageUrlForResponse,
  backfillUserFragranceImages,
  resolveProfileViaEngine,
  reportNonFatalError: (area, error, context) => {
    logger.warn(
      {
        area,
        err: error,
        ...context,
      },
      "Non-fatal scent engine operation failed",
    );
  },
};

export function searchFragrances(query: string): FragranceData[] {
  return searchFragranceDataset(query);
}

// WS-8: collapse concurrent identical builds so two near-simultaneous adds of the
// same fragrance don't both scrape, both spend on Serper, and race each other's
// catalog write. Keyed on the canonical lookup key plus every opt that changes the
// result shape (and whether a fallback supplied notes/image), so only genuinely
// equivalent in-flight builds share a promise. Cleared on settle — this dedups
// concurrency, it is not a result cache.
const inflightProfileBuilds = new Map<string, Promise<ScentProfile | { error: string }>>();

function buildProfileDedupKey(
  name: string,
  brand: string,
  fallback: BuildProfileFallback | undefined,
  opts: BuildProfileOpts | undefined,
): string {
  return [
    makeLookupKey(brand, name),
    opts?.preferEngineData ? 1 : 0,
    opts?.imageResolution ?? "inline",
    opts?.allowCatalogFuzzy === false ? 0 : 1,
    opts?.allowMinimalFallback ? 1 : 0,
    opts?.serverSideResolve ? 1 : 0,
    opts?.concentrationOverride ?? "",
    fallback?.notes?.length ?? 0,
    fallback?.imageUrl ? 1 : 0,
  ].join("|");
}

export async function buildProfile(
  name: string,
  brand: string,
  fallback?: BuildProfileFallback,
  opts?: BuildProfileOpts,
): Promise<ScentProfile | { error: string }> {
  const key = buildProfileDedupKey(name, brand, fallback, opts);
  const inflight = inflightProfileBuilds.get(key);
  if (inflight) return inflight;

  const build = buildProfileWithDeps(DEPS, name, brand, fallback, opts).finally(() => {
    inflightProfileBuilds.delete(key);
  });
  inflightProfileBuilds.set(key, build);
  return build;
}
