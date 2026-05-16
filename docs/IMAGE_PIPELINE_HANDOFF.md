# Image Pipeline Handoff

- Current patch blocks stale local `/api/image-objects/...` URLs from counting as usable images and lets preview save persist the exact preview URL.
- `/api/refresh-image` now returns `imagePipelineTrace` and logs the same stable fields: lookup key, optional `fixtureId` / `traceId`, Serper ordinal, candidate score breakdown, selected candidate, and final remove-BG status/reason.
- `user_fragrances.fragrance_data.imageUrl` is authoritative when `usableImageUrlForResponse` accepts it. `fragrancePayload.hydrateImageUrl` does not silently replace usable row URLs from catalog/cache; it only fills missing or unusable values via `imageHydration.resolveSharedImageUrl`.
- `global_fragrances.profile_data.imageUrl` and `image_cache` are shared sources used by search/profile and hydrate fallback. To replace a stale-but-usable wardrobe URL, use explicit refresh + `PATCH /wardrobe/:id` or `POST /api/wardrobe/rebuild`; do not rely on wardrobe GET to migrate rows.
- Verify production object storage env before treating `/api/image-objects/...` as durable. Local object storage is intentionally dev/test-only.
