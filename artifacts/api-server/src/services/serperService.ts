import axios from "axios";
import { logger } from "../lib/logger";
import type { SerperRefineMode } from "./imageSolvers";

export type { SerperRefineMode } from "./imageSolvers";

const DEFAULT_SERPER_IMAGES_URL = "https://google.serper.dev/images";
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESULTS = 12;
const MIN_IMAGE_WIDTH = 500;
const MIN_IMAGE_HEIGHT = 500;
const MIN_ASPECT_RATIO = 0.5;
const MAX_ASPECT_RATIO = 2;

const BLOCKED_HOST_HINTS = [
  "pinterest",
  "pinimg",
  "etsy",
  "ebay",
  "poshmark",
  "depop",
  "mercari",
  "dreamstime",
  "alamy",
  "shutterstock",
  "istock",
  "freepik",
  "123rf",
  "vecteezy",
];

const TRUSTED_HOST_HINTS = [
  "fragrantica",
  "fimgs.net",
  "sephora",
  "ulta",
  "macys",
  "nordstrom",
  "dior",
  "chanel",
  "ysl",
  "tomford",
  "gucci",
];

const REQUIRED_TEXT_HINTS = ["perfume", "fragrance", "bottle", "eau de parfum", "eau de toilette"];
const BLOCKED_TEXT_HINTS = [
  "gift set",
  "discovery set",
  "sample",
  "decant",
  "dupe",
  "inspired by",
  "box only",
  "with box",
  "boxed",
  "in box",
  "box packaging",
  "set of",
  "bundle",
  "lot of",
  "review",
  "render",
  "3d model",
  "mockup",
  "houseplant",
  "potted plant",
  "monstera",
  "fiddle leaf",
  "plant background",
  "succulent",
  "lush greenery",
];
const STRONG_DETAIL_HINTS = [
  "no box",
  "single bottle",
  "bottle only",
  "fragrance bottle",
  "perfume bottle",
  "centered",
  "centered bottle",
  "product photo",
  "packshot",
  "transparent background",
  "isolated",
  "studio shot",
  "plain background",
];

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

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function countMatches(text: string, terms: string[]): number {
  return terms.reduce((count, term) => (text.includes(term) ? count + 1 : count), 0);
}

function getHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function scoreCandidate(candidate: SerperImageResult): number {
  const imageUrl = candidate.imageUrl ?? "";
  const host = getHost(imageUrl);
  if (!imageUrl || !isValidHttpUrl(imageUrl)) return -Infinity;
  if (BLOCKED_HOST_HINTS.some((hint) => host.includes(hint))) return -Infinity;
  if (/\.(svg|gif)(\?.*)?$/i.test(imageUrl)) return -Infinity;

  const width = toNumber(candidate.imageWidth);
  const height = toNumber(candidate.imageHeight);
  if (width && height) {
    if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) return -Infinity;
    const aspect = width / height;
    if (aspect < MIN_ASPECT_RATIO || aspect > MAX_ASPECT_RATIO) return -Infinity;
  }

  const text = `${candidate.title ?? ""} ${candidate.source ?? ""}`.toLowerCase();
  if (includesAny(text, BLOCKED_TEXT_HINTS)) return -Infinity;
  const hasBottleSignal = includesAny(text, REQUIRED_TEXT_HINTS);
  const strongDetailMatches = countMatches(text, STRONG_DETAIL_HINTS);
  const trustedHost = TRUSTED_HOST_HINTS.some((hint) => host.includes(hint));
  if (!hasBottleSignal && !trustedHost) return -Infinity;

  let score = 0;
  if (hasBottleSignal) score += 4;
  if (trustedHost) score += 5;
  score += Math.min(5, strongDetailMatches);
  if (/\.png(\?.*)?$/i.test(imageUrl)) score += 1;
  if (width && height) score += Math.min(4, Math.floor(Math.min(width, height) / 400));

  return score;
}

/** Full packshot refinement appended for normal refresh paths. */
const SERPER_SUFFIX_DEFAULT =
  "single fragrance bottle bottle only no box centered product packshot front view plain background no plants no lifestyle studio shot";

/** Shorter suffix on clarify/solver paths so negative keywords stay meaningful. */
const SERPER_SUFFIX_SOLVER = "fragrance bottle packshot isolated product photo";

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
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate) }))
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
