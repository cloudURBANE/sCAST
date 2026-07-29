import axios from "axios";
import { logger } from "../lib/logger";
import { KeyPool, registerKeyPool } from "../lib/keyPool";
import { keepAliveHttpAgent, keepAliveHttpsAgent } from "../lib/keepAliveAgent";
import type { SerperRefineMode } from "./imageSolvers";
import { scoreSerperImageCandidate } from "./serperCandidateScoring";
import {
  classifySerperKeyFailure,
  dispatchImageCandidateSearch,
  type ImageCandidateProvider,
} from "./serperProviderCore";
// Query composition (packshot suffixes, Google's 32-word cap) lives in the
// dependency-free serperQueryCore.ts so it can be unit-tested without axios.
import { applySerperRefinement } from "./serperQueryCore";

export type { SerperRefineMode } from "./imageSolvers";
export { scoreSerperImageCandidate } from "./serperCandidateScoring";
export { applySerperRefinement, capQueryWords, MAX_QUERY_WORDS, SERPER_SUFFIX_DEFAULT, SERPER_SUFFIX_SOLVER } from "./serperQueryCore";

const DEFAULT_SERPER_IMAGES_URL = "https://google.serper.dev/images";
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESULTS = 12;

// Engine (Python fragrance service) base URL for the Decodo-backed image search.
// Mirrors the resolver order used by routes/fragranceEngineProxy.ts and
// services/enrichmentProcessor.ts so all server->engine calls share one config.
const DEFAULT_ENGINE_ORIGIN = "https://srt-scent-engine-production.up.railway.app";
const ENGINE_BASE = (
  process.env.FRAGRANCE_ENGINE_URL ??
  process.env.VITE_FRAGRANCE_API_URL ??
  DEFAULT_ENGINE_ORIGIN
)
  .trim()
  .replace(/\/+$/, "");

/**
 * Image candidate provider. `serper` (default) keeps the legacy Serper.dev
 * `/images` call; `engine` routes to the engine's Decodo-backed
 * `GET /api/fragrances/image-search`. When the engine returns no usable results,
 * searchSerperImageCandidates falls back to the legacy Serper path.
 */
function imageProvider(): ImageCandidateProvider {
  return (process.env.IMAGE_PROVIDER ?? "serper").trim().toLowerCase() === "engine" ? "engine" : "serper";
}

type SerperImageResult = {
  imageUrl?: string;
  title?: string;
  source?: string;
  imageWidth?: number;
  imageHeight?: number;
};

export type SerperImageCandidate = SerperImageResult & {
  imageUrl: string;
  score: number;
};

type SerperResponse = {
  images?: SerperImageResult[];
  message?: string;
};

/**
 * Engine `GET /api/fragrances/image-search` response. The engine already
 * normalizes Decodo entries to camelCase (`imageUrl`/`title`/`source`/
 * `imageWidth`/`imageHeight`), matching the fields our scorer reads. Extra keys
 * (`thumbnailUrl`/`link`/`position`/`source_provider`) have no consumer here.
 */
type EngineImageResult = SerperImageResult & {
  thumbnailUrl?: string;
  link?: string;
  position?: number;
  source_provider?: string;
};

type EngineImageResponse = {
  results?: EngineImageResult[];
};

/**
 * Shared candidate adapter: score every raw result, drop unscorable / urlless
 * entries, and sort best-first. Used identically for Serper `images[]` and the
 * engine `results[]` — the only difference between the two providers is the
 * source array, never the scoring. Width/height-absent candidates are tolerated
 * by the scorer (soft penalty), which matters because Decodo often omits them.
 */
