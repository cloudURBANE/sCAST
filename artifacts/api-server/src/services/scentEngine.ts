import type { FragranceData } from "./datasetLoader";
import { parseFragrance } from "./scentParser";
import { vectorize, calculatePerformance, calculateContext } from "./scentVectorizer";
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
  resolveFragranceIdentity,
  findDatasetFragrance,
  getCatalogEntry,
  searchCatalog,
  saveCatalogEntry,
  resolveCachedFragranceImage,
  resolveProcessedFragranceImage,
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

export async function buildProfile(
  name: string,
  brand: string,
  fallback?: BuildProfileFallback,
  opts?: BuildProfileOpts,
): Promise<ScentProfile | { error: string }> {
  return buildProfileWithDeps(DEPS, name, brand, fallback, opts);
}
