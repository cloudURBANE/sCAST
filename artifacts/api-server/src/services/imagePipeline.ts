import sharp from "sharp";
import { logger } from "../lib/logger";
import { makeLookupKey } from "./catalogService";
import { removeBgBuffer, removeBgToBuffer, type RemoveBgOptions, type RemoveBgReason, type RemoveBgStatus } from "./bgService";
import { isEffectivelyTransparent } from "./bgServiceCore";
import { type OrientationMetadata } from "./orientationEngine";
import {
  computeFragranceIdentityCoverage,
  scoreProcessedSerperCandidateBreakdown,
  shouldSkipSerperCandidateByIdentity,
  type ImageCandidateScoreBreakdown,
} from "./imageCandidateRanking";
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
import { shouldNegativeCacheImageFailure } from "./imagePipelineFailureClassifier";
import { safeImageUrlForResponse } from "./persistenceGuards";
import { fetchExternalImage, parseAndValidateExternalImageUrl } from "./safeImageFetch";
import { searchSerperImageCandidates, type SerperImageCandidate } from "./serperService";
import { acceptsImageCacheForRequest, shouldUseImageLookupCaches } from "./imagePipelineCachePolicy";
export { acceptsImageCacheForRequest, shouldUseImageLookupCaches };

const MAX_OUTPUT_DIMENSION = 1024;
const WEBP_QUALITY = 82;
const MAX_CANDIDATES_PER_ATTEMPT = 5;
const EARLY_ACCEPT_PROCESSED_SCORE = 17;

type ImageSourceProvider = "serper" | "manual";

type PipelineSource = {
  sourceUrlForProcessing: string;
  sourceUrlForDb: string;
  sourceUrlHash: string;
  isRemote: boolean;
  localObjectPath?: string;
};

export type ProcessedImageResult = CachedImageReference & {
  sourceProvider: string;
  pipelineVersion: string;
  removeBgStatus?: RemoveBgStatus | null;
  removeBgReason?: RemoveBgReason | null;
  imagePipelineTrace?: ImagePipelineTrace;
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
  fixtureId?: string | null;
  traceId?: string | null;
};

export type ImagePipelineCandidateTrace = {
  ordinal: number;
  sourceProvider: ImageSourceProvider;
  sourceUrlHash?: string;
  serperScore?: number;
  identityCoverage?: number;
  titlePreview?: string;
  sourcePreview?: string;
  skipped?: boolean;
  skipReason?: "low_identity" | "source_rejected" | "processing_failed";
  rejectionReason?: string;
  score?: ImageCandidateScoreBreakdown;
  backgroundRemoved?: boolean;
  removeBgStatus?: RemoveBgStatus | null;
  removeBgReason?: RemoveBgReason | null;
  width?: number | null;
  height?: number | null;
  cached?: boolean;
};

export type ImagePipelineTrace = {
  lookupKey: string;
  sourceProvider: ImageSourceProvider;
  searchQueryHash: string | null;
  fixtureId?: string;
  traceId?: string;
  selectedOrdinal: number | null;
  selectedScore: number | null;
  finalSourceUrlHash: string | null;
  finalRemoveBgStatus: RemoveBgStatus | null;
  finalRemoveBgReason: RemoveBgReason | null;
  finalBackgroundRemoved: boolean | null;
  candidates: ImagePipelineCandidateTrace[];
};

const inFlightBySource = new Map<string, Promise<ProcessedImageResult | null>>();

function inFlightKey(sourceUrlHash: string, removeBackground: boolean): string {
  return `${sourceUrlHash}:${removeBackground ? "1" : "0"}`;
}

// Search-query-level in-flight dedup. `inFlightBySource` only converges AFTER
// Serper resolves a candidate URL, so two concurrent FIRST-time requests for the
// same search query both hit Serper before they can share a source hash. This
// map collapses them one step earlier — at the query+bg granularity — so the
// duplicate Serper round-trip (and the redundant Poof/sharp work behind it) is
// avoided. Writes are idempotent, so this is purely a cost optimization.
const inFlightBySearchQuery = new Map<string, Promise<ProcessedImageResult | null>>();

// Keyed by lookupKey too: two different fragrances whose search queries
// normalize to the same hash must NOT share one in-flight result, or the first
// caller's bottle is handed to the second (and persisted for it).
function searchQueryFlightKey(
  lookupKey: string,
  searchQueryHash: string,
  removeBackground: boolean,
): string {
  return `${lookupKey}:${searchQueryHash}:${removeBackground ? "1" : "0"}`;
}

