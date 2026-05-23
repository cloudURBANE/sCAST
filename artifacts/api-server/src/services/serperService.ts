import axios from "axios";
import { logger } from "../lib/logger";
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
  "single fragrance bottle bottle only no box no tester no sample no vial no decant centered product packshot front view plain background no plants no lifestyle no text overlay studio shot";

/** Shorter suffix on clarify/solver paths so negative keywords stay meaningful. */
const SERPER_SUFFIX_SOLVER = "single fragrance bottle packshot isolated product photo no sample no tester";

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
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    logger.warn("[serper] SERPER_API_KEY missing; image search disabled");
    return [];
  }

  const endpoint = process.env.SERPER_IMAGE_API_URL || DEFAULT_SERPER_IMAGES_URL;
  const refinedQuery = applySerperRefinement(query, options?.refine ?? "default");

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

    if (response.status !== 200) {
      logger.warn({ status: response.status }, "[serper] image search non-200");
      return [];
    }

    const images = Array.isArray(response.data?.images) ? response.data.images : [];
    if (images.length === 0) return [];

    const ranked = images
      .map((candidate) => ({ candidate, score: scoreSerperImageCandidate(candidate) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      logger.info("[serper] no candidate passed strict filters");
      return [];
    }

    return ranked
      .filter((item): item is { candidate: SerperImageResult & { imageUrl: string }; score: number } => !!item.candidate.imageUrl)
      .map((item) => ({ ...item.candidate, imageUrl: item.candidate.imageUrl, score: item.score }));
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[serper] image search failed");
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
