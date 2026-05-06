# Scent Cast Agent Index

## Fast Context

This repo is a React/Vite PWA plus an Express API. The current runtime code does not use the Supabase JavaScript client or Supabase Auth. It uses:

- Frontend: `artifacts/scent-cast`
- Backend/API: `artifacts/api-server`
- Database: Postgres through Drizzle in `lib/db`
- Auth: custom Google OAuth callback that creates/loads rows in `public.users` and returns `users.token`
- Cache: Firebase Admin Firestore collection `bg_cache` for processed bottle images
- Backup for 1:1 recovery: `supabase-clean-backup-20260506-115506`

The old backup has these app rows:

| Object | Rows |
|---|---:|
| `public.users` | 4 |
| `public.user_fragrances` | 23 |
| `public.user_settings` | 4 |
| `public.global_fragrances` | 36 |
| `public.conversations` | 0 |
| `public.messages` | 0 |
| `auth.users` | 0 |
| `storage.objects` | 0 |

## Source Of Truth

1. Current runtime code is the source of truth for what the app needs.
2. `supabase-clean-backup-20260506-115506` is the source of truth for old app data continuity.
3. `initial setup ref files for recovery` is historical schema evidence. It matches current `lib/db` schema except the current DB client adds SSL handling.
4. `supabase/.temp` is linked-project metadata only, not schema truth.

## Critical Runtime Tables

| Table | Required For | Notes |
|---|---|---|
| `public.users` | Login, bearer token auth, share IDs | `email` and `token` are the login/session backbone. Preserve old rows exactly. |
| `public.user_fragrances` | Wardrobe/dashboard/share | `user_id` links to `public.users.id`; `fragrance_data` is JSONB and contains user vault data. |
| `public.user_settings` | Share settings | One row per user. Missing rows can be safely inserted. |
| `public.global_fragrances` | Search/image catalog | Shared cache in Postgres, separate from Firestore `bg_cache`. |

## Recovery Target

The user's desired end state is a staging-first clone from the old dump into a clean/new Supabase/Postgres target, then cut Railway over to the restored DB. This preserves:

- existing `public.users.id`
- existing `public.users.token`
- Google OAuth link columns
- wardrobe ownership through `user_fragrances.user_id`
- catalog rows and image data in `global_fragrances.profile_data`

## Start Here

Read in this order:

1. `docs/OAUTH_DB_RECOVERY_STATUS_2026-05-06.md`
2. `docs/SUPABASE_RECOVERY_PLAN.md`
3. `docs/DATABASE_USAGE_MAP.md`
4. `docs/AUTH_FLOW_MAP.md`
5. `docs/ENVIRONMENT_MAP.md`
6. `supabase/recovery/README.md`

Then validate the staging restore with row counts and API login before changing production environment variables.

## Current Active Blocker (2026-05-06)

The linked Supabase project has the expected restored public app rows, but the current app `DATABASE_URL` password failed authentication after the SSL handling bug was bypassed. Runtime DB code now strips SSL query params before applying explicit TLS config. Next step is to install the correct Supabase pooler/direct connection string in local/Railway env, then run one validation pass.
