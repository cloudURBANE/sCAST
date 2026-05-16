import sharp from "sharp";
import { logger } from "../lib/logger";
import { recordApiUsage } from "./apiUsageLedger";
import { makeLookupKey } from "./catalogService";
import {
  buildProcessedImageStorageKey,
  hashBuffer,
  hashString,
  recordImageFailure,
  recordImageReady,
  type CachedImageReference,
} from "./imageCacheService";
import {
  ImageObjectStorageConfigurationError,
  getImageObjectStorage,
  readLocalImageObject,
  storagePathFromLocalImageObjectUrl,
} from "./imageObjectStorage";
import { safeImageUrlForResponse } from "./persistenceGuards";
import { fetchExternalImage } from "./safeImageFetch";

// Last reviewed against OpenAI image pricing: 2026-05-15. Update this comment
// whenever the model list or default changes so a future reader can decide
// quickly whether to refresh the pricing in the cost ledger phase.
const SUPPORTED_REIMAGINE_MODELS = ["gpt-image-1", "gpt-image-1-mini", "gpt-image-2"] as const;
type ReimagineModel = (typeof SUPPORTED_REIMAGINE_MODELS)[number];

const DEFAULT_REIMAGINE_MODEL: ReimagineModel = "gpt-image-1";
const DEFAULT_REIMAGINE_SIZE = "1024x1024";
const DEFAULT_REIMAGINE_QUALITY = "high";
const OPENAI_IMAGE_EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits";
const OPENAI_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_DIMENSION = 768;
const WEBP_QUALITY = 82;

const REIMAGINE_PROMPT = [
  "High-fidelity commercial product photograph of the exact fragrance bottle in the source image.",
  "Head-on hero packshot, single bottle centered, eye-level camera, square 1:1 crop with even margins.",
  "Identity preservation is the highest priority: reproduce the bottle silhouette, proportions, glass color and tint,",
  "cap material and shape, collar, base, label artwork, every typographic detail, and any engraving exactly as shown in the source —",
  "do not redesign, restyle, recolor, retype, or invent any element of the bottle or label.",
  "Studio lighting: large soft key from upper-left, subtle fill, gentle rim highlight on the glass edges,",
  "natural specular reflections, accurate refraction through liquid, true-to-source liquid color and fill level,",
  "crisp focus across the whole bottle, no motion blur, no depth-of-field smear on the label.",
  "Background: clean neutral seamless backdrop with a soft vertical gradient (light gray to slightly darker gray),",
  "no horizon line, no shadows on the backdrop other than a soft contact shadow directly beneath the bottle.",
  "Strictly forbidden: extra bottles, boxes, props, hands, people, water droplets, petals, fabric, added text,",
  "added logos, watermarks, borders, frames, or any element not present in the source.",
  "Output should look like a catalog/e-commerce hero image: photoreal, ultra-sharp, color-accurate, retouched-clean.",
].join(" ");

function resolveModel(requested?: string | null): ReimagineModel {
  const fromRequest = typeof requested === "string" ? requested.trim() : "";
  if ((SUPPORTED_REIMAGINE_MODELS as readonly string[]).includes(fromRequest)) {
    return fromRequest as ReimagineModel;
  }
  const fromEnv = process.env.OPENAI_REIMAGINE_MODEL?.trim();
  if (fromEnv && (SUPPORTED_REIMAGINE_MODELS as readonly string[]).includes(fromEnv)) {
    return fromEnv as ReimagineModel;
  }
  return DEFAULT_REIMAGINE_MODEL;
}

export function isSupportedReimagineModel(value: unknown): value is ReimagineModel {
  return typeof value === "string" && (SUPPORTED_REIMAGINE_MODELS as readonly string[]).includes(value);
}

type SourceBytes = {
  buffer: Buffer;
  inputDescriptor: string;
  inputHash: string;
};

function decodeDataImage(input: string): Buffer | null {
  const match = input.match(/^data:image\/(?:png|jpe?g|webp);base64,([a-z0-9+/=]+)$/i);
  if (!match?.[1]) return null;
  if (match[1].length > 6_000_000) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

async function loadSourceBytes(sourceUrl: string): Promise<SourceBytes> {
  const trimmed = sourceUrl.trim();

  if (trimmed.startsWith("/api/image-objects/")) {
    const storagePath = storagePathFromLocalImageObjectUrl(trimmed);
    if (!storagePath) throw new Error("Invalid local image object URL");
    const buffer = await readLocalImageObject(storagePath);
    return {
      buffer,
      inputDescriptor: `local-object:${storagePath}`,
      inputHash: hashString(`local-object:${storagePath}`),
    };
  }

  if (trimmed.startsWith("data:image/")) {
    const decoded = decodeDataImage(trimmed);
    if (!decoded) throw new Error("Invalid or oversized data image");
    const contentHash = hashBuffer(decoded);
    return {
      buffer: decoded,
      inputDescriptor: `data-image:${contentHash}`,
      inputHash: hashString(`data-image:${contentHash}`),
    };
  }

  const downloaded = await fetchExternalImage(trimmed);
  return {
    buffer: downloaded.buffer,
    inputDescriptor: downloaded.finalUrl,
    inputHash: hashString(downloaded.finalUrl),
  };
}

async function toPngForOpenAI(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .png()
    .toBuffer();
}

type OpenAIImageEditsResponse = {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string };
};

