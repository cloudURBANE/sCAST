# Runtime Navigation Index (2026-05-07)

This is a practical code-navigation index for future exploration passes. It focuses on runtime behavior, not historical recovery state.

## 1) Where To Start

If you need to understand request flow quickly, read in this order:

1. `artifacts/scent-cast/src/App.tsx` (frontend shell + auth/session + wardrobe lifecycle)
2. `artifacts/api-server/src/app.ts` (Express setup + route mounting)
3. `artifacts/api-server/src/routes/index.ts` (API composition)
4. `artifacts/api-server/src/routes/wardrobe.ts` (highest-impact CRUD/rebuild path)
5. `artifacts/api-server/src/routes/scent.ts` (search/profile/image-refresh pipeline)
6. `artifacts/api-server/src/services/imagePipeline.ts` (image processing + cache flow)
7. `lib/db/src/schema/index.ts` (authoritative runtime table exports)

## 2) Frontend To API Surface

| Frontend caller | Endpoint(s) | Backend owner |
|---|---|---|
| `App.tsx` | `GET /api/weather`, `GET/POST /api/wardrobe`, `PATCH/DELETE /api/wardrobe/:id`, `POST /api/wardrobe/rebuild`, `GET /api/share-settings` | `routes/scent.ts`, `routes/wardrobe.ts`, `routes/share.ts` |
| `components/AuthModal.tsx` | `GET /api/auth/google` | `routes/oauth.ts` |
| `components/FragranceCapture.tsx` | `POST /api/search-scent`, `POST /api/scent-profile` | `routes/scent.ts` |
| `components/Wardrobe.tsx` | `POST /api/refresh-image` | `routes/scent.ts` |
| `components/ShareModal.tsx` | `GET/POST /api/share-settings`, `PATCH /api/wardrobe/:id/visibility` | `routes/share.ts`, `routes/wardrobe.ts` |
| `components/SharePage.tsx` | `GET /api/share/:userRef`, `GET /api/fragrances/:id/buy-link` | `routes/share.ts`, `routes/fragrances.ts` |
| `components/BottleImage.tsx` + `lib/imageProxy.ts` | `GET /api/image-proxy` and `/api/image-objects/...` usage | `routes/imageProxy.ts`, `routes/imageObjects.ts` |

## 3) API Route Inventory

Mounted under `/api` unless noted:

- Auth: `POST /auth/login`, `GET /auth/google`, `GET /auth/google/callback`
- Wardrobe: `GET/POST /wardrobe`, `POST /wardrobe/rebuild`, `PATCH /wardrobe/:fragranceId/visibility`, `PATCH /wardrobe/:id`, `DELETE /wardrobe/:id`
- Share: `GET /share/:userRef`, `GET/POST /share-settings`
- Scent/weather/images: `GET /weather`, `POST /search-scent`, `POST /scent-profile`, `POST /refresh-image`
- Image serving/proxy: `GET /image-proxy`, `GET /image-objects/<storagePath>`
- Monetization: `GET /fragrances/:id/buy-link`
- Diagnostics: `GET /healthz`; `GET /_debug/wardrobe-audit` is mounted only outside production when `ENABLE_WARDROBE_AUDIT_DEBUG=true`
- Non-`/api` redirects: `GET /go/cj/:id`, `GET /go/affiliate/:id`

## 4) Runtime Data Model (Current)

Authoritative export list is `lib/db/src/schema/index.ts`:

- `users`
- `user_fragrances`
- `global_fragrances`
- `image_cache`
- `user_settings`
- `affiliate_links`

Notes:

- `image_cache` is now first-class in runtime image resolution, not just optional metadata.
- `affiliate_links` is live (buy-link lookup + redirect click counting).
- Legacy `conversations/messages` schema files exist but are not exported as active runtime tables.

## 5) Image Pipeline Path (Most Cross-Cutting Flow)

Main chain:

1. `/api/refresh-image` in `routes/scent.ts`
2. `resolveProcessedFragranceImage` in `services/imagePipeline.ts`
3. candidate sourcing from Serper (`serperService.ts`) or manual URL
4. optional BG removal (`bgService.ts`)
5. object write via `imageObjectStorage.ts` (firebase/supabase/local provider selection)
6. metadata write to `image_cache` via `imageCacheService.ts`
7. catalog upsert via `saveCatalogEntry` in `catalogService.ts`
8. hydration reads by wardrobe/share via `fragrancePayload.ts` + `imageHydration.ts`

## 6) Fast Triage By Symptom

- OAuth/login issues:
  - `routes/oauth.ts`, `routes/auth.ts`, `App.tsx` token parse/restore logic
- Wardrobe item missing or wrong:
  - `routes/wardrobe.ts` (UUID-vs-payload-id fallback), `services/fragrancePayload.ts`
- Wrong image on card/share:
  - `services/imageHydration.ts`, `services/catalogService.ts`, `services/imageReference.ts`
- Refresh-image failures:
  - `routes/scent.ts` refresh handler, then `services/imagePipeline.ts`, `services/safeImageFetch.ts`
- Buy button dead:
  - `routes/fragrances.ts`, `routes/cjRedirect.ts`, `affiliate_links` table

## 7) Drift Found vs Older Maps

The earlier index docs are still useful, but they understate newer runtime areas:

- `affiliate_links` table and affiliate redirect routes are active.
- `image_cache` is exported and used directly in hot paths.
- `/api/image-objects/...` is a real serving path for local object storage.

Use this file as the current runtime navigation baseline, then reconcile older maps incrementally.

