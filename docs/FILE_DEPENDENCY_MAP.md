# File Dependency Map

## Runtime Frontend

| File | Purpose | Key Imports/Exports | Connected Services | DB/Firebase Usage | Env Vars | Tables Touched | Login Required? | Image Required? | Risk |
|---|---|---|---|---|---|---|---|---|---|
| `artifacts/scent-cast/src/main.tsx` | React entrypoint | imports `App`, CSS | Browser DOM | None | None | None | No | No | Low |
| `artifacts/scent-cast/src/App.tsx` | Main app shell, session restore, weather, wardrobe, share modal | imports `FragranceCapture`, `Wardrobe`, `AuthModal`, `SharePage`, `ShareModal` | `/api/weather`, `/api/wardrobe`, `/api/share-settings` | Indirect API DB; no Firebase direct | None directly | `users`, `user_fragrances`, `user_settings` via API | Yes for persisted vault | Indirect | High |
| `artifacts/scent-cast/src/components/AuthModal.tsx` | Sign-in modal | exports `AuthModal` | Redirects to `/api/auth/google` | None directly | None | `users` via API callback | Yes | No | High |
| `artifacts/scent-cast/src/components/FragranceCapture.tsx` | Search/add fragrance UI | exports `FragranceCapture`, uses `BottleImage` | `/api/search-scent`, `/api/scent-profile` | Indirect API DB/catalog | None | `global_fragrances` via API; `user_fragrances` via `App` after add | Guest allowed, save needs login | Yes | Medium |
| `artifacts/scent-cast/src/components/Wardrobe.tsx` | Vault grid/detail, image refresh controls, delete UI | exports `Wardrobe`, `Fragrance` | `/api/refresh-image`; callbacks to App for DB persistence | Indirect API DB/Firebase; `sessionStorage` retry counts | None | `user_fragrances`, `global_fragrances` via API | Required for persisted rows | Yes | High |
| `artifacts/scent-cast/src/components/ShareModal.tsx` | Share URL/settings and per-item visibility | exports `ShareModal` | `/api/share-settings`, `/api/wardrobe/:id/visibility` | Indirect API DB | None | `users`, `user_settings`, `user_fragrances` via API | Yes | Displays images | High |
| `artifacts/scent-cast/src/components/SharePage.tsx` | Public shared vault page | exports `SharePage` | `/api/share/:userRef`; debug POSTs to localhost sink | Indirect API DB/Firebase | None | `users`, `user_settings`, `user_fragrances`, `global_fragrances` via API | No | Yes | Medium |
| `artifacts/scent-cast/src/components/BottleImage.tsx` | Image proxy/framing component | imports `proxiedImageUrl`, frame helpers | `/api/image-proxy` | None direct | None | None | No | Yes | Medium |
| `artifacts/scent-cast/src/lib/imageProxy.ts` | Builds proxied image URLs | exports `proxiedImageUrl` | `/api/image-proxy` | None | None | None | No | Yes | Low |
| `artifacts/scent-cast/src/lib/imageRefreshSolvers.ts` | Frontend solver IDs for image refresh | exports constants/types | `/api/refresh-image` body IDs | None | None | None | No | Yes | Medium |
| `artifacts/scent-cast/src/lib/wardrobeSearchSuggest.ts` | Search suggestions in vault UI | exports suggestion builder | None | None | None | None | No | No | Low |
| `artifacts/scent-cast/src/components/chat/ChatInterface.tsx` | Offline chat UI scaffold | exports `ChatInterface` | None | None | None | None | No | No | Low |
| `artifacts/scent-cast/src/components/ui/**` | UI primitive library | component exports | None | None | None | None | No | No | Low |

## Runtime Backend

