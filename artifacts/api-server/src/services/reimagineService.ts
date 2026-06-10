import sharp from "sharp";
import { logger } from "../lib/logger";
import { recordApiUsage } from "./apiUsageLedger";
import { removeBgBuffer, type RemoveBgReason, type RemoveBgStatus } from "./bgService";
import { makeLookupKey } from "./catalogService";
import {
  buildProcessedImageStorageKey,
  getLatestReadyCachedImageBySearchQueryHash,
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
// gpt-image-1 is the cheaper sibling; it is accepted so ops can dial cost down
// via OPENAI_REIMAGINE_MODEL without a code change.
const SUPPORTED_REIMAGINE_MODELS = ["gpt-image-2", "gpt-image-1"] as const;
type ReimagineModel = (typeof SUPPORTED_REIMAGINE_MODELS)[number];

const DEFAULT_REIMAGINE_MODEL: ReimagineModel = "gpt-image-2";
const DEFAULT_REIMAGINE_SIZE = "1024x1024";
const OPENAI_IMAGE_EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits";
const OPENAI_TIMEOUT_MS = 240_000;
const MAX_OUTPUT_DIMENSION = 768;
const WEBP_QUALITY = 90;

// Quality is the single biggest cost lever on the image-edits endpoint. The
// default stays "high" so existing output is unchanged, but ops can dial it down
// (e.g. "medium"/"low") via OPENAI_REIMAGINE_QUALITY without a deploy. "auto"
// lets the model pick.
const REIMAGINE_QUALITIES = ["low", "medium", "high", "auto"] as const;
type ReimagineQuality = (typeof REIMAGINE_QUALITIES)[number];
// "medium" is the default: the output is downscaled to MAX_OUTPUT_DIMENSION
// (768px) WebP before storage, so the extra fidelity of "high" is resolved away
// on downscale while costing ~4x more in output tokens. Ops can restore "high"
// via OPENAI_REIMAGINE_QUALITY for a one-off without a deploy.
const DEFAULT_REIMAGINE_QUALITY: ReimagineQuality = "medium";

function resolveQuality(): ReimagineQuality {
  const fromEnv = process.env.OPENAI_REIMAGINE_QUALITY?.trim().toLowerCase();
  if (fromEnv && (REIMAGINE_QUALITIES as readonly string[]).includes(fromEnv)) {
    return fromEnv as ReimagineQuality;
  }
  return DEFAULT_REIMAGINE_QUALITY;
}

// Maximum dimension of the PNG we send to OpenAI as the reference image.
// Image-input tokens scale with the reference resolution, so this is the
// largest cost lever we can move WITHOUT touching output quality. The model
// renders at DEFAULT_REIMAGINE_SIZE (1024²) and we then downscale the result to
// MAX_OUTPUT_DIMENSION (768px) before storing it, so any reference detail above
// ~1024px is resolved away by the render and then thrown away by the downscale
// — the user never sees it. A 1024-square reference therefore matches the
// render size 1:1 and delivers identical final quality at roughly a quarter of
// the input-image pixels (and tokens) of the old 2048-square default. Ops who
// want to spend more for marginal fidelity can raise it via
// OPENAI_REIMAGINE_INPUT_DIM (clamped to 512..2048).
const DEFAULT_OPENAI_INPUT_MAX_DIMENSION = 1024;

function resolveInputMaxDimension(): number {
  const raw = Number(process.env.OPENAI_REIMAGINE_INPUT_DIM?.trim());
  if (!Number.isFinite(raw)) return DEFAULT_OPENAI_INPUT_MAX_DIMENSION;
  return Math.min(2048, Math.max(512, Math.round(raw)));
}

// The reimagine prompt carries three jobs, in priority order:
//   1. Identity — reproduce *this* bottle and label exactly; never redesign.
//   2. Reconstruction — the reference is usually an already-cut-out wardrobe
//      image whose clear-glass interior was punched out to transparency by a
//      previous background-removal pass, so the model must repair/fill those
//      voids and emit one whole, intact bottle instead of faithfully copying
//      the holes.
//   3. Background-removal-safe rendering — give clear glass and the liquid
//      enough internal substance (refraction, reflections, tint, a defining
//      edge) and sit the bottle on a mid-light grey sweep so the *downstream*
//      Poof cut-out keeps the full silhouette and interior instead of eating
//      the see-through regions again.
// Keep these blocks in sync with toPngForOpenAI (which flattens the reference
// onto the same neutral grey) — the two must describe one consistent backdrop.
const REIMAGINE_PROMPT = [
  "Print-grade commercial product photograph of the exact fragrance bottle shown in the reference image.",
  "Identity preservation is the single highest priority and must be enforced before any creative decision:",
  "match the bottle silhouette, proportions, shoulder, neck, collar, base, and footprint exactly;",
  "match the glass color, tint, opacity, and edge thickness exactly;",
  "match the cap material, shape, knurl, polish, and seating exactly;",
  "reproduce the label artwork pixel-faithfully — every glyph, kerning detail, brand mark, certification stamp,",
  "concentration line, batch code, and small-print typography must remain legible at print resolution;",
  "reproduce any engraving, embossing, etching, or relief in the glass exactly as shown;",
  "preserve the true-to-source liquid color, transparency, and fill level — do not lighten or darken the juice.",
  "Do not redesign, restyle, recolor, rename, reposition, simplify, or invent any element of the bottle or label.",
  "Reconstruction: the reference may be a previously cut-out image whose edges or interior were damaged by automated background removal,",
  "so rebuild the bottle as one whole, structurally complete object — fill in, repair, and seamlessly complete any region that looks missing,",
  "erased, clipped, hollowed-out, transparent, or eaten away, including the glass body, shoulders, neck, collar, cap, label, and the liquid behind",
  "the glass, so the silhouette is unbroken and the glass walls read as continuous, solid-walled, and intact with no gaps in the fill line.",
  "Never copy holes, cut-outs, transparent voids, ragged edges, alpha halos, or matting artifacts from the reference; restore the bottle to how it",
  "looked fully intact before any background removal touched it.",
  "Background-removal-safe rendering: render every part of the bottle so a downstream automatic background remover keeps the entire silhouette and",
  "interior. Clear glass, transparent shoulders, and the liquid must each carry enough internal substance — visible refraction, internal reflections,",
  "true-to-source tint, subtle containment shading, and a crisp defining edge — that they read as a distinct, light-bending solid object and never as",
  "an empty window onto the backdrop; no region of the bottle may blend into, match, or dissolve into the background color, and one continuous,",
  "well-defined outer edge must wrap the whole bottle so the cut-out follows the true silhouette without punching holes through clear glass.",
  "Lighting and material rendering: large soft studio key from upper-left with a subtle fill from the opposite side,",
  "gentle rim highlight tracing the glass edges, controlled specular highlights without blown-out hotspots,",
  "physically accurate refraction and caustic light play through the liquid and at the base of the glass,",
  "true Fresnel falloff on the glass surface, micro-detail on the cap (machined edges, polish reflection, metal grain if applicable),",
  "and crisp focus across the entire bottle — no motion blur, no depth-of-field smear on the label, no chromatic aberration.",
  "Composition: head-on hero packshot, single bottle perfectly centered, eye-level camera,",
  "square 1:1 framing with even margins, the bottle filling most of the frame for maximum pixel density.",
  "Background: isolate the bottle on a soft, even, seamless neutral mid-light grey studio sweep that stays clearly separable from clear glass and the",
  "liquid — no pure-white blow-out that would let a background remover mistake see-through glass for the backdrop,",
  "no props, no surface, no horizon line, no second bottle, no boxes, no hands, no people, no fabric,",
  "no water droplets, no petals, no added text, no added logos, no watermarks, no frames, no borders,",
  "no drop shadow, no contact shadow, no ground reflection, no vignette, no color grading on the backdrop.",
  "Treat this as a Sephora-grade hero packshot: photoreal, ultra-sharp, color-accurate, retouched-clean,",
  "edge-perfect bottle silhouette ready to be cut out and composited onto any background.",
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

// Neutral mid-light grey we composite the reference onto before sending it to
// the model. The wardrobe source is usually an already-background-removed image
// whose clear-glass interior has been punched out to full transparency by a
// previous Poof pass; handing those transparent voids straight to the edit
// endpoint lets the model faithfully reproduce the holes. Flattening onto a
// solid neutral grey gives it a continuous, hole-free canvas to reconstruct
// from, and matches the studio sweep REIMAGINE_PROMPT asks for so the model is
// not reconciling two different backdrop colors. Keep this value and the
// "mid-light grey" wording in REIMAGINE_PROMPT aligned.
const OPENAI_INPUT_BACKDROP = { r: 209, g: 209, b: 209 } as const;

async function toPngForOpenAI(buffer: Buffer, maxDimension: number): Promise<Buffer> {
  return sharp(buffer)
    .rotate()
    .resize(maxDimension, maxDimension, {
      fit: "inside",
      withoutEnlargement: true,
    })
    // flatten() drops the alpha channel by compositing transparent pixels —
    // including punched-out interior voids — over the neutral backdrop, so the
    // model never sees (and never copies) the holes left by prior bg removal.
    .flatten({ background: OPENAI_INPUT_BACKDROP })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

type OpenAIImageEditsResponse = {
  data?: Array<{ b64_json?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
  error?: { message?: string };
};

// Token usage parsed from the edits response, used to bill the ledger at the
// true token-based rate (the image-input tokens are the bulk of an edit bill).
export type ReimagineTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  textInputTokens: number;
  imageInputTokens: number;
};

type OpenAIImageEditsResult = {
  buffer: Buffer;
  usage: ReimagineTokenUsage | null;
};

async function callOpenAIImageEdits(input: {
  pngBuffer: Buffer;
  model: ReimagineModel;
  quality: ReimagineQuality;
  apiKey: string;
}): Promise<OpenAIImageEditsResult> {
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("image", input.pngBuffer, { filename: "bottle.png", contentType: "image/png" });
  form.append("model", input.model);
  form.append("prompt", REIMAGINE_PROMPT);
  form.append("n", "1");
  form.append("size", DEFAULT_REIMAGINE_SIZE);
  form.append("quality", input.quality);
  // No `background=transparent` here: gpt-image-2 may not honor it, and even
  // when it does the alpha edges are inconsistent. Transparency is delivered
  // by piping the raw model output through removeBgBuffer (Poof) afterwards,
  // which is the same path the rest of the wardrobe image pipeline uses.
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

  const rawUsage = res.data?.usage;
  let usage: ReimagineTokenUsage | null = null;
  if (rawUsage && typeof rawUsage.output_tokens === "number") {
    const imageInputTokens = rawUsage.input_tokens_details?.image_tokens ?? 0;
    const textInputTokens =
      rawUsage.input_tokens_details?.text_tokens ??
      Math.max(0, (rawUsage.input_tokens ?? 0) - imageInputTokens);
    usage = {
      inputTokens: rawUsage.input_tokens ?? imageInputTokens + textInputTokens,
      outputTokens: rawUsage.output_tokens,
      textInputTokens,
      imageInputTokens,
    };
  }
  return { buffer: out, usage };
}

async function bgRemoveAndEncode(rawModelBuffer: Buffer): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
  backgroundRemoved: boolean;
  removeBgStatus: RemoveBgStatus;
  removeBgReason: RemoveBgReason;
}> {
  // Always pipe the raw model output through the same bg-removal service the
  // rest of the wardrobe pipeline uses. Even if gpt-image-2 returns a clean
  // packshot, Poof gives us a reliable alpha edge and the standard 768px
  // packshot framing. The reimagine output is, by construction, a single
  // isolated product packshot on a uniform studio sweep, so we request Poof's
  // `type=product` preset — it cuts product packshots more cleanly than the
  // auto preset and carries the "preserved an opaque light background" retry
  // guard, which matters now that the model sits the bottle on a mid-light grey
  // sweep instead of pure white. If Poof is unavailable, removeBgBuffer falls
  // back to local trim so we still get a usable image.
  // We have already paid OpenAI for `rawModelBuffer` by the time we get here, so
  // nothing below this point is allowed to discard those bytes. removeBgBuffer
  // itself never throws (it falls back to a local trim), but the downstream
  // sharp re-encode can throw on a malformed buffer — if it does we salvage by
  // encoding the raw model output directly rather than 502-ing on a paid image.
  const removed = await removeBgBuffer(rawModelBuffer, { poofType: "product" });

  async function encode(
    src: Buffer,
    backgroundRemoved: boolean,
    removeBgStatus: RemoveBgStatus,
    removeBgReason: RemoveBgReason,
  ) {
    const encoded = await sharp(src, { failOn: "truncated" })
      .rotate()
      .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .webp({ quality: WEBP_QUALITY, effort: 4, alphaQuality: 95 })
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
      backgroundRemoved,
      removeBgStatus,
      removeBgReason,
    };
  }

  try {
    return await encode(
      removed.buffer,
      removed.backgroundRemoved,
      removed.removeBgStatus,
      removed.removeBgReason,
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[reimagine] post-bg encode failed; salvaging raw paid model output without bg removal",
    );
    // Last-resort salvage: encode the raw model output we paid for. A packshot
    // with the studio-grey backdrop still showing beats throwing away the bill.
    return await encode(rawModelBuffer, false, "fallback", "local_trim_fallback");
  }
}

export type ReimagineBottleImageInput = {
  brand: string;
  name: string;
  sourceUrl: string;
  model?: string | null;
  userId?: string | null;
  fragranceId?: string | null;
  /**
   * When true, skip the cache pre-check and always bill a fresh OpenAI
   * generation. Lets a user deliberately re-roll a result they didn't like
   * while identical/accidental repeat clicks stay free by default.
   */
  force?: boolean;
};

export type ReimagineBottleImageResult = CachedImageReference & {
  model: ReimagineModel;
};

// Identity of a reimagine *input* (source image + model + quality), independent
// of the non-deterministic output. Stored as the row's searchQueryHash so an
// identical request can be served from cache instead of re-billing OpenAI.
function reimagineInputIdentityHash(
  inputHash: string,
  model: ReimagineModel,
  quality: ReimagineQuality,
): string {
  return hashString(`openai-reimagine-input:${model}:${quality}:${inputHash}`);
}

export async function reimagineBottleImage(
  input: ReimagineBottleImageInput,
): Promise<ReimagineBottleImageResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const model = resolveModel(input.model);
  const quality = resolveQuality();
  const lookupKey = makeLookupKey(input.brand, input.name);
  const sourceProvider = "openai" as const;

  const loaded = await loadSourceBytes(input.sourceUrl);
  const inputIdentityHash = reimagineInputIdentityHash(loaded.inputHash, model, quality);

  // Cost guard: an identical (source, model, quality) reimagine that already
  // produced a ready image is returned straight from cache — no second OpenAI
  // bill. `force` opts out for a deliberate re-roll.
  if (!input.force) {
    const cached = await getLatestReadyCachedImageBySearchQueryHash(inputIdentityHash);
    if (cached) {
      logger.info(
        { lookupKey, model, quality, sourceUrlHash: cached.sourceUrlHash },
        "[reimagine] served cached reimagine; skipped OpenAI call",
      );
      return { ...cached, model };
    }
  }

  const pngForEdit = await toPngForOpenAI(loaded.buffer, resolveInputMaxDimension());

  logger.info(
    {
      lookupKey,
      model,
      quality,
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
  let usage: ReimagineTokenUsage | null;
  try {
    ({ buffer: generated, usage } = await callOpenAIImageEdits({
      pngBuffer: pngForEdit,
      model,
      quality,
      apiKey,
    }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : "OpenAI image edit failed";
    await recordApiUsage({
      userId: input.userId ?? null,
      provider: "openai",
      operation: "image.edits",
      model,
      size: DEFAULT_REIMAGINE_SIZE,
      quality,
      imageCount: 1,
      status: "failure",
      failureReason: reason,
    });
    throw err;
  }

  // OpenAI has now billed us. Record the true token-based cost (image-input
  // tokens included) so the in-app meter matches the real bill instead of the
  // flat per-image estimate that ignored edit input tokens.
  await recordApiUsage({
    userId: input.userId ?? null,
    provider: "openai",
    operation: "image.edits",
    model,
    size: DEFAULT_REIMAGINE_SIZE,
    quality,
    imageCount: 1,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    imageInputTokens: usage?.imageInputTokens ?? null,
    textInputTokens: usage?.textInputTokens ?? null,
    status: "success",
  });

  const optimized = await bgRemoveAndEncode(generated);
  const contentHash = hashBuffer(optimized.buffer);

  logger.info(
    {
      lookupKey,
      model,
      backgroundRemoved: optimized.backgroundRemoved,
      removeBgStatus: optimized.removeBgStatus,
      removeBgReason: optimized.removeBgReason,
      width: optimized.width,
      height: optimized.height,
    },
    "[reimagine] bg removal complete",
  );

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
      // Keyed on the input identity (source + model + quality) so the next
      // identical reimagine is a cache hit and never re-bills OpenAI.
      searchQueryHash: inputIdentityHash,
      contentHash,
      storageProvider: uploaded.provider,
      storagePath: uploaded.storagePath,
      publicUrl,
      mimeType: "image/webp",
      width: optimized.width,
      height: optimized.height,
      sizeBytes: uploaded.sizeBytes || optimized.sizeBytes,
      backgroundRemoved: optimized.backgroundRemoved,
      removeBgStatus: optimized.removeBgStatus,
      removeBgReason: optimized.removeBgReason,
    });

    if (!recorded.isPersisted) {
      logger.warn(
        {
          lookupKey,
          sourceUrlHash,
          sourceProvider,
          storagePath: recorded.storagePath,
          model,
        },
        "[reimagine] image_cache row not persisted (DB unavailable); next request will re-run OpenAI reimagine + storage upload",
      );
    }

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