function rankImageCandidates(results: SerperImageResult[]): SerperImageCandidate[] {
  return results
    .map((candidate) => ({ candidate, score: scoreSerperImageCandidate(candidate) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .filter(
      (item): item is { candidate: SerperImageResult & { imageUrl: string }; score: number } =>
        !!item.candidate.imageUrl,
    )
    .map((item) => ({ ...item.candidate, imageUrl: item.candidate.imageUrl, score: item.score }));
}

// Pool of Serper.dev keys. Prefer the plural SERPER_API_KEYS (comma-separated
// pool) and fall back to the legacy single SERPER_API_KEY so existing deploys
// keep working. Lazily built so dotenv has loaded by first use.
let serperPool: KeyPool | null = null;
export function getSerperPool(): KeyPool {
  if (!serperPool) {
    serperPool = registerKeyPool(
      KeyPool.fromEnv("serper", [process.env.SERPER_API_KEYS, process.env.SERPER_API_KEY]),
    );
  }
  return serperPool;
}


/**
 * Resolve bottle-image candidates. Dispatches to the configured provider
 * (`IMAGE_PROVIDER`); both providers return the identical
 * `SerperImageCandidate[]` shape (the downstream pipeline is provider-agnostic).
 */
export async function searchSerperImageCandidates(
  query: string,
  options?: { refine?: SerperRefineMode },
): Promise<SerperImageCandidate[]> {
  const result = await dispatchImageCandidateSearch({
    provider: imageProvider(),
    searchEngine: () => searchEngineImageCandidates(query, options),
    searchSerper: () => searchSerperImageCandidatesViaSerper(query, options),
  });
  if (result.fallbackUsed) {
    logger.warn(
      { queryPreview: query.slice(0, 120) },
      "[engine-image] returned no usable candidates; falling back to Serper",
    );
  }
  return result.candidates;
}

/** Legacy Serper.dev `/images` path. Billed against the SERPER_API_KEYS pool. */
async function searchSerperImageCandidatesViaSerper(
  query: string,
  options?: { refine?: SerperRefineMode },
): Promise<SerperImageCandidate[]> {
  if (!query.trim()) return [];

  const pool = getSerperPool();
  if (pool.size === 0) {
    logger.warn("[serper] no API keys configured (SERPER_API_KEYS/SERPER_API_KEY); image search disabled");
    return [];
  }

  const endpoint = process.env.SERPER_IMAGE_API_URL || DEFAULT_SERPER_IMAGES_URL;
  const refinedQuery = applySerperRefinement(query, options?.refine ?? "default");

  const outcome = await pool.run<SerperImageCandidate[]>(async (apiKey, label) => {
    try {
      const response = await axios.post<SerperResponse>(
        endpoint,
        { q: refinedQuery, num: MAX_RESULTS, gl: "us", hl: "en" },
        {
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            "x-api-key": apiKey,
            "content-type": "application/json",
          },
          httpAgent: keepAliveHttpAgent,
          httpsAgent: keepAliveHttpsAgent,
          validateStatus: (status) => status >= 200 && status < 500,
        },
      );

      if (response.status === 200) {
        const images = Array.isArray(response.data?.images) ? response.data.images : [];
        // A successful call with zero usable candidates still means the key
        // works — return it as success so we don't burn other keys.
        return { ok: true, value: rankImageCandidates(images) };
      }

      const failureAction = classifySerperKeyFailure(response.status, response.data?.message);
      if (failureAction === "cooldown") {
        logger.warn({ key: label }, "[serper] rate-limited (429); rotating to next key");
        return { ok: false, action: "cooldown" };
      }
      if (failureAction === "retire") {
        logger.warn(
          { key: label, status: response.status },
          "[serper] key unauthorized or out of credits; retiring",
        );
        return { ok: false, action: "retire" };
      }

      logger.warn({ key: label, status: response.status }, "[serper] image search non-200; trying next key");
      return { ok: false, action: "skip" };
    } catch (err: any) {
      logger.warn({ key: label, err: err?.message }, "[serper] image search failed; trying next key");
      return { ok: false, action: "skip" };
    }
  });

  if (!outcome.ok) {
    if (outcome.reason === "all_exhausted") {
      logger.warn("[serper] all API keys exhausted or cooling down; image search disabled");
    }
    return [];
  }
  return outcome.value;
}

/**
 * Engine-backed image search (Decodo). 1:1 replacement for the Serper `/images`
 * call: GET `${ENGINE_BASE}/api/fragrances/image-search?q=&limit=`. The engine
 * owns Decodo auth + the daily request cap, so no key pool is needed here. The
 * same packshot suffix is appended (Decodo runs the same Google Images SERP, so
 * the negative-keyword refinement is still useful), and the same scorer ranks
 * the results. Soft-fails to `[]` on any non-200/transport error — never throws.
 */
export async function searchEngineImageCandidates(
  query: string,
  options?: { refine?: SerperRefineMode },
): Promise<SerperImageCandidate[]> {
  if (!query.trim()) return [];

  const refinedQuery = applySerperRefinement(query, options?.refine ?? "default");
  const url = `${ENGINE_BASE}/api/fragrances/image-search?q=${encodeURIComponent(refinedQuery)}&limit=${MAX_RESULTS}`;

  try {
    const response = await axios.get<EngineImageResponse>(url, {
      timeout: REQUEST_TIMEOUT_MS,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent,
      validateStatus: (status) => status >= 200 && status < 500,
    });

    if (response.status !== 200) {
      logger.warn({ status: response.status }, "[engine-image] non-200; returning no candidates");
      return [];
    }

    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    // Normalize to the scorer's field set, dropping engine-only keys
    // (thumbnailUrl/link/position/source_provider) that nothing downstream reads.
    const normalized: SerperImageResult[] = results.map((r) => ({
      imageUrl: r.imageUrl,
      title: r.title,
      source: r.source,
      imageWidth: r.imageWidth,
      imageHeight: r.imageHeight,
    }));
    return rankImageCandidates(normalized);
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[engine-image] image search failed; returning no candidates");
    return [];
  }
}

export async function searchSerperImageUrl(
  query: string,
  options?: { refine?: SerperRefineMode },
): Promise<string | null> {
  const candidates = await searchSerperImageCandidates(query, options);
  return candidates[0]?.imageUrl ?? null;
}
