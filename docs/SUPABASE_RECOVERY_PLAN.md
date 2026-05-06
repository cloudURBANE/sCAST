# Supabase/Postgres Recovery Plan

## Goal

Restore the app to old database continuity as if the reset/replacement did not happen. The safest path is:

1. Restore the old backup into a clean staging Supabase/Postgres target.
2. Validate app tables, row counts, auth token continuity, and API flows.
3. Cut Railway `DATABASE_URL` over to the restored DB.
4. Keep Vercel pointed to Railway through `BACKEND_ORIGIN`.

## Current Runtime DB Usage

Current runtime code uses Drizzle/Postgres through `DATABASE_URL`, not Supabase client APIs.

High-confidence app tables:

- `public.users`
- `public.user_fragrances`
- `public.user_settings`
- `public.global_fragrances`

Low-confidence legacy scaffold:

- `public.conversations`
- `public.messages`

No current runtime evidence for:

- Supabase Auth login/session APIs
- Supabase Storage bucket APIs
- Supabase RPC calls
- PostgREST `.from(...)` calls from frontend

## Backup Comparison

Backup folder: `supabase-clean-backup-20260506-115506`

| Object | Backup Rows | Current Code Needs? | Notes |
|---|---:|---|---|
| `public.users` | 4 | Yes | Preserve exactly for old tokens and OAuth links. |
| `public.user_fragrances` | 23 | Yes | Owns user wardrobe data through `user_id`. |
| `public.user_settings` | 4 | Yes | One row per old user. |
| `public.global_fragrances` | 36 | Yes | Shared catalog/profile/image cache in Postgres. |
| `public.conversations` | 0 | No current runtime | Present in schema files but not exported. |
| `public.messages` | 0 | No current runtime | Present in schema files but not exported. |
| `auth.users` | 0 | No current runtime | Confirms current app was not relying on Supabase Auth users in this dump. |
| `storage.objects` | 0 | No current runtime | No Supabase Storage objects in backup. |

The backup also contains Supabase system schemas (`auth`, `storage`, `realtime`, `vault`, `graphql`, `extensions`) and migration history. For app continuity, the critical payload is the public app tables.

## Missing Or Risky Items To Check

| Item | Risk | Recovery Action |
|---|---|---|
| Wrong `DATABASE_URL` | Railway points at reset/new DB | Point staging Railway/local API to restored DB and validate before production cutover. |
| Missing `public.users` | Login creates new user/token, old wardrobe appears gone | Restore old `public.users` rows from backup. |
| User ID mismatch | Wardrobe rows cannot attach to recreated users | Restore users and wardrobe together; do not recreate users by email only. |
| Missing OAuth columns | Google callback fallback may work but link updates fail | Ensure `oauth_provider` and `oauth_subject` exist. |
| Public table RLS enabled | Backend direct DB role may be blocked depending on role | Backup migration history includes public app table RLS disable intent; use `RECOVERY_RLS.sql` if needed. |
| Missing constraints/FKs | Data drift and orphaned rows | Restore constraints from dump or apply compatibility schema. |
| Missing `global_fragrances` | Search/image hydration slower or wrong | Restore old catalog rows. |
| Missing Firestore `bg_cache` | Images may regenerate; login unaffected | Treat as cache; clear only bad documents if needed. |
| Wrong Google callback URL | OAuth fails before DB | Verify Google Console redirect URI matches public `/api/auth/google/callback`. |
| Vercel `BACKEND_ORIGIN` wrong | Frontend cannot reach Railway API | Verify `/api/healthz` through Vercel. |

## Restore Strategy

### Primary 1:1 Path

Use the custom dump as the source artifact:

`supabase-clean-backup-20260506-115506/full_database_clean.custom.dump`

Recommended:

1. Create a new disposable/staging Supabase project or clean staging Postgres target.
2. Restore the backup there using Supabase-supported full restore tooling when available.
3. If manually restoring to a Supabase-managed project, do not overwrite managed system schemas unless using an official full restore process. For app continuity, restore public app schema/data first.
4. Validate row counts:
   - `public.users = 4`
   - `public.user_fragrances = 23`
   - `public.user_settings = 4`
   - `public.global_fragrances = 36`
5. Run API locally or on staging Railway with `DATABASE_URL` pointed to restored DB.
6. Test Google OAuth and old bearer token session restore.
7. Cut production Railway `DATABASE_URL` to restored DB only after validation.

### Compatibility SQL Path

The files in `supabase/recovery` are non-destructive helpers:

- `RECOVERY_SCHEMA.sql`: creates/adds required public app schema if missing.
- `RECOVERY_RLS.sql`: disables RLS on app-owned public tables only if backend DB role is blocked.
- `RECOVERY_SEED.sql`: inserts missing `user_settings` rows for restored users.

These scripts do not import old row data. They are not a substitute for the backup dump.

## Final Diagnostic Summary

## Most Likely Reason Login Still Fails After Code Revert

Reverting code cannot restore external database state. In this codebase, login depends on `public.users` and `DATABASE_URL`, not on frontend code alone. If the Supabase/Postgres project was reset or Railway now points to a different project, old browser tokens and Google OAuth users no longer map to the old `public.users.id`/`token` rows. The backup shows the old app data lives in public tables and `auth.users` is empty, so Supabase Auth user deletion is less likely for this current runtime than missing/restored public app rows or wrong env.

Other plausible causes:

- Supabase project/ref changed.
- Railway `DATABASE_URL` points to the new/reset DB.
- Vercel `BACKEND_ORIGIN` points to the wrong Railway service.
- Google OAuth redirect URI no longer matches the deployed `/api/auth/google/callback`.
- Required public tables or columns are missing.
- RLS is enabled on app-owned public tables with no compatible policy for the backend role.
- `public.users` rows were recreated by email, producing new IDs/tokens that do not own old wardrobe rows.
- Required `user_settings` rows are missing, causing share settings flow issues.
- Firebase `bg_cache` has stale image data, but this affects images, not login itself.

## Safe Fix Order

1. Verify Vercel env vars, especially `BACKEND_ORIGIN`.
2. Verify Railway env vars, especially `DATABASE_URL`, Google OAuth vars, and Firebase vars.
3. Verify Supabase URL/project ID or Postgres host matches the intended restored/staging DB.
4. Verify Google OAuth providers and redirect URLs include the public app callback URL.
5. Verify required tables exist in restored DB.
6. Verify required constraints/FKs/indexes exist.
7. Verify public app table RLS is disabled or backend role can read/write.
8. Restore old backup into staging, not production first.
9. Apply compatibility schema only if staging lacks required public app objects.
10. Apply RLS helper only if backend is blocked by RLS.
11. Apply seed helper for missing `user_settings` only after users are restored.
12. Clear Firebase stale cache only for known-bad image documents.
13. Test login locally/staging with restored `DATABASE_URL`.
14. Test production login after Railway cutover.

## Human Verification Needed

Cannot be proven from code alone:

- The actual current Railway `DATABASE_URL`.
- Which Supabase project production currently uses.
- Whether the old backup was taken before or after the last known-good user activity.
- Whether Google Console redirect URIs match current Vercel/Railway domains.
- Whether any user created new rows after the reset that must be merged rather than discarded.
- Firebase project identity and whether old `bg_cache` documents still exist.
- Whether Supabase dashboard restore tools are available for the target project.
