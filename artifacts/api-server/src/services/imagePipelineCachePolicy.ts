// Pure decision helpers for the image pipeline cache layer.
// Kept dependency-free so they can be unit-tested in isolation by the
// node:test runner (which does not bundle and cannot follow the extensionless
// relative imports used throughout imagePipeline.ts).

export function acceptsImageCacheForRequest(
  cached: { backgroundRemoved: boolean; removeBgStatus?: string | null },
  removeBackground: boolean,
): boolean {
  if (!removeBackground) return true;
  if (cached.backgroundRemoved) return true;
  // A "fallback" row means background removal WAS attempted on this exact source
  // and the result was deterministically unusable (an empty/ghost cutout), so the
  // stored white-background image is the best obtainable for it. Accepting it for
  // a bg-removal request prevents re-running Serper + Poof + sharp + upload on
  // every single request for a source that can never be cut out — the cost leak
  // in image-pipeline audit finding C1. (A non-fallback white-bg row — one a
  // no-bg request produced — is still rejected, preserving variant isolation.)
  return cached.removeBgStatus === "fallback";
}

/**
 * Positive-cache variant isolation. When background removal is requested, only a
 * cache row whose background was actually removed satisfies the request — a
 * white-background row must NOT, because the caller explicitly asked for a
 * transparent packshot. When removal is not requested, either variant is
 * acceptable (a transparent image still renders fine on any surface).
 *
 * This mirrors the WHERE clause in `getReadyCachedImageBySourceHash`: it returns
 * true when the positive lookup must constrain to `background_removed = true`.
 */
export function positiveCacheRequiresBackgroundRemoved(removeBackground: boolean): boolean {
  return removeBackground === true;
}

/**
 * Negative-cache variant isolation. A persisted "failed" row is keyed on the
 * background-removal variant that was REQUESTED, so a deterministic failure for
 * one variant must only suppress retries for that SAME variant — never the
 * other. This guarantees a bg-removed failure can't black out a no-bg request
 * (or vice versa). Mirrors the equality filter in
 * `getCachedImageStatusBySourceHash` (`background_removed = removeBackground`).
 */
export function negativeCacheFailureSuppressesRequest(
  failedVariantBackgroundRemoved: boolean,
  requestedRemoveBackground: boolean,
): boolean {
  return failedVariantBackgroundRemoved === requestedRemoveBackground;
}

export function shouldUseImageLookupCaches(
  allowLookupCache: boolean | undefined,
  sourceUrl: string | undefined,
): boolean {
  return allowLookupCache !== false && !sourceUrl;
}

/**
 * Whether a Serper-path resolution may participate in the search-query-level
 * in-flight dedup map (`inFlightBySearchQuery`). That map collapses concurrent
 * requests purely by (lookupKey, searchQueryHash, removeBackground), so ANY
 * request carrying options that change what an acceptable result is must stay
 * out — both directions are wrong otherwise:
 *   - joining: a solver refresh with `bypassSourceCache` / custom Poof options /
 *     `excludeSourceUrlHashes` that joins a plain in-flight resolution gets the
 *     exact image (or processing) it was asked to escape — the "guaranteed
 *     no-op" class from image selection audit S2, reintroduced via a race;
 *   - registering: a plain caller joining the solver's promise would receive
 *     its specialized output and skip its own lookup-cache consult.
 * `allowLookupCache === false` marks every such refresh/recovery path, and the
 * cache-affecting knobs are checked explicitly for defense in depth.
 */
export function sharesSearchQueryInFlight(input: {
  allowLookupCache?: boolean;
  bypassSourceCache?: boolean;
  excludeSourceUrlHashes?: string[];
  poofOptions?: object | null;
}): boolean {
  if (input.allowLookupCache === false) return false;
  if (input.bypassSourceCache === true) return false;
  if ((input.excludeSourceUrlHashes?.length ?? 0) > 0) return false;
  if (input.poofOptions != null) return false;
  return true;
}

export function shouldRetryFailedImageStatus(
  status: "ready" | "failed" | "processing" | null,
  updatedAt: Date | null | undefined,
  retryAfterMs: number,
  nowMs = Date.now(),
): boolean {
  if (status !== "failed") return false;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return false;
  if (!updatedAt) return false;
  return nowMs - updatedAt.getTime() >= retryAfterMs;
}
