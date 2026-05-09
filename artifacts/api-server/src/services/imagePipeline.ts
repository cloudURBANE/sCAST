import sharp from "sharp";
import { logger } from "../lib/logger";
import { makeLookupKey } from "./catalogService";
import { normalizePackshotBuffer, removeBgBuffer, removeBgToBuffer, type RemoveBgOptions, type RemoveBgReason, type RemoveBgStatus } from "./bgService";
import {
  buildProcessedImageStorageKey,
  getCachedImageStatusBySourceHash,
  getLatestReadyCachedImageByLookupKey,
  getLatestReadyCachedImageBySearchQueryHash,
  getReadyCachedImageBySourceHash,
  hashBuffer,
  hashSearchQuery,
  hashSourceUrl,
  hashString,
  IMAGE_PIPELINE_VERSION,
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
import { fetchExternalImage, parseAndValidateExternalImageUrl } from "./safeImageFetch";
import { searchSerperImageCandidates, type SerperImageCandidate } from "./serperService";

const MAX_OUTPUT_DIMENSION = 768;
const WEBP_QUALITY = 82;
const MAX_CANDIDATES_PER_ATTEMPT = 5;

type ImageSourceProvider = "serper" | "manual";

type PipelineSource = {
  sourceUrlForProcessing: string;
  sourceUrlForDb: string;
  sourceUrlHash: string;
  isRemote: boolean;
  localObjectPath?: string;
};

export type ProcessedImageResult = CachedImageReference & {
  sourceProvider: ImageSourceProvider;
  pipelineVersion: string;
  removeBgStatus?: RemoveBgStatus;
  removeBgReason?: RemoveBgReason;
};

export type ResolveProcessedFragranceImageInput = {
  brand: string;
  name: string;
  searchQuery?: string;
  sourceUrl?: string;
  sourceProvider?: ImageSourceProvider;
  userId?: string | null;
  fragranceId?: string | null;
  allowLookupCache?: boolean;
  removeBackground?: boolean;
  poofOptions?: RemoveBgOptions;
  serperRefine?: Parameters<typeof searchSerperImageCandidates>[1];
  maxCandidates?: number;
};

const inFlightBySource = new Map<string, Promise<ProcessedImageResult | null>>();

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

function sourceFromInput(raw: string): PipelineSource {
  const trimmed = raw.trim();
  if (trimmed.startsWith("/api/image-objects/")) {
    const storagePath = storagePathFromLocalImageObjectUrl(trimmed);
    if (!storagePath) throw new Error("Invalid local image object URL");
    const sourceUrlHash = hashString(`local-object:${storagePath}`);
    return {
      sourceUrlForProcessing: trimmed,
      sourceUrlForDb: `local-object:${storagePath}`,
      sourceUrlHash,
      isRemote: false,
      localObjectPath: storagePath,
    };
  }

  if (trimmed.startsWith("data:image/")) {
    const decoded = decodeDataImage(trimmed);
    if (!decoded) throw new Error("Invalid or oversized data image");
    const contentHash = hashBuffer(decoded);
    const sourceUrlHash = hashString(`data-image:${contentHash}`);
    return {
      sourceUrlForProcessing: trimmed,
      sourceUrlForDb: `data-image:${contentHash}`,
      sourceUrlHash,
      isRemote: false,
    };
  }

  const parsed = parseAndValidateExternalImageUrl(trimmed);
  const normalized = parsed.toString();
  return {
    sourceUrlForProcessing: normalized,
    sourceUrlForDb: normalized,
    sourceUrlHash: hashSourceUrl(normalized),
    isRemote: true,
  };
}

async function loadSourceWithoutBackgroundRemoval(source: PipelineSource): Promise<{
  buffer: Buffer;
  backgroundRemoved: boolean;
}> {
  if (!source.isRemote) {
    if (source.localObjectPath) {
      return {
        buffer: await readLocalImageObject(source.localObjectPath),
        backgroundRemoved: false,
      };
    }
    const decoded = decodeDataImage(source.sourceUrlForProcessing);
    if (!decoded) throw new Error("Invalid data image");
    return { buffer: decoded, backgroundRemoved: false };
  }

  const downloaded = await fetchExternalImage(source.sourceUrlForProcessing);
  return { buffer: downloaded.buffer, backgroundRemoved: false };
}

async function processSourceToWebp(
  source: PipelineSource,
  removeBackground: boolean,
  poofOptions?: RemoveBgOptions,
): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: "image/webp";
  sizeBytes: number;
  contentHash: string;
  backgroundRemoved: boolean;
  removeBgStatus: RemoveBgStatus;
  removeBgReason: RemoveBgReason;
}> {
  const processed = removeBackground
    ? source.localObjectPath
      ? await removeBgBuffer(await readLocalImageObject(source.localObjectPath), poofOptions)
      : await removeBgToBuffer(source.sourceUrlForProcessing, source.isRemote, poofOptions)
    : await loadSourceWithoutBackgroundRemoval(source).then(async (loaded) => ({
        buffer: await normalizePackshotBuffer(loaded.buffer),
        backgroundRemoved: loaded.backgroundRemoved,
        contentType: "image/png" as const,
        removeBgStatus: "fallback" as const,
        removeBgReason: "local_trim_fallback" as const,
      }));

  if (!processed) throw new Error("Image processing failed");

  let outputPipeline = sharp(processed.buffer, { failOn: "truncated" })
    .rotate()
    .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    });
  if (!processed.backgroundRemoved) outputPipeline = outputPipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
  const optimized = await outputPipeline.webp({ quality: WEBP_QUALITY, effort: 4 }).toBuffer();

  const metadata = await sharp(optimized).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error("Optimized image metadata missing dimensions");

  return {
    buffer: optimized,
    width,
    height,
    mimeType: "image/webp",
    sizeBytes: optimized.length,
    contentHash: hashBuffer(optimized),
    backgroundRemoved: processed.backgroundRemoved,
    removeBgStatus: processed.removeBgStatus,
    removeBgReason: processed.removeBgReason,
  };
}

