-- Migration: enforce one wardrobe row per (user, client fragrance id)  [WS-5]
--
-- This repo applies schema via `drizzle-kit push` (no migration runner/journal);
-- the source of truth is lib/db/src/schema/*.ts. This file is the REVIEWED,
-- production-safe SQL an operator runs against the shared Supabase DB instead of
-- a blind full `push` (which would drag in unrelated schema drift — see the
-- db-single-change / db-schema-safety guidance).
--
-- What changes & why:
--   user_fragrances had a NON-unique index on (user_id, (fragrance_data->>'id')).
--   Nothing at the DB level stopped the same fragrance being inserted twice for a
--   user (a UI-only guard plus a check-then-insert race left a window), so the
--   vault could show duplicates and the recommendation/ticker stats double-count.
--   The add route is now idempotent (POST /api/wardrobe re-reads + merges on a
--   unique violation instead of 500ing); this index is the DB backstop that makes
--   that guarantee real.
--
-- Safety:
--   * Step 1 DEDUPES existing rows BEFORE the unique index is built, otherwise the
--     CREATE UNIQUE INDEX would fail on pre-existing duplicates. It keeps the
--     earliest-created row per (user_id, fragrance_data->>'id') and deletes the
--     rest. Rows with a NULL/absent fragrance_data->>'id' are left untouched (a
--     unique index treats SQL NULLs as distinct, so they never conflict).
--   * Step 2 builds the new unique index CONCURRENTLY (no write lock) and only
--     then drops the old non-unique one, so a (user_id, client-id) lookup index is
--     present at all times.
--   * IF NOT EXISTS / IF EXISTS make this idempotent and safe to re-run.
--   * Apply this BEFORE (or together with) deploying the idempotent add route. The
--     route does not depend on the index existing — its unique-violation recovery
--     simply has nothing to catch until the index is in place — so ordering is not
--     load-bearing, but applying it first is cleanest.
--
-- NOTE: CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block.
--       Run each statement on its own (do not wrap in BEGIN/COMMIT). The DELETE in
--       step 1 is an ordinary statement and may be run on its own first.

-- 1. Collapse existing duplicates, keeping the earliest-created row per key.
DELETE FROM user_fragrances a
USING user_fragrances b
WHERE a.user_id = b.user_id
  AND (a.fragrance_data->>'id') IS NOT NULL
  AND (b.fragrance_data->>'id') IS NOT NULL
  AND (a.fragrance_data->>'id') = (b.fragrance_data->>'id')
  AND (
    a.created_at > b.created_at
    OR (a.created_at = b.created_at AND a.id > b.id)
  );

-- 2. Unique backstop, built before the old non-unique index is dropped.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS user_fragrances_user_client_id_unique_idx
  ON user_fragrances (user_id, (fragrance_data->>'id'));

DROP INDEX CONCURRENTLY IF EXISTS user_fragrances_user_client_id_idx;
