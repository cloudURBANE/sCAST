# Image Storage And Cache Plan

Date: 2026-05-06

## Target Flow

```txt
User action
  -> optional lookup_key cache check in public.image_cache
  -> Serper.dev candidate list when needed
  -> normalized source URL hash
  -> source-hash cache check
  -> safe image download with SSRF protection
  -> optional Poof background removal
  -> Sharp resize/compression to WebP
  -> object storage upload
  -> metadata-only image_cache upsert
  -> lightweight imageUrl/storagePath/imageHash response
```

## Storage Provider Selection

Runtime selection is implemented in:

- `artifacts/api-server/src/services/imageObjectStorage.ts`

Selection order:

1. Firebase Storage, when `FIREBASE_STORAGE_BUCKET` is set.
2. Supabase Storage, when `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_IMAGE_BUCKET` are set.
3. Explicit local object storage, only when `IMAGE_ALLOW_LOCAL_OBJECT_STORAGE=true` and `NODE_ENV` is not `production`.

Local storage is served from:

- `GET /api/image-objects/...`

Local storage is intentionally development-only. On Railway and similar hosts it may be ephemeral, so production must configure Firebase Storage or Supabase Storage before the image pipeline can persist object references.

## Database Shape

Migration:

- `supabase/migrations/20260506170000_image_cache_no_base64.sql`

Drizzle schema:

- `lib/db/src/schema/imageCache.ts`

The table stores metadata only:

- ownership/relation: `user_id`, `fragrance_id`, `lookup_key`
- source identity: `source_provider`, `source_url`, `source_url_hash`, `search_query_hash`
- processed identity: `pipeline_version`, `content_hash`, `storage_provider`, `storage_path`, `public_url`
- metadata: `mime_type`, `width`, `height`, `size_bytes`
- processing state: `background_removed`, `processing_status`, `failure_reason`
- cache telemetry: `hit_count`, `last_used_at`, timestamps

Indexes cover:

- `(source_url_hash, pipeline_version)` unique cache identity
- `lookup_key`
- `user_id`
- `source_url_hash`
- `content_hash`
- `search_query_hash`
- `processing_status`

## Cache Keys

Source URL identity:

- URL protocol and hostname are normalized
- hash fragments are removed
- query params are sorted
- common tracking params such as `utm_*`, `fbclid`, and `gclid` are removed
- SHA-256 becomes `source_url_hash`

Storage key format:

```txt
images/processed/{sourceProvider}/{lookupKeySlug}/{sourceUrlHash}-{pipelineVersion}.webp
```

Current pipeline version:

```txt
bg-v2-webp-768
```

This means:

- same source image plus same pipeline version reuses the object
- repeated identical search query can reuse the most recent ready image before a Serper call
- changed source image creates a new object
- changed pipeline version creates a new object without colliding with old output
- failed candidates are recorded and skipped on later attempts

## Image Optimization

Processing is implemented in:

- `artifacts/api-server/src/services/imagePipeline.ts`
- `artifacts/api-server/src/services/bgService.ts`

Output:

- WebP
- max dimension 768px
- quality 82
- object storage cache control: `public, max-age=31536000, immutable`

Remote download guardrails:

- only `http` and `https`
- rejects credentials in URL
- rejects localhost, `.local`, private IPv4, private IPv6, link-local, loopback, multicast
- validates DNS targets before every request
- follows redirects manually and validates each hop
- max download size 8 MB
- 10 second download timeout
- accepts only JPEG, PNG, WebP, and AVIF
- rejects SVG, HTML, unknown/binary unsafe responses

## Regeneration Controls

Refresh route controls are in:

- `artifacts/api-server/src/routes/scent.ts`

Implemented behavior:

- automatic refresh without a solver is capped server-side after 3 attempts
- all session attempts are capped at 10
- solver-guided refresh can inspect more Serper candidates
- source hash cache lookup happens before processing
- failed source URLs are recorded in `image_cache` and skipped
- in-flight processing is deduped by source hash
- refresh responses return lightweight metadata:

```json
{
  "imageUrl": "/api/image-objects/images/processed/...",
  "storagePath": "images/processed/...",
  "imageHash": "...",
  "cached": true
}
```

## Base64 Guardrails

Guard utilities:

- `artifacts/api-server/src/services/persistenceGuards.ts`

Applied at:

- `catalogService.saveCatalogEntry`
- wardrobe insert
- wardrobe rebuild update
- wardrobe visibility update
- wardrobe catalog-image sync update
- read/hydration paths before API responses

Migration cleanup:

- clears top-level `profile_data.imageUrl` data URLs
- clears top-level `fragrance_data.imageUrl` data URLs
- adds check constraints to block future top-level `data:image/%` values

## Rollback

Code rollback:

1. Revert the code changes in `artifacts/api-server/src/services`, `artifacts/api-server/src/routes`, and `lib/db/src/schema`.
2. Keep the migration cleanup if it has already removed base64 from JSONB.
3. If absolutely necessary, restore previous image behavior from git, but do not reintroduce base64 writes to production data.

Database rollback:

```sql
drop table if exists public.image_cache;
alter table public.global_fragrances drop constraint if exists global_fragrances_profile_data_no_data_image;
alter table public.user_fragrances drop constraint if exists user_fragrances_fragrance_data_no_data_image;
```

Object storage rollback:

- Processed images are under `images/processed/...`.
- They can be deleted by prefix if the feature is rolled back.