async function processCandidate(input: {
  source: PipelineSource;
  sourceProvider: ImageSourceProvider;
  lookupKey: string;
  searchQueryHash: string | null;
  userId?: string | null;
  fragranceId?: string | null;
  removeBackground: boolean;
  poofOptions?: RemoveBgOptions;
}): Promise<ProcessedImageResult | null> {
  const cached = await getReadyCachedImageBySourceHash(input.source.sourceUrlHash);
  if (cached) {
    return { ...cached, sourceProvider: input.sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION };
  }

  const status = await getCachedImageStatusBySourceHash(input.source.sourceUrlHash);
  if (status === "failed") return null;

  const existing = inFlightBySource.get(input.source.sourceUrlHash);
  if (existing) return existing;

  const promise = (async (): Promise<ProcessedImageResult | null> => {
    try {
      const doubleCheck = await getReadyCachedImageBySourceHash(input.source.sourceUrlHash);
      if (doubleCheck) {
        return { ...doubleCheck, sourceProvider: input.sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION };
      }

      const optimized = await processSourceToWebp(input.source, input.removeBackground, input.poofOptions);
      const storage = getImageObjectStorage();
      const storagePath = buildProcessedImageStorageKey({
        sourceProvider: input.sourceProvider,
        lookupKey: input.lookupKey,
        sourceUrlHash: input.source.sourceUrlHash,
      });
      const uploaded = await storage.uploadProcessedImage({
        buffer: optimized.buffer,
        contentType: optimized.mimeType,
        key: storagePath,
      });

      const publicUrl = safeImageUrlForResponse(uploaded.publicUrl ?? uploaded.signedUrl ?? "");
      if (!publicUrl) throw new Error("Storage upload did not return a usable URL");

      const recorded = await recordImageReady({
        userId: input.userId ?? null,
        fragranceId: input.fragranceId ?? null,
        lookupKey: input.lookupKey,
        sourceProvider: input.sourceProvider,
        sourceUrl: input.source.sourceUrlForDb,
        sourceUrlHash: input.source.sourceUrlHash,
        searchQueryHash: input.searchQueryHash,
        contentHash: optimized.contentHash,
        storageProvider: uploaded.provider,
        storagePath: uploaded.storagePath,
        publicUrl,
        mimeType: optimized.mimeType,
        width: optimized.width,
        height: optimized.height,
        sizeBytes: uploaded.sizeBytes || optimized.sizeBytes,
        backgroundRemoved: optimized.backgroundRemoved,
      });

      return { ...recorded, sourceProvider: input.sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION, removeBgStatus: optimized.removeBgStatus, removeBgReason: optimized.removeBgReason };
    } catch (err: any) {
      if (err instanceof ImageObjectStorageConfigurationError) throw err;
      const reason = err?.message ?? "image processing failed";
      await recordImageFailure({
        userId: input.userId ?? null,
        fragranceId: input.fragranceId ?? null,
        lookupKey: input.lookupKey,
        sourceProvider: input.sourceProvider,
        sourceUrl: input.source.sourceUrlForDb,
        sourceUrlHash: input.source.sourceUrlHash,
        searchQueryHash: input.searchQueryHash,
        failureReason: reason,
      }).catch(() => {});
      logger.warn({ err: reason }, "[imagePipeline] candidate failed");
      return null;
    } finally {
      inFlightBySource.delete(input.source.sourceUrlHash);
    }
  })();

  inFlightBySource.set(input.source.sourceUrlHash, promise);
  return promise;
}

