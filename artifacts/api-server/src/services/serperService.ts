import axios from "axios";
import { logger } from "../lib/logger";
import { KeyPool, registerKeyPool } from "../lib/keyPool";
import type { SerperRefineMode } from "./imageSolvers";
import { scoreSerperImageCandidate } from "./serperCandidateScoring";

export type { SerperRefineMode } from "./imageSolvers";
export { scoreSerperImageCandidate } from "./serperCandidateScoring";

const DEFAULT_SERPER_IMAGES_URL = "https://google.serper.dev/images";
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESULTS = 12;

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
};

/** Full packshot refinement appended for normal refresh paths. */
const SERPER_SUFFIX_DEFAULT =
  "single fragrance bottle bottle only no box no carton no packaging no gift set no coffret no tester no sample no vial no decant centered product packshot front view plain background no plants no lifestyle no text overlay studio shot";

/** Shorter suffix on clarify/solver paths so negative keywords stay meaningful. */
const SERPER_SUFFIX_SOLVER = "single fragrance bottle packshot isolated product photo no sample no tester";

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

function applySerperRefinement(rawQuery: string, refine: SerperRefineMode): string {
  const q = rawQuery.trim();
  if (!q) return q;
  if (refine === "none") return q;
  if (refine === "solver") return `${q} ${SERPER_SUFFIX_SOLVER}`.trim();
  return `${q} ${SERPER_SUFFIX_DEFAULT}`.trim();
}

export async function searchSerperImageCandidates(
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
          validateStatus: (status) => status >= 200 && status < 500,
        },
      );

      if (response.status === 200) {
        const images = Array.isArray(response.data?.images) ? response.data.images : [];
        const ranked = images
          .map((candidate) => ({ candidate, score: scoreSerperImageCandidate(candidate) }))
          .filter((item) => Number.isFinite(item.score))
          .sort((a, b) => b.score - a.score)
          .filter((item): item is { candidate: SerperImageResult & { imageUrl: string }; score: number } => !!item.candidate.imageUrl)
          .map((item) => ({ ...item.candidate, imageUrl: item.candidate.imageUrl, score: item.score }));
        // A successful call with zero usable candidates still means the key
        // works — return it as success so we don't burn other keys.
        return { ok: true, value: ranked };
      }

      if (response.status === 429) {
        logger.warn({ key: label }, "[serper] rate-limited (429); rotating to next key");
        return { ok: false, action: "cooldown" };
      }
      if (response.status === 401 || response.status === 402 || response.status === 403) {
        logger.warn({ key: label, status: response.status }, "[serper] key unauthorized / out of credits; retiring");
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

export async function searchSerperImageUrl(
  query: string,
  options?: { refine?: SerperRefineMode },
): Promise<string | null> {
  const candidates = await searchSerperImageCandidates(query, options);
  return candidates[0]?.imageUrl ?? null;
}