function preview(value: string | undefined, max = 140): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function makeTrace(params: {
  lookupKey: string;
  sourceProvider: ImageSourceProvider;
  searchQueryHash: string | null;
  fixtureId?: string | null;
  traceId?: string | null;
  candidates?: ImagePipelineCandidateTrace[];
  selectedOrdinal?: number | null;
  selectedScore?: number | null;
  final?: ProcessedImageResult | null;
}): ImagePipelineTrace {
  return {
    lookupKey: params.lookupKey,
    sourceProvider: params.sourceProvider,
    searchQueryHash: params.searchQueryHash,
    ...(params.fixtureId ? { fixtureId: params.fixtureId } : {}),
    ...(params.traceId ? { traceId: params.traceId } : {}),
    selectedOrdinal: params.selectedOrdinal ?? null,
    selectedScore: params.selectedScore ?? null,
    finalSourceUrlHash: params.final?.sourceUrlHash ?? null,
    finalRemoveBgStatus: params.final?.removeBgStatus ?? null,
    finalRemoveBgReason: params.final?.removeBgReason ?? null,
    finalBackgroundRemoved: params.final?.backgroundRemoved ?? null,
    candidates: params.candidates ?? [],
  };
}

function attachTrace(result: ProcessedImageResult, trace: ImagePipelineTrace): ProcessedImageResult {
  logger.info(
    {
      lookupKey: trace.lookupKey,
      sourceProvider: trace.sourceProvider,
      searchQueryHash: trace.searchQueryHash,
      fixtureId: trace.fixtureId ?? null,
      traceId: trace.traceId ?? null,
      selectedOrdinal: trace.selectedOrdinal,
      selectedScore: trace.selectedScore,
      finalSourceUrlHash: trace.finalSourceUrlHash,
      finalRemoveBgStatus: trace.finalRemoveBgStatus,
      finalRemoveBgReason: trace.finalRemoveBgReason,
      finalBackgroundRemoved: trace.finalBackgroundRemoved,
      candidateCount: trace.candidates.length,
    },
    "[imagePipeline] selected processed image",
  );
  return { ...result, imagePipelineTrace: trace };
}

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
  orientation: OrientationMetadata | null;
}> {
  const processed = removeBackground
    ? source.localObjectPath
      ? await removeBgBuffer(await readLocalImageObject(source.localObjectPath), poofOptions)
      : await removeBgToBuffer(source.sourceUrlForProcessing, source.isRemote, poofOptions)
    : await loadSourceWithoutBackgroundRemoval(source).then((loaded) => ({
        // Non-BG path: hand the raw fetched buffer directly to the Sharp finalization
        // chain below. Do NOT call normalizePackshotBuffer here — it pre-resizes and
        // bakes in transparent padding gutters, which then get re-resized by Sharp
        // (double-resize) and waste the 1024px output budget on empty space.
        buffer: loaded.buffer,
        backgroundRemoved: loaded.backgroundRemoved,
        contentType: "image/png" as const,
        removeBgStatus: "skipped" as const,
        removeBgReason: "skipped" as const,
        orientation: null,
      }));

  if (!processed) throw new Error("Image processing failed");

  let outputPipeline = sharp(processed.buffer, { failOn: "truncated" })
    .rotate()
    .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    });
  // Preserve transparency through WebP encode when the upstream produced an
  // alpha-bearing image (i.e. background was actually removed). Sharp's WebP
  // encoder honors alpha when present; ensureAlpha guarantees it is present
  // even if an intermediate step happened to drop the channel.
  if (processed.backgroundRemoved) {
    outputPipeline = outputPipeline.ensureAlpha();
  }
  let optimized = await outputPipeline.webp({ quality: WEBP_QUALITY, effort: 4 }).toBuffer();

  // Defense in depth: even though bgService now rejects fully transparent
  // Poof output, run one final check on the encoded WebP. If we ever end up
  // here with an invisible buffer (e.g. a future code path bypasses the
  // Poof-side guard), fall back to a non-BG re-encode of the original source
  // and downgrade the status so the row never lies about what was stored.
  let backgroundRemoved = processed.backgroundRemoved;
  let removeBgStatus = processed.removeBgStatus;
  let removeBgReason = processed.removeBgReason;
  // Orientation geometry rides along only on the BG-removed cut-out path. The
  // engine already emitted a 1024x1024 square, so the resize above is a no-op for
  // it; the WebP re-encode preserves the canvas and alpha.
  let orientation = processed.orientation ?? null;
  if (backgroundRemoved && (await isEffectivelyTransparent(optimized))) {
    logger.warn(
      { removeBgReason: "poof_empty_output" },
      "[imagePipeline] post-encode WebP was fully transparent; reverting to non-BG fallback",
    );
    const loaded = await loadSourceWithoutBackgroundRemoval(source);
    optimized = await sharp(loaded.buffer, { failOn: "truncated" })
      .rotate()
      .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY, effort: 4 })
      .toBuffer();
    backgroundRemoved = false;
    removeBgStatus = "fallback";
    removeBgReason = "poof_empty_output";
    // We just discarded the oriented cut-out for a non-BG re-encode, so its
    // geometry no longer describes the stored bytes.
    orientation = null;
  }

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
    backgroundRemoved,
    removeBgStatus,
    removeBgReason,
    orientation,
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
  const cached = await getReadyCachedImageBySourceHash(input.source.sourceUrlHash, input.removeBackground);
  if (cached) {
    // Serve when the cache satisfies the request: a bg-removed cutout, OR a
    // deterministic white-bg fallback for a source that can't be cut out.
    if (acceptsImageCacheForRequest(cached, input.removeBackground)) {
      return { ...cached, sourceProvider: input.sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION };
    }
  }

  const status = await getCachedImageStatusBySourceHash(input.source.sourceUrlHash, input.removeBackground);
  if (status === "failed") return null;

  const flightKey = inFlightKey(input.source.sourceUrlHash, input.removeBackground);
  const existing = inFlightBySource.get(flightKey);
  if (existing) return existing;

  const promise = (async (): Promise<ProcessedImageResult | null> => {
    try {
      const doubleCheck = await getReadyCachedImageBySourceHash(input.source.sourceUrlHash, input.removeBackground);
      if (doubleCheck) {
        if (acceptsImageCacheForRequest(doubleCheck, input.removeBackground)) {
          return { ...doubleCheck, sourceProvider: input.sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION };
        }
        // Cached entry lacks BG removal and isn't a deterministic fallback; reprocess.
      }

      const optimized = await processSourceToWebp(input.source, input.removeBackground, input.poofOptions);
      const storage = getImageObjectStorage();
      // Include the content hash in the storage key so different processed
      // outputs (e.g. an old white-bg fallback vs. a fresh transparent packshot
      // for the same source URL) live at different immutable storage paths.
      // Without this, the browser/CDN can serve the stale object even after
      // the DB row points to a new "backgroundRemoved: true" result.
      const storagePath = buildProcessedImageStorageKey({
        sourceProvider: input.sourceProvider,
        lookupKey: input.lookupKey,
        sourceUrlHash: input.source.sourceUrlHash,
        contentHash: optimized.contentHash,
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
        removeBgStatus: optimized.removeBgStatus,
        removeBgReason: optimized.removeBgReason,
        orientation: optimized.orientation,
      });

      if (!recorded.isPersisted) {
        logger.warn(
          {
            lookupKey: input.lookupKey,
            sourceUrlHash: input.source.sourceUrlHash,
            sourceProvider: input.sourceProvider,
            storagePath: recorded.storagePath,
          },
          "[imagePipeline] image_cache row not persisted (DB unavailable); next request for this source will re-run Serper + Poof + sharp + upload",
        );
      }

      return { ...recorded, sourceProvider: input.sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION, removeBgStatus: optimized.removeBgStatus, removeBgReason: optimized.removeBgReason };
    } catch (err: any) {
      if (err instanceof ImageObjectStorageConfigurationError) throw err;
      const reason = err?.message ?? "image processing failed";
      // Only persist a negative-cache row for deterministic, source/content-level
      // failures. Transient failures (upstream 5xx/429, DNS/network blips,
      // storage or DB hiccups) must NOT be cached: the row is keyed on the source
      // URL hash, so one blip would otherwise black out this source for every
      // caller for the full retry window. Transient failures simply return null
      // and are retried on the next request (image-pipeline audit, finding #4).
      if (shouldNegativeCacheImageFailure(err)) {
        await recordImageFailure({
          userId: input.userId ?? null,
          fragranceId: input.fragranceId ?? null,
          lookupKey: input.lookupKey,
          sourceProvider: input.sourceProvider,
          sourceUrl: input.source.sourceUrlForDb,
          sourceUrlHash: input.source.sourceUrlHash,
          searchQueryHash: input.searchQueryHash,
          // Negative-cache the variant that was requested: a removeBackground
          // failure must not suppress a no-bg request, and vice versa.
          backgroundRemoved: input.removeBackground,
          failureReason: reason,
        }).catch(() => {});
        logger.warn({ err: reason }, "[imagePipeline] candidate failed (negative-cached)");
      } else {
        logger.warn({ err: reason }, "[imagePipeline] candidate failed transiently (will retry)");
      }
      return null;
    } finally {
      inFlightBySource.delete(flightKey);
    }
  })();

  inFlightBySource.set(flightKey, promise);
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
  // Collapse concurrent first-time requests for the SAME search query (Serper
  // path only — a manually supplied `sourceUrl` is already deduped by
  // `inFlightBySource`, and a request with no query can't be keyed here). The
  // deferred-image build path fires many of these in parallel, so this is where
  // the duplicate Serper calls originate.
  const searchQueryHash = input.searchQuery ? hashSearchQuery(input.searchQuery) : null;
  if (!searchQueryHash || input.sourceUrl) {
    return resolveProcessedFragranceImageInner(input, searchQueryHash);
  }

  const removeBackground = input.removeBackground ?? true;
  const lookupKey = makeLookupKey(input.brand, input.name);
  const flightKey = searchQueryFlightKey(lookupKey, searchQueryHash, removeBackground);
  const existing = inFlightBySearchQuery.get(flightKey);
  if (existing) return existing;

  const promise = resolveProcessedFragranceImageInner(input, searchQueryHash).finally(() => {
    inFlightBySearchQuery.delete(flightKey);
  });
  inFlightBySearchQuery.set(flightKey, promise);
  return promise;
}