export async function resolveCachedFragranceImage(
  brand: string,
  name: string,
): Promise<CachedImageReference | null> {
  const lookupKey = makeLookupKey(brand, name);
  return getLatestReadyCachedImageByLookupKey(lookupKey);
}

export async function resolveProcessedFragranceImage(
  input: ResolveProcessedFragranceImageInput,
): Promise<ProcessedImageResult | null> {
  const lookupKey = makeLookupKey(input.brand, input.name);
  const sourceProvider = input.sourceProvider ?? (input.sourceUrl ? "manual" : "serper");
  const removeBackground = input.removeBackground ?? true;
  const searchQueryHash = input.searchQuery ? hashSearchQuery(input.searchQuery) : null;

  if (input.allowLookupCache !== false && !input.sourceUrl) {
    const cachedByLookup = await getLatestReadyCachedImageByLookupKey(lookupKey);
    if (cachedByLookup) {
      return { ...cachedByLookup, sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION };
    }
  }

  if (!input.sourceUrl && searchQueryHash) {
    const cachedByQuery = await getLatestReadyCachedImageBySearchQueryHash(searchQueryHash);
    if (cachedByQuery) {
      return { ...cachedByQuery, sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION };
    }
  }

  const candidates: Array<{ imageUrl: string }> = [];
  if (input.sourceUrl) {
    candidates.push({ imageUrl: input.sourceUrl });
  } else if (input.searchQuery?.trim()) {
    const serperCandidates: SerperImageCandidate[] = await searchSerperImageCandidates(
      input.searchQuery,
      input.serperRefine,
    );
    candidates.push(...serperCandidates);
  }

  if (candidates.length === 0) return null;

  const maxCandidates = Math.max(1, Math.min(input.maxCandidates ?? MAX_CANDIDATES_PER_ATTEMPT, 8));

  for (const candidate of candidates.slice(0, maxCandidates)) {
    let source: PipelineSource;
    try {
      source = sourceFromInput(candidate.imageUrl);
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[imagePipeline] source rejected");
      continue;
    }

    const result = await processCandidate({
      source,
      sourceProvider,
      lookupKey,
      searchQueryHash,
      userId: input.userId ?? null,
      fragranceId: input.fragranceId ?? null,
      removeBackground,
      poofOptions: input.poofOptions,
    });
    if (result) return result;
  }

  return null;
}
