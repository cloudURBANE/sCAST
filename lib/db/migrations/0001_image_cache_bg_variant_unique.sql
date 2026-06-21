-- Migration: isolate image_cache rows by background-removal variant
--
-- This repo applies schema via `drizzle-kit push` (no migration runner/journal);
-- the source of truth is lib/db/src/schema/*.ts. This file is the REVIEWED,
-- production-safe SQL an operator runs against the shared Supabase DB instead of
-- a blind full `push` (which would drag in unrelated schema drift — see the
-- db-single-change / db-schema-safety guidance).
--
-- What changes & why:
--   The image_cache cache key was (source_url_hash, pipeline_version), enforced by
--   image_cache_source_pipeline_unique_idx. That ignored the background-removal
--   variant, so a bg-removed (transparent) result and a no-bg (white-background)
--   result for the SAME source URL + pipeline version shared one row. They could
--   clobber each other on upsert, and a negative-cache "failed" row for one
--   variant suppressed retries for the other. The new key adds background_removed.
--
-- Safety:
--   * Purely additive to the key. Widening a unique key (adding a column) can only
--     RELAX uniqueness, never create duplicates, so every existing row stays valid
--     and unique under the new index — no dedup needed.
--   * background_removed is already NOT NULL DEFAULT false, so there are no NULLs
--     to backfill; legacy rows keep their stored variant.
--   * Create the new index BEFORE dropping the old one so a unique constraint is
--     present at all times. CONCURRENTLY avoids locking image_cache writes.
--   * IF NOT EXISTS / IF EXISTS make this idempotent and safe to re-run.
--   * Apply this BEFORE deploying the code that targets the new index (the
--     ON CONFLICT clauses reference (source_url_hash, pipeline_version,
--     background_removed); they error until this index exists).
--
-- NOTE: CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block.
--       Run each statement on its own (do not wrap in BEGIN/COMMIT).

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS image_cache_source_pipeline_bg_unique_idx
  ON image_cache (source_url_hash, pipeline_version, background_removed);

DROP INDEX CONCURRENTLY IF EXISTS image_cache_source_pipeline_unique_idx;