| File | Purpose | Imports/Exports | Connected Services | DB/Firebase Usage | Env Vars | Tables Touched | Login Required? | Image Required? | Risk |
|---|---|---|---|---|---|---|---|---|---|
| `artifacts/api-server/src/index.ts` | Starts Express server | imports `env-bootstrap`, `app` | HTTP listener | None direct | `PORT` | None | No | No | High |
| `artifacts/api-server/src/env-bootstrap.ts` | Loads `.env`, then `ScentCast.env` locally | imports paths, `dotenv` | Local env loading | None | all local env files | None | No | No | Medium |
| `artifacts/api-server/src/app.ts` | Express app setup, `/api` router, static SPA serve | imports routes, logger, static path | API and SPA | None direct | None | None | No | No | High |
| `artifacts/api-server/src/routes/index.ts` | API router composition | imports all route modules | All `/api/*` routes | None direct | None | None | No | No | High |
| `artifacts/api-server/src/routes/auth.ts` | Legacy email login endpoint | imports `db`, `usersTable` | `POST /api/auth/login` | Drizzle Postgres | `DATABASE_URL` through db | `users` | Yes | No | High |
| `artifacts/api-server/src/routes/oauth.ts` | Google OAuth login/signup | imports `db`, `usersTable` | Google OAuth endpoints | Drizzle Postgres | `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_PUBLIC_URL`, `PUBLIC_APP_URL`, `FRONTEND_URL`, `REPLIT_*` | `users` | Yes | No | High |
| `artifacts/api-server/src/routes/wardrobe.ts` | Private vault CRUD/rebuild/image sync | imports `usersTable`, `userFragrancesTable`, scent/catalog/image services | `/wardrobe`, `/wardrobe/rebuild`, patch/delete routes | Drizzle Postgres; image hydration may call Firebase | `DATABASE_URL`, image/Firebase vars through services | `users`, `user_fragrances`, `global_fragrances` | Yes | Yes | High |
| `artifacts/api-server/src/routes/share.ts` | Public share page and share settings | imports `usersTable`, `userFragrancesTable`, `userSettingsTable` | `/share/:userRef`, `/share-settings` | Drizzle Postgres; hydration may call Firebase | `DATABASE_URL`, image/Firebase vars through services | `users`, `user_settings`, `user_fragrances` | Mixed | Yes | High |
| `artifacts/api-server/src/routes/scent.ts` | Weather/search/profile/refresh-image endpoints | imports weather, scent, catalog, image, bg services | `/weather`, `/search-scent`, `/scent-profile`, `/refresh-image` | Catalog Drizzle; Firebase cache through services | `WEATHER_API_KEY`, `SERPER_API_KEY`, `SERPER_IMAGE_API_URL`, `REMOVE_BG_API_KEY`, Firebase vars | `global_fragrances`; optionally `user_fragrances` through wardrobe save | No for search, yes for save | Yes | High |
| `artifacts/api-server/src/routes/imageProxy.ts` | Remote image fetch/trim proxy | imports axios, packshot trim | `/image-proxy` | None | None | None | No | Yes | Medium |
| `artifacts/api-server/src/routes/debug.ts` | Read-only wardrobe audit | imports db and catalog key helper | `/_debug/wardrobe-audit` | Drizzle Postgres | `DATABASE_URL` | `users`, `user_fragrances`, `global_fragrances` | Yes | Yes | Medium |
| `artifacts/api-server/src/services/catalogService.ts` | Global fragrance cache lookups/upserts | imports `db`, `globalFragrancesTable` | Used by scent/rebuild/hydration | Drizzle Postgres | `DATABASE_URL` | `global_fragrances` | No | Yes | High |
| `artifacts/api-server/src/services/firebaseCache.ts` | Firestore clean image cache | imports Firebase Admin dynamically | `bg_cache` collection | Firebase Admin only | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | None | No | Yes | High |
| `artifacts/api-server/src/services/imageHydration.ts` | Resolve images from catalog/Firestore | imports catalog/cache | Used by wardrobe/share | Drizzle plus Firestore | `DATABASE_URL`, Firebase vars | `global_fragrances` | No | Yes | High |
| `artifacts/api-server/src/services/scentEngine.ts` | Build scent profiles and save catalog | imports dataset/parser/vectorizer/image/bg/cache/catalog | Search/profile pipeline | Drizzle plus Firestore | `SERPER_API_KEY`, `REMOVE_BG_API_KEY`, Firebase vars | `global_fragrances` | No | Yes | High |
| `artifacts/api-server/src/services/bgService.ts` | Background removal and image normalization | axios, sharp | Poof API or local fallback | None | `REMOVE_BG_API_KEY` | None | No | Yes | Medium |
| `artifacts/api-server/src/services/serperService.ts` | Serper image search | axios | Serper API | None | `SERPER_API_KEY`, `SERPER_IMAGE_API_URL` | None | No | Yes | Medium |
| `artifacts/api-server/src/services/weatherService.ts` | Weather lookup/demo fallback | axios | OpenWeather | None | `WEATHER_API_KEY` | None | No | No | Low |
| `artifacts/api-server/src/services/datasetLoader.ts` | Loads local `fragrances.json` | imports JSON | Local dataset | None | None | None | No | No | Low |

## Database Package

| File | Purpose | Tables/Exports | Env Vars | Risk |
|---|---|---|---|---|
| `lib/db/src/index.ts` | Creates pg `Pool`, Drizzle db, exports schema | All exported schema | `DATABASE_URL`, `DATABASE_SSL_REJECT_UNAUTHORIZED` | High |
| `lib/db/src/schema/index.ts` | Current exported schema barrel | `users`, `user_fragrances`, `global_fragrances`, `user_settings` | None | High |
| `lib/db/src/schema/users.ts` | App users | `usersTable`, insert schema/types | None | High |
| `lib/db/src/schema/userFragrances.ts` | User wardrobe rows | `userFragrancesTable` | None | High |
| `lib/db/src/schema/userSettings.ts` | Share settings | `userSettingsTable` | None | High |
| `lib/db/src/schema/globalFragrances.ts` | Shared catalog | `globalFragrancesTable` | None | High |
| `lib/db/src/schema/conversations.ts` | Legacy chat scaffold | Not exported by schema index | None | Low |
| `lib/db/src/schema/messages.ts` | Legacy chat scaffold | Not exported by schema index | None | Low |

## Dead/Duplicate/Generated/Temp

- `lib/db/src/schema/conversations.ts` and `messages.ts`: schema files exist, but not exported or used by runtime. Backup has 0 rows.
- `artifacts/scent-cast/src/components/chat/ChatInterface.tsx`: UI exists but not imported by `App.tsx`.
- `lib/api-client-react/src/generated/**`, `lib/api-zod/src/generated/**`: generated health API support, not core runtime.
- `supabase/.temp/**`: linked Supabase metadata only.
- `initial setup ref files for recovery/**`: historical schema package, not imported.
- `supabase-clean-backup-20260506-115351/**`: failed zero-byte backup attempt.

