// Pure decision helpers for image_cache persistence errors.
//
// Kept dependency-free (no imports) so it can be unit-tested in isolation by the
// node:test runner, which does not bundle and cannot follow the extensionless
// relative imports used throughout imageCacheService.ts (e.g. ../lib/logger).
//
// imageCacheService wraps these with one-time logging side effects.

function readCode(err: unknown): string {
  const value = err as { code?: unknown } | null;
  return typeof value?.code === "string" ? value.code : "";
}

function readMessage(err: unknown): string {
  const value = err as { message?: unknown } | null;
  return typeof value?.message === "string" ? value.message : "";
}

/**
 * True when the `image_cache` relation does not exist (Postgres 42P01). Caching
 * is impossible; callers degrade to serving the freshly-uploaded object.
 */
export function isImageCacheRelationMissing(err: unknown): boolean {
  return (
    readCode(err) === "42P01" ||
    /relation ["']?image_cache["']? does not exist/i.test(readMessage(err))
  );
}

/**
 * True for the Postgres "no unique or exclusion constraint matching the ON
 * CONFLICT specification" error (SQLSTATE 42P10).
 *
 * recordImageReady/recordImageFailure upsert with `onConflictDoUpdate` targeting
 * the (source_url_hash, pipeline_version, background_removed) unique index. That
 * index ships only in migration 0001, which this repo applies MANUALLY (no
 * migration runner/journal). If a deploy ran the new code before an operator ran
 * the migration, the conflict target has no matching index and EVERY upsert
 * throws 42P10 — which, when only 42P01 was tolerated, propagated up and the
 * deferred image path swallowed it into a silent null (every fragrance rendered
 * "No image" despite upload + serving being fine). Treat it as a tolerable cache
 * failure: serve the uploaded object and warn loudly.
 */
export function isImageCacheConflictTargetMissing(err: unknown): boolean {
  return (
    readCode(err) === "42P10" ||
    /no unique or exclusion constraint matching the on conflict specification/i.test(
      readMessage(err),
    )
  );
}
