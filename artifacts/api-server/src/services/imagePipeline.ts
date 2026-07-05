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
import { Semaphore } from "./imageProxyCache";
import { safeImageUrlForResponse } from "./persistenceGuards";
import { fetchExternalImage, parseAndValidateExternalImageUrl } from "./safeImageFetch";
import { searchSerperImageCandidates, type SerperImageCandidate } from "./serperService";
import {
  peekVisionGateVerdict,
  verifyAutomaticImageWinnerByUrl,
  verifyAutomaticImageWinnerBytes,
  visionGateCacheKey,
} from "./imageVisionGate";
import { pickVisionApprovedWinner } from "./imageVisionGateCore";
import { acceptsImageCacheForRequest, shouldUseImageLookupCaches } from "./imagePipelineCachePolicy";
export { acceptsImageCacheForRequest, shouldUseImageLookupCaches };

const MAX_OUTPUT_DIMENSION = 1024;
// Post-decode hard floor on the processed image's smaller edge. SERP candidates
// frequently omit dimensions, so the candidate scorer's min-edge term (which
// only *penalizes* sub-360px results) can still let a tiny thumbnail/favicon win
// as `best` when nothing better turns up — and it would then be stored and shown
// as a fragrance bottle. The resize uses `withoutEnlargement`, so a source
// smaller than this stays smaller than this; reject it outright so a usable
// candidate is tried instead. Conservative (200px): real packshots are 400px+,
// so this only rejects genuinely unusable thumbnails and never a legitimate
// bottle shot (WS-12 / image M4).
const MIN_PROCESSED_EDGE = 200;
const WEBP_QUALITY = 82;
const MAX_CANDIDATES_PER_ATTEMPT = 5;
const EARLY_ACCEPT_PROCESSED_SCORE = 17;
// A candidate can reach EARLY_ACCEPT_PROCESSED_SCORE on host-trust + dimensions
// alone (large, well-shaped image from a trusted retailer) while only matching a
// fraction of the fragrance's identity tokens — i.e. the brand's *other* flanker.
// Require real identity coverage before short-circuiting the candidate loop so a
// high-scoring-but-wrong bottle can't win before better-matching candidates are
// even scored. `best` is still tracked, so a low-coverage candidate remains
// eligible as the final fallback when nothing better turns up (WS-12).
// 0.8 (was 0.66): at 0.66 a 3-token target ("Dior Homme Intense") early-accepted
// a candidate matching only 2/3 tokens — i.e. exactly the wrong flanker ("Dior
// Homme") — before the correct candidate was even downloaded (audit W3). At 0.8
// a candidate may miss one token only for targets of 5+ tokens.
const EARLY_ACCEPT_MIN_IDENTITY_COVERAGE = 0.8;
// Wall-clock budget across the whole candidate loop. Each candidate can run a
// download + Poof call + sharp + upload (each individually timeout-bounded), but
// nothing bounded the *sum* — a run of slow candidates could keep the caller's
// request open far past any reasonable deadline. After a candidate finishes, if
// the elapsed time exceeds this budget we stop STARTING new candidates and return
// the current `best` (or null). This only prevents beginning more expensive work;
// it never abandons an in-progress candidate or a result already in hand (image L2).
const CANDIDATE_LOOP_BUDGET_MS = 45_000;

