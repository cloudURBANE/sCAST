import axios from "axios";
import { logger } from "../lib/logger";

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
  "review",
  "render",
  "3d model",
  "mockup",
];

type SerperImageResult = {
  imageUrl?: string;
  title?: string;
  source?: string;
  imageWidth?: number;
  imageHeight?: number;
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
  const trustedHost = TRUSTED_HOST_HINTS.some((hint) => host.includes(hint));
  if (!hasBottleSignal && !trustedHost) return -Infinity;

  let score = 0;
  if (hasBottleSignal) score += 4;
  if (trustedHost) score += 5;
  if (/\.png(\?.*)?$/i.test(imageUrl)) score += 1;
  if (width && height) score += Math.min(4, Math.floor(Math.min(width, height) / 400));

  return score;
}

export async function searchSerperImageUrl(query: string): Promise<string | null> {
  if (!query.trim()) return null;
  const apiKey = process.env.SERPER_API_KEY;
  // #region agent log
  fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aee09'},body:JSON.stringify({sessionId:'4aee09',runId:'pre-fix',hypothesisId:'H1',location:'serperService.ts:searchSerperImageUrl:start',message:'Serper search entry',data:{queryLength:query.trim().length,hasSerperApiKey:Boolean(apiKey)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!apiKey) {
    logger.warn("[serper] SERPER_API_KEY missing; image search disabled");
    return null;
  }

  const endpoint = process.env.SERPER_IMAGE_API_URL || DEFAULT_SERPER_IMAGES_URL;
  const refinedQuery = `${query.trim()} single fragrance bottle product photo no box transparent background`;

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
      // #region agent log
      fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aee09'},body:JSON.stringify({sessionId:'4aee09',runId:'pre-fix',hypothesisId:'H2',location:'serperService.ts:searchSerperImageUrl:non200',message:'Serper non-200 response',data:{status:response.status},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      logger.warn({ status: response.status }, "[serper] image search non-200");
      return null;
    }

    const images = Array.isArray(response.data?.images) ? response.data.images : [];
    // #region agent log
    fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aee09'},body:JSON.stringify({sessionId:'4aee09',runId:'pre-fix',hypothesisId:'H2',location:'serperService.ts:searchSerperImageUrl:images',message:'Serper image candidates received',data:{imageCount:images.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (images.length === 0) return null;

    const ranked = images
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score);
    // #region agent log
    fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4aee09'},body:JSON.stringify({sessionId:'4aee09',runId:'pre-fix',hypothesisId:'H2',location:'serperService.ts:searchSerperImageUrl:ranked',message:'Serper strict ranking result',data:{rankedCount:ranked.length,topHost:ranked[0]?.candidate?.imageUrl?new URL(ranked[0].candidate.imageUrl).hostname:null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (ranked.length === 0) {
      logger.info("[serper] no candidate passed strict filters");
      return null;
    }

    return ranked[0].candidate.imageUrl ?? null;
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[serper] image search failed");
    return null;
  }
}
