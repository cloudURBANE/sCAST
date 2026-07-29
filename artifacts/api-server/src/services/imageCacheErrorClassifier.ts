// Pure decision helpers for image_cache persistence errors.
//
// Kept dependency-free (no imports) so it can be unit-tested in isolation by the
// node:test runner, which does not bundle and cannot follow the extensionless
// relative imports used throughout imageCacheService.ts (e.g. ../lib/logger).
//
// imageCacheService wraps these with one-time logging side effects.

function errorChain(err: unknown): Array<{ code?: unknown; message?: unknown; cause?: unknown }> {
  const chain: Array<{ code?: unknown; message?: unknown; cause?: unknown }> = [];
  const seen = new Set<unknown>();
  let current = err;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    chain.push(value);
    current = value.cause;
  }
  return chain;
}

function hasCode(err: unknown, code: string): boolean {
  return errorChain(err).some((value) => value.code === code);
}

function hasMessage(err: unknown, pattern: RegExp): boolean {
  return errorChain(err).some(
    (value) => typeof value.message === "string" && pattern.test(value.message),
  );
}

/**
 * True when the `image_cache` relation does not exist (Postgres 42P01). Caching
 * is impossible; callers degrade to serving the freshly-uploaded object.
 */
export function isImageCacheRelationMissing(err: unknown): boolean {
  return (
    hasCode(err, "42P01") ||
    hasMessage(err, /relation ["']?image_cache["']? does not exist/i)
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
    hasCode(err, "42P10") ||
    hasMessage(
      err,
      /no unique or exclusion constraint matching the on conflict specification/i,
    )
  );
}
