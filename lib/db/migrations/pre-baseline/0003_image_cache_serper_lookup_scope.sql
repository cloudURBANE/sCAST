-- Migration: scope Serper-sourced image_cache rows by lookup_key (H1/H3 fix)
--
-- This repo applies schema via `drizzle-kit push` (no migration runner/journal);
-- the source of truth is lib/db/src/schema/*.ts. This file is the REVIEWED,
-- production-safe SQL an operator runs against the shared Supabase DB instead of
-- a blind full `push` (which would drag in unrelated schema drift — see the
-- db-single-change / db-schema-safety guidance).
--
-- What changes & why (image-pipeline H1/H3 — source-hash cache poisoning):
--   The cache key was (source_url_hash, pipeline_version, background_removed),
--   enforced by image_cache_source_pipeline_bg_unique_idx (migration 0001).
--   That key ignores WHICH fragrance a row belongs to. A Serper image search for
--   two DIFFERENT fragrances can return the SAME image URL, which hashes to the
--   same source_url_hash — so the two fragrances collapsed into ONE row. They
--   cross-served each other's bottle, and every upsert rebound the row's
--   lookup_key (last writer wins).
--
--   The fix SPLITS uniqueness by provider:
--     * SERPER rows add lookup_key to the key, so each fragrance keeps its own
--       row even when two searches return the same image URL.
--     * NON-SERPER rows (manual / reimagine / openai) keep PURE-BYTES dedup
--       (no lookup_key): a manually supplied or generated source URL is
--       fragrance-specific by construction and SHOULD coalesce across callers.
--   Two PARTIAL unique indexes (split on source_provider) implement this; each
--   upsert targets the matching index via ON CONFLICT ... WHERE (targetWhere).
--
-- Safety:
--   * The new SERPER key is WIDER than the old key (adds lookup_key), so it can
--     only RELAX uniqueness — no Serper row becomes a duplicate under it. BUT
--     because the OLD index coalesced cross-fragrance collisions, the table may
--     already contain a single Serper row that "belongs" to the last writer; that
--     row stays valid (it just keeps whichever lookup_key it last held). No data
--     loss; future requests for the other fragrance simply create their own row.
--   * The NON-SERPER partial index is IDENTICAL in column set to the old global
--     index, just restricted to source_provider <> 'serper'. Existing non-serper
--     rows are already unique on (source_url_hash, pipeline_version,
--     background_removed) — they were unique under the OLD global index, and
--     restricting the domain cannot introduce duplicates. So no dedup is needed
--     for the non-serper partition either.
--   * Therefore the de-duplication step below is a DEFENSIVE no-op in a healthy
--     DB: it only fires if the old index was ever absent (42P10 degraded mode,
--     when uncached duplicate rows could accumulate). It keeps the most-recently
--     used row per new key and deletes older twins so the unique indexes build.
--   * Create the new indexes BEFORE dropping the old one so a unique constraint
--     is present at all times. CONCURRENTLY avoids locking image_cache writes.
--   * IF NOT EXISTS / IF EXISTS make this idempotent and safe to re-run.
--   * Apply this BEFORE deploying the code that targets the new indexes (the
--     provider-split ON CONFLICT ... WHERE clauses error until they exist).
--
-- NOTE: CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block, but
--       the dedup DELETE below CAN. Run the dedup step first (optionally wrapped
--       in its own transaction), then run each CONCURRENTLY statement on its own
--       line (do NOT wrap the CONCURRENTLY statements in BEGIN/COMMIT).

-- 1) Defensive de-duplication (no-op in a healthy DB; see Safety note above).
--    SERPER partition: collapse duplicates that share the NEW key, keeping the
--    most-recently-used row.
DELETE FROM image_cache a
USING image_cache b
WHERE a.source_provider = 'serper'
  AND b.source_provider = 'serper'
  AND a.source_url_hash = b.source_url_hash
  AND a.pipeline_version = b.pipeline_version
  AND a.background_removed = b.background_removed
  AND a.lookup_key IS NOT DISTINCT FROM b.lookup_key
  AND (
    coalesce(b.last_used_at, b.created_at) > coalesce(a.last_used_at, a.created_at)
    OR (
      coalesce(b.last_used_at, b.created_at) = coalesce(a.last_used_at, a.created_at)
      AND b.id > a.id
    )
  );

--    NON-SERPER partition: collapse duplicates that share the pure-bytes key.
DELETE FROM image_cache a
USING image_cache b
WHERE a.source_provider <> 'serper'
  AND b.source_provider <> 'serper'
  AND a.source_url_hash = b.source_url_hash
  AND a.pipeline_version = b.pipeline_version
  AND a.background_removed = b.background_removed
  AND (
    coalesce(b.last_used_at, b.created_at) > coalesce(a.last_used_at, a.created_at)
    OR (
      coalesce(b.last_used_at, b.created_at) = coalesce(a.last_used_at, a.created_at)
      AND b.id > a.id
    )
  );

-- 2) Create the provider-split partial unique indexes BEFORE dropping the old one.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS image_cache_source_pipeline_bg_serper_unique_idx
  ON image_cache (source_url_hash, pipeline_version, background_removed, lookup_key)
  WHERE source_provider = 'serper';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS image_cache_source_pipeline_bg_nonserper_unique_idx
  ON image_cache (source_url_hash, pipeline_version, background_removed)
  WHERE source_provider <> 'serper';

-- 3) Drop the superseded global unique index from migration 0001.
DROP INDEX CONCURRENTLY IF EXISTS image_cache_source_pipeline_bg_unique_idx;
