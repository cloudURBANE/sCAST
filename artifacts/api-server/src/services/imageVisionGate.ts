// Production wiring for the vision validation gate (image selection audit
// Tier 3 #10 / Tier 1 #4): Gemini Flash answers "is this image a single
// product bottle of {brand} {name}?" for AUTOMATICALLY selected image winners
// before they are persisted/served (the engine-crawled fallback and auto
// Serper winners — see imagePipeline `visionGate`). User-curated paths (admin
// upload/paste-URL, stripBgOnly, the manual refresh preview) never opt in —
// the human is the curator there.
//
// Enabled only when a Gemini key is configured (GEMINI_API_KEY or
// GOOGLE_API_KEY, same lookup as reviewSummaryService) and IMAGE_VISION_GATE
// is not set to "off"/"false"/"0". Everything fails open (pass) — no key,
// HTTP error, timeout, unfetchable image — so deploys without the key behave
// exactly as before the gate existed. Both network calls are timeout-bounded
// so the gate can never hang the pipeline.
//
// Verdicts are memoized in a bounded in-process map keyed by
// `${lookupKey}:${hash}` so repeated resolutions of the same image do not
// re-spend model calls. Decision logic lives in imageVisionGateCore.ts.

import { logger } from "../lib/logger";
import { readLocalImageObject, storagePathFromLocalImageObjectUrl } from "./imageObjectStorage";
import { fetchExternalImage } from "./safeImageFetch";
import {
  evaluateVisionGate,
  type VisionGateImage,
  type VisionGateVerdict,
} from "./imageVisionGateCore";

export type { VisionGateVerdict } from "./imageVisionGateCore";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 8_000;
const IMAGE_FETCH_TIMEOUT_MS = 6_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const verdictCache = new Map<string, VisionGateVerdict>();

function geminiApiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
}

/**
 * The gate runs only when a Gemini key is present and the kill switch
 * (IMAGE_VISION_GATE=off) is not set. With no key this returns false and the
 * gate is a zero-cost pass-through.
 */
export function visionGateEnabled(): boolean {
  const flag = (process.env.IMAGE_VISION_GATE ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0" || flag === "disabled") return false;
  return geminiApiKey().length > 0;
}

export function visionGateCacheKey(
  lookupKey: string,
  hash: string | null | undefined,
): string | null {
  if (!hash) return null;
  return `${lookupKey}:${hash}`;
}

/**
 * Cached-verdict lookup with no model call. Lets the pipeline skip
 * re-downloading/re-processing a manual source whose processed output was
 * already vision-rejected for this fragrance (keyed by source URL hash).
 */
export function peekVisionGateVerdict(cacheKey: string | null): VisionGateVerdict | null {
  if (!cacheKey) return null;
  return verdictCache.get(cacheKey) ?? null;
}

async function askGemini(prompt: string, image: VisionGateImage): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey()}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: image.mimeType || "image/webp",
                data: image.data.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini vision gate request failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

/**
 * Load the processed image's bytes for the model. Handles both storage
 * shapes: local-object URLs (dev `.image-cache/`) and remote storage URLs
 * (Firebase/Supabase). Returns null (→ fail-open pass) for anything else.
 */
async function loadProcessedImageByUrl(imageUrl: string): Promise<VisionGateImage | null> {
  const trimmed = imageUrl.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/api/image-objects/")) {
    const storagePath = storagePathFromLocalImageObjectUrl(trimmed);
    if (!storagePath) return null;
    return { data: await readLocalImageObject(storagePath), mimeType: "image/webp" };
  }
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const downloaded = await fetchExternalImage(trimmed, {
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
  });
  return { data: downloaded.buffer, mimeType: downloaded.contentType || "image/webp" };
}

function reportGateError(context: Record<string, unknown>): (error: unknown) => void {
  return (error) => {
    logger.warn(
      { err: error instanceof Error ? error.message : error, ...context },
      "[imageVisionGate] gate errored; failing open (pass)",
    );
  };
}

/**
 * Gate an already-stored winner by its public URL (used for Serper winner
 * arbitration and cached manual rows). Fail-open.
 */
export async function verifyAutomaticImageWinnerByUrl(input: {
  brand: string;
  name: string;
  lookupKey: string;
  imageUrl: string;
  imageHash?: string | null;
}): Promise<VisionGateVerdict> {
  return evaluateVisionGate(
    {
      enabled: visionGateEnabled,
      loadImage: () => loadProcessedImageByUrl(input.imageUrl),
      askModel: askGemini,
      cache: verdictCache,
      onError: reportGateError({ lookupKey: input.lookupKey, mode: "url" }),
    },
    {
      brand: input.brand,
      name: input.name,
      cacheKeys: [
        visionGateCacheKey(input.lookupKey, input.imageHash) ??
          visionGateCacheKey(input.lookupKey, `url:${input.imageUrl}`),
      ],
    },
  );
}

/**
 * Gate a freshly processed image by its bytes, BEFORE it is uploaded and
 * recorded (used for the single manual/crawled candidate so a rejected image
 * never becomes a ready image_cache row). The verdict is memoized under both
 * the content hash and the source URL hash so deferred retries can skip
 * re-processing entirely (see peekVisionGateVerdict). Fail-open.
 */
export async function verifyAutomaticImageWinnerBytes(input: {
  brand: string;
  name: string;
  lookupKey: string;
  buffer: Buffer;
  mimeType?: string;
  contentHash?: string | null;
  sourceUrlHash?: string | null;
}): Promise<VisionGateVerdict> {
  return evaluateVisionGate(
    {
      enabled: visionGateEnabled,
      loadImage: async () => ({ data: input.buffer, mimeType: input.mimeType ?? "image/webp" }),
      askModel: askGemini,
      cache: verdictCache,
      onError: reportGateError({ lookupKey: input.lookupKey, mode: "bytes" }),
    },
    {
      brand: input.brand,
      name: input.name,
      cacheKeys: [
        visionGateCacheKey(input.lookupKey, input.contentHash),
        visionGateCacheKey(input.lookupKey, input.sourceUrlHash),
      ],
    },
  );
}
