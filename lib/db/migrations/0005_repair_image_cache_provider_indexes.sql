-- Repair databases provisioned during the pre-baseline push era. Runtime image
-- upserts now target provider-split partial indexes, but those databases may
-- still have only image_cache_source_pipeline_bg_unique_idx. PostgreSQL then
-- rejects every ON CONFLICT target with 42P10 after the image object has already
-- uploaded, which strands newly added fragrances without a persisted image.

-- Defensive de-duplication. The legacy global unique index makes these deletes
-- no-ops on the affected production shape, but they let this repair converge on
-- any database that spent time in the uncached 42P10 compatibility mode.
DELETE FROM public.image_cache a
USING public.image_cache b
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
--> statement-breakpoint
DELETE FROM public.image_cache a
USING public.image_cache b
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
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS image_cache_source_pipeline_bg_serper_unique_idx
  ON public.image_cache (source_url_hash, pipeline_version, background_removed, lookup_key)
  WHERE source_provider = 'serper';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS image_cache_source_pipeline_bg_nonserper_unique_idx
  ON public.image_cache (source_url_hash, pipeline_version, background_removed)
  WHERE source_provider <> 'serper';
--> statement-breakpoint
DROP INDEX IF EXISTS public.image_cache_source_pipeline_bg_unique_idx;