// "crawled" = the engine-harvested Fragrantica og:image passthrough (see
// imageProvenanceCore.ts). It follows the same single-sourceUrl processing path
// as "manual" (vision gate active, unscoped byte dedup) but keeps its own
// provider so cache priority and hydration never treat it as human-curated —
// its storage path lands under images/processed/crawled/ via imageIdentity.
type ImageSourceProvider = "serper" | "manual" | "crawled";

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
  /**
   * Serper candidates whose source URL hashes to one of these are skipped
   * (trace skipReason "current_image"). Used by the manual refresh route so a
   * solver run can never hand back the identical already-stored image and look
   * like a no-op. Ignored on the `sourceUrl` (manual) path.
   */
  excludeSourceUrlHashes?: string[];
  /**
   * Skip the per-source processed-image cache and re-run download + Poof +
   * sharp for each candidate. Used by solvers whose purpose is re-PROCESSING
   * the same source with different Poof options (e.g. transparent_glass) —
   * with the cache in play those options would never actually run. Negative
   * (failure) caching still applies.
   */
  bypassSourceCache?: boolean;
  /**
   * Vision validation gate (image selection audit Tier 3 #10 / Tier 1 #4):
   * when true, a winning candidate must pass a Gemini "single product bottle
   * of {brand} {name}?" check before being returned/persisted. Rejections are
   * recorded in the trace as skipReason "vision_rejected"; a rejected manual/
   * crawled source yields null so the caller can fall back to Serper, and a
   * rejected Serper winner falls through to the next-best candidate. Fail-open:
   * with no Gemini key, or on any model/network error or timeout, the gate is
   * a no-op pass-through. Set ONLY by the automatic resolution paths
   * (scentEngine deps wiring); user-curated paths (admin upload/paste-URL,
   * stripBgOnly, the manual refresh preview) keep unconditional accept.
   */
  visionGate?: boolean;
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
  skipReason?:
    | "low_identity"
    | "source_rejected"
    | "processing_failed"
    | "current_image"
    | "vision_rejected";
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

// Global concurrency gate for the PROCESSING stage (paid Serper search + Poof
// background removal + CPU-bound sharp encode). The in-flight maps above only
// collapse DUPLICATE work for the same fragrance; they do nothing to bound N
// *distinct* fragrances processed at once (e.g. a wardrobe rebuild or a burst of
// new adds), which otherwise fans out unbounded Serper/Poof calls and saturates
// libvips. This caps that fan-out. Unbounded queue (default) so callers wait
// rather than being rejected — every acquire() is paired with a finally release.
const PIPELINE_MAX_CONCURRENCY_RAW = Number(process.env["IMAGE_PIPELINE_MAX_CONCURRENCY"]);
const PIPELINE_MAX_CONCURRENCY =
  Number.isFinite(PIPELINE_MAX_CONCURRENCY_RAW) && PIPELINE_MAX_CONCURRENCY_RAW >= 1
    ? Math.floor(PIPELINE_MAX_CONCURRENCY_RAW)
    : 4;
const pipelineLimiter = new Semaphore(PIPELINE_MAX_CONCURRENCY);

