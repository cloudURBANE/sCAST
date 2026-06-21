// Pure decision helpers for the image pipeline cache layer.
// Kept dependency-free so they can be unit-tested in isolation by the
// node:test runner (which does not bundle and cannot follow the extensionless
// relative imports used throughout imagePipeline.ts).

export function acceptsImageCacheForRequest(
  cached: { backgroundRemoved: boolean },
  removeBackground: boolean,
): boolean {
  return !removeBackground || cached.backgroundRemoved;
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
