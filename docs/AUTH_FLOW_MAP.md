# Auth Flow Map

## Current Auth Model

Current login is custom app auth:

1. Browser goes to `/api/auth/google`.
2. Express API redirects to Google OAuth.
3. Callback resolves Google email/sub.
4. API finds or creates a row in `public.users`.
5. API redirects to `/?oauth_token=<users.token>&oauth_email=<users.email>`.
6. Browser stores those values in localStorage.
7. API requests use `Authorization: Bearer <users.token>`.

Supabase Auth is not used by current runtime code. Backup `auth.users` has 0 rows.

## Flows

| Flow | Frontend Entry | Backend/API | DB Calls | Firebase Calls | Required Tables | Required RLS/DB Permissions | Seed/Default Data | Env Vars | Likely Breakpoints |
|---|---|---|---|---|---|---|---|---|---|
| Signup | `AuthModal.tsx` Google button | `GET /api/auth/google`, `GET /api/auth/google/callback` in `routes/oauth.ts` | Select by `oauth_provider/oauth_subject`, select by `email`, insert `public.users`, update OAuth link | None | `public.users` | Backend DB role must read/insert/update `public.users`; public table RLS should be disabled or compatible with backend role | None | `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_PUBLIC_URL` or forwarded host | Wrong Google callback URL, missing OAuth env, missing `users` table/columns, wrong DB URL |
| Login | Same as signup for Google OAuth | `routes/oauth.ts` | Same as signup | None | `public.users` | Same as signup | Existing rows required to preserve old token/session continuity | Same as signup | New DB without old `public.users` creates new user/token, making old wardrobe ownership appear gone |
| Admin wardrobe rebuild | `scripts/rebuild-user-wardrobe.ts` only | `POST /api/admin/wardrobe/rebuild` in `routes/admin.ts` | Select `users` by email; rebuild vault via `wardrobeRebuild` service | None | `public.users`, `public.user_fragrances` | Backend DB role | User must already exist (404 otherwise) | `ADMIN_SECRET` (header `x-admin-secret`) | Wrong secret → 401; unknown email → 404 |
| Logout | `App.tsx` sign out button | None | None | None | None | None | None | None | Local browser storage only; server rows remain |
| Session restore | `App.tsx` initial state | Later calls `/api/wardrobe` and `/api/share-settings` | Select `public.users` by bearer token | None | `public.users`, `public.user_fragrances`, `public.user_settings` | Backend DB role can read all three | Old `users.token` must exist for old localStorage sessions | `DATABASE_URL` | Old browser token points to missing user row in reset DB |
| User profile loading | `App.tsx` calls `/api/share-settings` | `routes/share.ts` | Select `users` by token; select/insert `user_settings` | None | `public.users`, `public.user_settings` | Read `users`, read/insert/upsert `user_settings` | Missing `user_settings` can be auto-created | `DATABASE_URL` | FK failures if users missing; insert blocked by RLS/permissions |
| Dashboard/app boot | `App.tsx`, `FragranceCapture`, `Wardrobe` | `/api/weather`, `/api/wardrobe`, `/api/share-settings` | Select `user_fragrances` by `user_id`; select/insert settings | Image hydration may read Firestore | `public.users`, `public.user_fragrances`, `public.user_settings` | Read app tables | Restored old rows required for continuity | `DATABASE_URL`, optional weather/Firebase env | `user_fragrances.user_id` does not match recreated user ID |
| Image generation/refresh | `FragranceCapture.tsx`, `Wardrobe.tsx` | `routes/scent.ts`, `services/scentEngine.ts`, `catalogService.ts`, `bgService.ts` | Read/upsert `global_fragrances`; patch `user_fragrances` when saved to vault | Read/write `bg_cache` | `public.global_fragrances`, optionally `public.user_fragrances` | Read/write catalog; update owned vault row through backend role | None | `SERPER_API_KEY`, `SERPER_IMAGE_API_URL`, `REMOVE_BG_API_KEY`, Firebase vars | Missing API keys disables search/removal; missing catalog table slows/fails image flow |
| Fragrance/wardrobe/item data | `FragranceCapture`, `Wardrobe`, `ShareModal`, `SharePage` | `routes/wardrobe.ts`, `routes/share.ts` | Insert/select/update/delete `user_fragrances`; select `users`; select/upsert settings | Image hydration may read `bg_cache` | `public.users`, `public.user_fragrances`, `public.user_settings`, `public.global_fragrances` | Backend role can CRUD app tables | Old public rows from dump | `DATABASE_URL`, Firebase vars | Old JSONB rows missing flat `name/brand`; app has rebuild route to normalize |
| Firebase cache read/write | No direct frontend Firebase | `firebaseCache.ts` via `scentEngine` and `imageHydration` | None | `bg_cache` doc get/set | None in Postgres | Firebase service account permissions | None | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Bad private key formatting, stale cache image for same key, cache disabled if env missing |
| Supabase/Postgres read/write | Frontend calls same-origin `/api/*` | Express routes/services, Drizzle client in `lib/db` | Direct SQL through `DATABASE_URL` | Separate Firebase cache | Public app tables | Direct DB role permissions; no Supabase JWT RLS path | Restored old public table data | `DATABASE_URL`, `DATABASE_SSL_REJECT_UNAUTHORIZED` | Railway points to wrong/new project, SSL errors, RLS accidentally enabled for app tables |

## Existing Data Continuity Rule

For "like this never happened", preserve old `public.users` rows exactly. Recreating users by email is not enough because `user_fragrances.user_id` and stored browser tokens depend on the old `id` and `token`.

