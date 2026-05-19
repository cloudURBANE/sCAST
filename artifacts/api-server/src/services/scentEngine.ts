import type { FragranceData } from "./datasetLoader";
import { parseFragrance } from "./scentParser";
import { vectorize, calculatePerformance, calculateContext } from "./scentVectorizer";
import { getCatalogEntry, saveCatalogEntry, searchCatalog } from "./catalogService";
import { resolveProcessedFragranceImage } from "./imagePipeline";
import { usableImageUrlForResponse } from "./imageHydration";
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

const DEPS: ScentEngineDeps = {
  parseFragrance,
  vectorize,
  calculatePerformance,
  calculateContext,
  resolveFragranceIdentity,
  findDatasetFragrance,
  getCatalogEntry,
  searchCatalog,
  saveCatalogEntry,
  resolveProcessedFragranceImage,
  usableImageUrlForResponse,
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