async function resolveProcessedFragranceImageInner(
  input: ResolveProcessedFragranceImageInput,
  searchQueryHash: string | null,
): Promise<ProcessedImageResult | null> {
  const lookupKey = makeLookupKey(input.brand, input.name);
  const sourceProvider = input.sourceProvider ?? (input.sourceUrl ? "manual" : "serper");
  const removeBackground = input.removeBackground ?? true;
  const traceBase = {
    lookupKey,
    sourceProvider,
    searchQueryHash,
    fixtureId: input.fixtureId,
    traceId: input.traceId,
  };

  if (input.allowLookupCache !== false && !input.sourceUrl) {
    const cachedByLookup = await getLatestReadyCachedImageByLookupKey(lookupKey);
    if (cachedByLookup && acceptsImageCacheForRequest(cachedByLookup, removeBackground)) {
      const result = { ...cachedByLookup, pipelineVersion: IMAGE_PIPELINE_VERSION };
      return attachTrace(result, makeTrace({ ...traceBase, final: result }));
    }
  }

  if (input.allowLookupCache !== false && !input.sourceUrl && searchQueryHash) {
    const cachedByQuery = await getLatestReadyCachedImageBySearchQueryHash(searchQueryHash, lookupKey);
    if (cachedByQuery && acceptsImageCacheForRequest(cachedByQuery, removeBackground)) {
      const result = { ...cachedByQuery, pipelineVersion: IMAGE_PIPELINE_VERSION };
      return attachTrace(result, makeTrace({ ...traceBase, final: result }));
    }
  }

  const candidates: SerperImageCandidate[] = [];
  if (input.sourceUrl) {
    candidates.push({ imageUrl: input.sourceUrl, score: 0 });
  } else if (input.searchQuery?.trim()) {
    const serperCandidates: SerperImageCandidate[] = await searchSerperImageCandidates(
      input.searchQuery,
      input.serperRefine,
    );
    candidates.push(...serperCandidates);
  }

  if (candidates.length === 0) return null;

  const maxCandidates = Math.max(1, Math.min(input.maxCandidates ?? MAX_CANDIDATES_PER_ATTEMPT, 8));
  const candidateTraces: ImagePipelineCandidateTrace[] = [];
  let best: { result: ProcessedImageResult; score: number; ordinal: number } | null = null;

  for (const [index, candidate] of candidates.slice(0, maxCandidates).entries()) {
    const ordinal = index + 1;
    const candidateTrace: ImagePipelineCandidateTrace = {
      ordinal,
      sourceProvider,
      serperScore: Number.isFinite(candidate.score) ? candidate.score : undefined,
      identityCoverage:
        sourceProvider === "serper"
          ? computeFragranceIdentityCoverage(input.brand, input.name, candidate)
          : undefined,
      titlePreview: preview(candidate.title),
      sourcePreview: preview(candidate.source),
    };
    candidateTraces.push(candidateTrace);

    if (
      sourceProvider === "serper" &&
      shouldSkipSerperCandidateByIdentity(input.brand, input.name, candidate)
    ) {
      candidateTrace.skipped = true;
      candidateTrace.skipReason = "low_identity";
      logger.info(
        {
          lookupKey,
          fixtureId: input.fixtureId ?? null,
          traceId: input.traceId ?? null,
          ordinal,
          brand: input.brand,
          name: input.name,
          score: candidate.score,
          identityCoverage: candidateTrace.identityCoverage,
          candidateTitle: (candidate.title ?? "").slice(0, 140),
          candidateSource: (candidate.source ?? "").slice(0, 140),
        },
        "[imagePipeline] skipped low-identity serper candidate",
      );
      continue;
    }

    let source: PipelineSource;
    try {
      source = sourceFromInput(candidate.imageUrl);
      candidateTrace.sourceUrlHash = source.sourceUrlHash;
    } catch (err: any) {
      candidateTrace.skipped = true;
      candidateTrace.skipReason = "source_rejected";
      candidateTrace.rejectionReason = err?.message ?? "source rejected";
      logger.warn(
        {
          lookupKey,
          fixtureId: input.fixtureId ?? null,
          traceId: input.traceId ?? null,
          ordinal,
          err: err?.message,
        },
        "[imagePipeline] source rejected",
      );
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
    if (!result) {
      candidateTrace.skipped = true;
      candidateTrace.skipReason = "processing_failed";
      logger.info(
        {
          lookupKey,
          fixtureId: input.fixtureId ?? null,
          traceId: input.traceId ?? null,
          ordinal,
          sourceProvider,
          sourceUrlHash: source.sourceUrlHash,
        },
        "[imagePipeline] candidate processing returned no result",
      );
      continue;
    }

    candidateTrace.backgroundRemoved = result.backgroundRemoved;
    candidateTrace.removeBgStatus = result.removeBgStatus;
    candidateTrace.removeBgReason = result.removeBgReason;
    candidateTrace.width = result.width;
    candidateTrace.height = result.height;
    candidateTrace.cached = result.cached;

    if (sourceProvider !== "serper") {
      return attachTrace(
        result,
        makeTrace({
          ...traceBase,
          candidates: candidateTraces,
          selectedOrdinal: ordinal,
          final: result,
        }),
      );
    }

    const scoreBreakdown = scoreProcessedSerperCandidateBreakdown({
      brand: input.brand,
      name: input.name,
      removeBackground,
      serperCandidate: candidate,
      processed: {
        width: result.width,
        height: result.height,
        backgroundRemoved: result.backgroundRemoved,
        removeBgStatus: result.removeBgStatus ?? undefined,
      },
    });
    candidateTrace.score = scoreBreakdown;
    const candidateScore = scoreBreakdown.total;

    logger.info(
      {
        lookupKey,
        fixtureId: input.fixtureId ?? null,
        traceId: input.traceId ?? null,
        ordinal,
        sourceProvider,
        sourceUrlHash: source.sourceUrlHash,
        candidateScore: scoreBreakdown,
        finalRemoveBgStatus: result.removeBgStatus ?? null,
        finalRemoveBgReason: result.removeBgReason ?? null,
        finalBackgroundRemoved: result.backgroundRemoved,
        width: result.width,
        height: result.height,
        cached: result.cached,
      },
      "[imagePipeline] scored serper candidate",
    );

    if (!best || candidateScore > best.score) {
      best = { result, score: candidateScore, ordinal };
    }

    if (candidateScore >= EARLY_ACCEPT_PROCESSED_SCORE) {
      return attachTrace(
        best.result,
        makeTrace({
          ...traceBase,
          candidates: candidateTraces,
          selectedOrdinal: best.ordinal,
          selectedScore: best.score,
          final: best.result,
        }),
      );
    }
  }

  if (!best) {
    logger.info(
      {
        lookupKey,
        fixtureId: input.fixtureId ?? null,
        traceId: input.traceId ?? null,
        sourceProvider,
        searchQueryHash,
        candidateCount: candidateTraces.length,
      },
      "[imagePipeline] no usable image candidate selected",
    );
    return null;
  }

  return attachTrace(
    best.result,
    makeTrace({
      ...traceBase,
      candidates: candidateTraces,
      selectedOrdinal: best.ordinal,
      selectedScore: best.score,
      final: best.result,
    }),
  );
}