async function callOpenAIImageEdits(input: {
  pngBuffer: Buffer;
  model: ReimagineModel;
  apiKey: string;
}): Promise<Buffer> {
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("image", input.pngBuffer, { filename: "bottle.png", contentType: "image/png" });
  form.append("model", input.model);
  form.append("prompt", REIMAGINE_PROMPT);
  form.append("n", "1");
  form.append("size", DEFAULT_REIMAGINE_SIZE);
  form.append("quality", DEFAULT_REIMAGINE_QUALITY);
  // response_format defaults to b64_json for gpt-image-* models.

  const axiosMod = await import("axios");
  const axios = axiosMod.default;
  const res = await axios.post<OpenAIImageEditsResponse>(OPENAI_IMAGE_EDITS_ENDPOINT, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${input.apiKey}` },
    timeout: OPENAI_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    const message = res.data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenAI image edit failed: ${message}`);
  }

  const b64 = res.data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image edit returned no image data");

  const out = Buffer.from(b64, "base64");
  if (out.length === 0) throw new Error("OpenAI image edit returned an empty buffer");
  return out;
}

async function encodeToWebp(buffer: Buffer): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
}> {
  const encoded = await sharp(buffer, { failOn: "truncated" })
    .rotate()
    .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toBuffer();

  const meta = await sharp(encoded).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Reimagined image metadata missing dimensions");
  }

  return {
    buffer: encoded,
    width: meta.width,
    height: meta.height,
    sizeBytes: encoded.length,
  };
}

export type ReimagineBottleImageInput = {
  brand: string;
  name: string;
  sourceUrl: string;
  model?: string | null;
  userId?: string | null;
  fragranceId?: string | null;
};

export type ReimagineBottleImageResult = CachedImageReference & {
  model: ReimagineModel;
};

export async function reimagineBottleImage(
  input: ReimagineBottleImageInput,
): Promise<ReimagineBottleImageResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const model = resolveModel(input.model);
  const lookupKey = makeLookupKey(input.brand, input.name);
  const sourceProvider = "manual" as const;

  const loaded = await loadSourceBytes(input.sourceUrl);
  const pngForEdit = await toPngForOpenAI(loaded.buffer);

  logger.info(
    {
      lookupKey,
      model,
      sourceKind: input.sourceUrl.startsWith("data:")
        ? "data"
        : input.sourceUrl.startsWith("/api/image-objects/")
          ? "local-object"
          : "remote",
      sourceBytes: loaded.buffer.length,
      uploadBytes: pngForEdit.length,
    },
    "[reimagine] calling OpenAI images.edits",
  );

  let generated: Buffer;
  try {
    generated = await callOpenAIImageEdits({ pngBuffer: pngForEdit, model, apiKey });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "OpenAI image edit failed";
    await recordApiUsage({
      userId: input.userId ?? null,
      provider: "openai",
      operation: "image.edits",
      model,
      size: DEFAULT_REIMAGINE_SIZE,
      quality: DEFAULT_REIMAGINE_QUALITY,
      imageCount: 1,
      status: "failure",
      failureReason: reason,
    });
    throw err;
  }

  await recordApiUsage({
    userId: input.userId ?? null,
    provider: "openai",
    operation: "image.edits",
    model,
    size: DEFAULT_REIMAGINE_SIZE,
    quality: DEFAULT_REIMAGINE_QUALITY,
    imageCount: 1,
    status: "success",
  });

  const optimized = await encodeToWebp(generated);
  const contentHash = hashBuffer(optimized.buffer);

  // Synthesize a sourceUrl unique per generated output so the (sourceUrlHash,
  // pipelineVersion) unique index in image_cache does not overwrite earlier
  // reimagines of the same input.
  const sourceUrlForDb = `openai-reimagine:${model}:${loaded.inputHash}:${contentHash}`;
  const sourceUrlHash = hashString(sourceUrlForDb);

  const storage = getImageObjectStorage();
  const storagePath = buildProcessedImageStorageKey({
    sourceProvider,
    lookupKey,
    sourceUrlHash,
    contentHash,
  });

  try {
    const uploaded = await storage.uploadProcessedImage({
      buffer: optimized.buffer,
      contentType: "image/webp",
      key: storagePath,
    });

    const publicUrl = safeImageUrlForResponse(uploaded.publicUrl ?? uploaded.signedUrl ?? "");
    if (!publicUrl) throw new Error("Storage upload did not return a usable URL");

    const recorded = await recordImageReady({
      userId: input.userId ?? null,
      fragranceId: input.fragranceId ?? null,
      lookupKey,
      sourceProvider,
      sourceUrl: sourceUrlForDb,
      sourceUrlHash,
      searchQueryHash: null,
      contentHash,
      storageProvider: uploaded.provider,
      storagePath: uploaded.storagePath,
      publicUrl,
      mimeType: "image/webp",
      width: optimized.width,
      height: optimized.height,
      sizeBytes: uploaded.sizeBytes || optimized.sizeBytes,
      backgroundRemoved: false,
      removeBgStatus: "skipped",
      removeBgReason: "openai_reimagine",
    });

    return { ...recorded, model };
  } catch (err) {
    if (err instanceof ImageObjectStorageConfigurationError) throw err;
    const reason = err instanceof Error ? err.message : "reimagine storage failed";
    await recordImageFailure({
      userId: input.userId ?? null,
      fragranceId: input.fragranceId ?? null,
      lookupKey,
      sourceProvider,
      sourceUrl: sourceUrlForDb,
      sourceUrlHash,
      searchQueryHash: null,
      failureReason: reason,
    }).catch(() => {});
    throw err;
  }
}

export const REIMAGINE_INTERNALS_FOR_TESTS = {
  REIMAGINE_PROMPT,
  SUPPORTED_REIMAGINE_MODELS,
  resolveModel,
};
