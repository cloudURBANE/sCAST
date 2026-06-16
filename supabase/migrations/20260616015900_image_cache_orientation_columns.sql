-- Orientation Engine metadata (artifacts/api-server/src/services/orientationEngine.ts).
--
-- Adds six nullable columns to OUR OWN image_cache table so the server can record
-- the normalized 768x768 packshot geometry and a backfill can upgrade legacy rows
-- in place. All columns are nullable and added with IF NOT EXISTS, so this is:
--   * idempotent  - safe to run more than once,
--   * non-blocking - nullable ADD COLUMN takes no table rewrite / no long lock,
--   * reversible  - each column drops cleanly,
--   * scoped      - touches only image_cache; the shared DB's other tables are
--                   never referenced (mirrors the drizzle tablesFilter guard).
ALTER TABLE image_cache
  ADD COLUMN IF NOT EXISTS original_width      integer,
  ADD COLUMN IF NOT EXISTS original_height     integer,
  ADD COLUMN IF NOT EXISTS bounding_box        jsonb,
  ADD COLUMN IF NOT EXISTS aspect_ratio        double precision,
  ADD COLUMN IF NOT EXISTS orientation_version text,
  ADD COLUMN IF NOT EXISTS baseline_alignment  double precision;
