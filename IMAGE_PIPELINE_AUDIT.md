# Image Pipeline Audit

Date: 2026-05-06

## Executive Diagnosis

The database bloat came from storing processed bottle images as base64 data URLs in JSONB columns.

The main path was:

1. `artifacts/api-server/src/services/serperService.ts` fetched Serper.dev image candidates.
2. `artifacts/api-server/src/services/bgService.ts` downloaded the selected image and converted processed PNG output to a `data:image/png;base64,...` string.
3. `artifacts/api-server/src/services/firebaseCache.ts` stored that base64 string in Firestore `bg_cache.cleanImage`.
4. `artifacts/api-server/src/services/scentEngine.ts` assigned that string to `profile.imageUrl`.
5. `artifacts/api-server/src/services/catalogService.ts` persisted the whole profile into `public.global_fragrances.profile_data`.
6. Refresh and sync flows could copy the same image string into `public.user_fragrances.fragrance_data.imageUrl`.

Postgres was therefore acting as an image CDN through JSONB, especially in:

- `public.global_fragrances.profile_data.imageUrl`
- `public.user_fragrances.fragrance_data.imageUrl`

The clean backup currently in `supabase-clean-backup-20260506-115506/full_database_clean.readable.sql` no longer contains `data:image` or `base64` matches, which is consistent with the recent manual cleanup.

## Image Entry Points

Images enter the system through:

- `/api/search-scent` and `/api/scent-profile`, via `buildProfile`.
- `/api/refresh-image`, via Serper search or user-provided preview image.
- `/api/wardrobe/rebuild`, via `buildProfile` for legacy rows.
- `/api/wardrobe/:id`, via catalog image sync.
- `/api/share/:userRef`, previously through fallback Serper search on missing images.
- `/api/image-proxy`, for frontend display of remote bottle images.

## Serper.dev Usage

Serper.dev is implemented in:

- `artifacts/api-server/src/services/serperService.ts`
- `artifacts/api-server/src/services/imageService.ts` as a thin wrapper
- `artifacts/api-server/src/routes/scent.ts` for refresh
- Previously `artifacts/api-server/src/routes/share.ts` for missing share-page images

The share route no longer calls Serper. Normal image generation now goes through `imagePipeline.ts`, which checks cache metadata before Serper calls.

## Base64 Creation And Persistence

Before this patch, `bgService.removeBg` returned data URLs using:

- `data:image/png;base64,...`
- `Buffer.from(..., "base64")` for data URI inputs

The persistence happened through:

- `saveCatalogEntry(...)` writing `profileData` to `global_fragrances`
- wardrobe insert/update routes writing `fragranceData` to `user_fragrances`
- refresh route calling `upsertRefreshImageCatalog(...)`

After this patch:

- normal production routes no longer call a base64-returning background-removal function
- `bgService` exposes buffer output through `removeBgToBuffer` and `removeBgBuffer`
- `catalogService.saveCatalogEntry` rejects base64 image data
- wardrobe write paths sanitize and assert against base64 image data
- read/hydration paths strip legacy data URLs before returning API payloads

## Tables And Columns

Runtime tables found:

- `public.users`: login/session source through `users.token`
- `public.user_fragrances`: user wardrobe rows, JSONB `fragrance_data`
- `public.global_fragrances`: shared catalog/cache rows, JSONB `profile_data`
- `public.user_settings`: share settings

New metadata table:

- `public.image_cache`: metadata-only processed image cache

No current runtime code used Supabase Auth or Supabase Storage before this patch. The backup reported `storage.objects = 0`.

## Firebase Status

Firebase was active only as Firestore cache code:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- collection `bg_cache`

It was not using Firebase Storage before this patch. The old Firestore cache shape stored base64 in `cleanImage`.

After this patch:

- Firestore `bg_cache` is legacy and no longer on the main image path.
- If `FIREBASE_STORAGE_BUCKET` is configured, Firebase Storage is preferred for processed image objects.
- Firestore helper code now ignores base64 payloads and only accepts lightweight URL references if it is ever called again.

## Frontend Expectations

The frontend expects `imageUrl` strings. It can display:

- remote `http(s)` URLs through `/api/image-proxy`
- same-origin paths such as `/api/image-objects/...`
- previous data URLs, although normal API responses should no longer return them

`BottleImage` already passes non-http same-origin paths through without proxying, so local object URLs continue to display.

## Cost And Loop Risks Found

Found risks before the patch:

- Firestore cache key was fragrance identity only, not source URL or pipeline version.
- `global_fragrances.profile_data` could store huge processed data URLs.
- `/api/refresh-image` could repeatedly call Serper and Poof background removal.
- failed image candidates were not persisted, so bad URLs could be retried later.
- `/api/share/:userRef` could call Serper repeatedly for missing images.
- `/api/image-proxy` allowed arbitrary http(s) targets without DNS/private-IP SSRF protection.

Mitigations are implemented in `imagePipeline.ts`, `safeImageFetch.ts`, `imageCacheService.ts`, and route updates.