// Serper in-flight dedup is scoped to the fragrance (image-pipeline H1/H3): two
// fragrances whose Serper search returns the same image URL share a
// sourceUrlHash, so an unscoped key would hand the first caller's processed
// bottle to the second. Manual/etc. sources keep the bare source-hash key
// (pure-bytes dedup) since their URL is fragrance-specific by construction.
function inFlightKey(
  sourceUrlHash: string,
  removeBackground: boolean,
  sourceProvider?: string,
  lookupKey?: string | null,
): string {
  const scope = sourceProvider === "serper" && lookupKey ? `:${lookupKey}` : "";
  return `${sourceUrlHash}:${removeBackground ? "1" : "0"}${scope}`;
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
  // Accept RFC 2045 line-wrapped base64: strip ASCII whitespace (CR/LF/space/tab)
  // from the payload before validating. Without this, a perfectly valid but
  // wrapped data URI fails the strict regex, returns null → "Invalid data image",
  // and gets 6h negative-cached as if the source itself were bad (image M3).
  const match = input.match(/^data:image\/(?:png|jpe?g|webp);base64,([a-z0-9+/=\s]+)$/i);
  if (!match?.[1]) return null;
  const payload = match[1].replace(/\s+/g, "");
  if (!payload || payload.length > 6_000_000) return null;
  try {
    return Buffer.from(payload, "base64");
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
  // Reject genuinely unusable thumbnails post-decode. This is deterministic for
  // the source (the resize never enlarges), so the candidate is skipped and a
  // better one is selected instead of a blurry icon being stored as the bottle.
  if (Math.min(width, height) < MIN_PROCESSED_EDGE) {
    throw new Error(
      `Optimized image below minimum edge: ${width}x${height} (min ${MIN_PROCESSED_EDGE}px)`,
    );
  }

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
  bypassSourceCache?: boolean;
  /**
   * Pre-persistence vision check for the single manual/crawled candidate:
   * runs on the freshly processed bytes BEFORE upload + image_cache record,
   * so a vision-rejected image never becomes a ready row. (A recorded manual
   * row outranks serper rows in getLatestReadyCachedImageByLookupKey and
   * would poison every later resolution for this fragrance.) Returns false to
   * reject → processCandidate returns null with nothing recorded (no negative
   * cache either: the verdict is fragrance-specific while the negative cache
   * is keyed per-source, and the same source may be the correct image for a
   * different fragrance). Never set for the serper candidate loop — serper
   * winners are gated at arbitration so only presumptive winners spend a
   * model call.
   */
  visionCheckBeforeRecord?: (image: {
    buffer: Buffer;
    contentHash: string;
    mimeType: string;
  }) => Promise<boolean>;
}): Promise<ProcessedImageResult | null> {
  // bypassSourceCache: skip the positive per-source cache (and the in-flight
  // join, which would otherwise hand back another caller's cached-path result)
  // so the source is genuinely re-downloaded and re-processed with the caller's
  // Poof options. The negative (failure) cache below still applies — a
  // deterministically bad source stays bad regardless of processing options.
  const bypassCache = input.bypassSourceCache === true;
  // Source-hash cache reads are scoped to this fragrance for Serper rows
  // (image-pipeline H1/H3): two fragrances whose Serper search returned the same
  // image URL share a source_url_hash but must not cross-serve each other's
  // bottle, and a negative-cache failure for one must not suppress the other.
  const cacheScope = { sourceProvider: input.sourceProvider, lookupKey: input.lookupKey };
  if (!bypassCache) {
    const cached = await getReadyCachedImageBySourceHash(
      input.source.sourceUrlHash,
      input.removeBackground,
      cacheScope,
    );
    if (cached) {
      // Serve when the cache satisfies the request: a bg-removed cutout, OR a
      // deterministic white-bg fallback for a source that can't be cut out.
      if (acceptsImageCacheForRequest(cached, input.removeBackground)) {
        return { ...cached, sourceProvider: input.sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION };
      }
    }
  }

  const status = await getCachedImageStatusBySourceHash(
    input.source.sourceUrlHash,
    input.removeBackground,
    cacheScope,
  );
  if (status === "failed") return null;

  const flightKey = inFlightKey(
    input.source.sourceUrlHash,
    input.removeBackground,
    input.sourceProvider,
    input.lookupKey,
  );
  if (!bypassCache) {
    const existing = inFlightBySource.get(flightKey);
    if (existing) return existing;
  }

  const promise = (async (): Promise<ProcessedImageResult | null> => {
    try {
      const doubleCheck = bypassCache
        ? null
        : await getReadyCachedImageBySourceHash(
            input.source.sourceUrlHash,
            input.removeBackground,
            cacheScope,
          );
      if (doubleCheck) {
        if (acceptsImageCacheForRequest(doubleCheck, input.removeBackground)) {
          return { ...doubleCheck, sourceProvider: input.sourceProvider, pipelineVersion: IMAGE_PIPELINE_VERSION };
        }
        // Cached entry lacks BG removal and isn't a deterministic fallback; reprocess.
      }

      const optimized = await processSourceToWebp(input.source, input.removeBackground, input.poofOptions);
      if (input.visionCheckBeforeRecord) {
        const approved = await input.visionCheckBeforeRecord({
          buffer: optimized.buffer,
          contentHash: optimized.contentHash,
          mimeType: optimized.mimeType,
        });
        if (!approved) {
          logger.info(
            {
              lookupKey: input.lookupKey,
              sourceProvider: input.sourceProvider,
              sourceUrlHash: input.source.sourceUrlHash,
            },
            "[imagePipeline] vision gate rejected manual/crawled candidate before persistence",
          );
          return null;
        }
      }
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
      if (!bypassCache) inFlightBySource.delete(flightKey);
    }
  })();

  // Bypass runs stay out of the in-flight map entirely: registering one would
  // hand a fresh-processing promise to unrelated cached-path callers, and its
  // finally-delete would evict a legitimate concurrent entry.
  if (!bypassCache) inFlightBySource.set(flightKey, promise);
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

  // Vision validation gate (audit Tier 3 #10 / Tier 1 #4). Opt-in per request;
  // fail-open inside imageVisionGate, so with no Gemini key or on any error
  // this always approves and behavior is unchanged.
  const visionGateActive = input.visionGate === true;
  const visionApproveByUrl = async (ref: {
    imageUrl: string;
    imageHash?: string | null;
  }): Promise<boolean> => {
    if (!visionGateActive) return true;
    const verdict = await verifyAutomaticImageWinnerByUrl({
      brand: input.brand,
      name: input.name,
      lookupKey,
      imageUrl: ref.imageUrl,
      imageHash: ref.imageHash ?? null,
    });
    return verdict !== "reject";
  };

  if (input.allowLookupCache !== false && !input.sourceUrl) {
    const cachedByLookup = await getLatestReadyCachedImageByLookupKey(lookupKey);
    if (cachedByLookup && acceptsImageCacheForRequest(cachedByLookup, removeBackground)) {
      // Gate cached returns too when the gate is on: an automatic run whose
      // winner was vision-rejected still recorded processed candidates as
      // ready rows, and without this check a later automatic resolution would
      // hand one straight back (verdict is memoized, so this is normally a
      // no-cost map lookup).
      if (await visionApproveByUrl(cachedByLookup)) {
        const result = { ...cachedByLookup, pipelineVersion: IMAGE_PIPELINE_VERSION };
        return attachTrace(result, makeTrace({ ...traceBase, final: result }));
      }
      logger.info(
        { lookupKey, imageHash: cachedByLookup.imageHash },
        "[imagePipeline] vision gate rejected lookup-cached image; continuing to search",
      );
    }
  }

  if (input.allowLookupCache !== false && !input.sourceUrl && searchQueryHash) {
    const cachedByQuery = await getLatestReadyCachedImageBySearchQueryHash(searchQueryHash, lookupKey);
    if (cachedByQuery && acceptsImageCacheForRequest(cachedByQuery, removeBackground)) {
      if (await visionApproveByUrl(cachedByQuery)) {
        const result = { ...cachedByQuery, pipelineVersion: IMAGE_PIPELINE_VERSION };
        return attachTrace(result, makeTrace({ ...traceBase, final: result }));
      }
      logger.info(
        { lookupKey, imageHash: cachedByQuery.imageHash },
        "[imagePipeline] vision gate rejected query-cached image; continuing to search",
      );
    }
  }

  const candidates: SerperImageCandidate[] = [];
  if (input.sourceUrl) {
    candidates.push({ imageUrl: input.sourceUrl, score: 0 });
  } else if (input.searchQuery?.trim()) {
    await pipelineLimiter.acquire();
    let serperCandidates: SerperImageCandidate[];
    try {
      serperCandidates = await searchSerperImageCandidates(input.searchQuery, input.serperRefine);
    } finally {
      pipelineLimiter.release();
    }
    candidates.push(...serperCandidates);
  }

  if (candidates.length === 0) return null;

  const maxCandidates = Math.max(1, Math.min(input.maxCandidates ?? MAX_CANDIDATES_PER_ATTEMPT, 8));
  const excludedSourceHashes = new Set(
    (input.excludeSourceUrlHashes ?? []).filter((hash) => typeof hash === "string" && hash.length > 0),
  );
  const candidateTraces: ImagePipelineCandidateTrace[] = [];
  // Successfully processed serper candidates. The presumptive winner is the
  // highest score (earliest ordinal on ties — same semantics as the previous
  // incremental `best` tracking); with the vision gate active, a rejected
  // winner is removed from this pool and the next-best takes its place.
  type ScoredEntry = {
    result: ProcessedImageResult;
    score: number;
    ordinal: number;
    trace: ImagePipelineCandidateTrace;
  };
  const scored: ScoredEntry[] = [];
  const bestScored = (): ScoredEntry | null => {
    let top: ScoredEntry | null = null;
    for (const entry of scored) {
      if (!top || entry.score > top.score) top = entry;
    }
    return top;
  };
  const markVisionRejected = (entry: ScoredEntry): void => {
    entry.trace.skipped = true;
    entry.trace.skipReason = "vision_rejected";
    const idx = scored.indexOf(entry);
    if (idx >= 0) scored.splice(idx, 1);
    logger.info(
      {
        lookupKey,
        fixtureId: input.fixtureId ?? null,
        traceId: input.traceId ?? null,
        ordinal: entry.ordinal,
        score: entry.score,
      },
      "[imagePipeline] vision gate rejected serper winner; trying next candidate",
    );
  };
  const winnerTrace = (winner: ScoredEntry): ImagePipelineTrace =>
    makeTrace({
      ...traceBase,
      candidates: candidateTraces,
      selectedOrdinal: winner.ordinal,
      selectedScore: winner.score,
      final: winner.result,
    });
  const loopStartedAt = Date.now();

  for (const [index, candidate] of candidates.slice(0, maxCandidates).entries()) {
    const ordinal = index + 1;
    // Wall-clock budget: stop STARTING new candidates once the loop has run long
    // enough. The first candidate (index 0) always runs so a single slow source
    // never short-circuits to "no image"; subsequent ones are skipped when the
    // budget is spent and the current `best` (if any) is returned below (image L2).
    if (index > 0 && Date.now() - loopStartedAt > CANDIDATE_LOOP_BUDGET_MS) {
      logger.warn(
        {
          lookupKey,
          fixtureId: input.fixtureId ?? null,
          traceId: input.traceId ?? null,
          elapsedMs: Date.now() - loopStartedAt,
          processedCandidates: ordinal - 1,
          haveBest: scored.length > 0,
        },
        "[imagePipeline] candidate loop budget exceeded; stopping before next candidate",
      );
      break;
    }
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

    // Manual-refresh exclusion: the candidate that produced the CURRENTLY
    // stored image cannot satisfy a "find me a different image" request — the
    // per-source cache would echo the identical WebP back and the refresh
    // would look like a no-op (image selection audit S2). Serper path only.
    if (sourceProvider === "serper" && excludedSourceHashes.has(source.sourceUrlHash)) {
      candidateTrace.skipped = true;
      candidateTrace.skipReason = "current_image";
      logger.info(
        {
          lookupKey,
          fixtureId: input.fixtureId ?? null,
          traceId: input.traceId ?? null,
          ordinal,
          sourceUrlHash: source.sourceUrlHash,
        },
        "[imagePipeline] skipped candidate matching the currently stored image",
      );
      continue;
    }

    // Manual/crawled path with the gate on: if this source's processed output
    // was already vision-rejected for this fragrance (memoized by source URL
    // hash), skip the download/Poof/sharp re-run entirely — the deferred
    // retry loop would otherwise re-process the same rejected fallback on
    // every attempt.
    if (sourceProvider !== "serper" && visionGateActive) {
      const remembered = peekVisionGateVerdict(
        visionGateCacheKey(lookupKey, source.sourceUrlHash),
      );
      if (remembered === "reject") {
        candidateTrace.skipped = true;
        candidateTrace.skipReason = "vision_rejected";
        logger.info(
          {
            lookupKey,
            fixtureId: input.fixtureId ?? null,
            traceId: input.traceId ?? null,
            ordinal,
            sourceUrlHash: source.sourceUrlHash,
          },
          "[imagePipeline] skipped manual candidate with remembered vision rejection",
        );
        continue;
      }
    }

    // Pre-persistence gate for the single manual/crawled candidate (see
    // processCandidate.visionCheckBeforeRecord). Serper candidates are gated
    // at winner arbitration instead so only presumptive winners spend a call.
    let candidateVisionRejected = false;
    const visionCheckBeforeRecord =
      sourceProvider !== "serper" && visionGateActive
        ? async (image: { buffer: Buffer; contentHash: string; mimeType: string }) => {
            const verdict = await verifyAutomaticImageWinnerBytes({
              brand: input.brand,
              name: input.name,
              lookupKey,
              buffer: image.buffer,
              mimeType: image.mimeType,
              contentHash: image.contentHash,
              sourceUrlHash: source.sourceUrlHash,
            });
            if (verdict === "reject") {
              candidateVisionRejected = true;
              return false;
            }
            return true;
          }
        : undefined;

    await pipelineLimiter.acquire();
    let result: ProcessedImageResult | null;
    try {
      result = await processCandidate({
        source,
        sourceProvider,
        lookupKey,
        searchQueryHash,
        userId: input.userId ?? null,
        fragranceId: input.fragranceId ?? null,
        removeBackground,
        poofOptions: input.poofOptions,
        bypassSourceCache: input.bypassSourceCache,
        visionCheckBeforeRecord,
      });
    } finally {
      pipelineLimiter.release();
    }
    if (!result) {
      candidateTrace.skipped = true;
      candidateTrace.skipReason = candidateVisionRejected ? "vision_rejected" : "processing_failed";
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
      // A freshly processed candidate already passed the pre-record bytes
      // gate above (its verdict is memoized by content hash, so this check is
      // free). This URL-based check exists for per-source CACHED rows, which
      // skip processing entirely — e.g. a row recorded before the gate
      // shipped.
      if (!(await visionApproveByUrl(result))) {
        candidateTrace.skipped = true;
        candidateTrace.skipReason = "vision_rejected";
        logger.info(
          {
            lookupKey,
            fixtureId: input.fixtureId ?? null,
            traceId: input.traceId ?? null,
            ordinal,
            sourceUrlHash: source.sourceUrlHash,
          },
          "[imagePipeline] vision gate rejected manual/crawled winner",
        );
        continue;
      }
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

    scored.push({ result, score: candidateScore, ordinal, trace: candidateTrace });

    if (
      candidateScore >= EARLY_ACCEPT_PROCESSED_SCORE &&
      scoreBreakdown.identityCoverage >= EARLY_ACCEPT_MIN_IDENTITY_COVERAGE
    ) {
      // The early-accept licence comes from THIS candidate; the returned
      // winner is the best-scored so far. With the vision gate active, gate
      // the presumptive winner and fall to the next-best on rejection. Once
      // the licence-granting candidate itself is vision-rejected the early
      // accept is void — resume the loop for the remaining candidates.
      for (;;) {
        const winner = bestScored();
        if (!winner) break;
        if (await visionApproveByUrl(winner.result)) {
          return attachTrace(winner.result, winnerTrace(winner));
        }
        markVisionRejected(winner);
        if (winner.ordinal === ordinal) break;
      }
    }
  }

  // Final winner arbitration: highest score first (earliest ordinal on ties,
  // matching the legacy `best` tracking); with the vision gate active a
  // rejected winner falls through to the next-best. With the gate off this
  // returns the top-scored candidate unchanged.
  const winner = await pickVisionApprovedWinner(
    scored.map((entry) => ({ value: entry, score: entry.score, ordinal: entry.ordinal })),
    (candidate) => visionApproveByUrl(candidate.value.result),
    (candidate) => markVisionRejected(candidate.value),
  );

  if (!winner) {
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

  return attachTrace(winner.value.result, winnerTrace(winner.value));
}
