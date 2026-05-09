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

export function shouldUseImageLookupCaches(
  allowLookupCache: boolean | undefined,
  sourceUrl: string | undefined,
): boolean {
  return allowLookupCache !== false && !sourceUrl;
}
