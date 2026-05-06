# Scent Cast Supabase/Postgres Recovery

## Primary Goal

Restore app continuity from:

`supabase-clean-backup-20260506-115506/full_database_clean.custom.dump`

The current app uses `public.users.token` and direct Postgres access through Railway. It does not use Supabase Auth for current login. A true "never happened" outcome requires restoring old public app rows, especially `public.users` and `public.user_fragrances`.

## Backup Files

| File | Use |
|---|---|
| `supabase-clean-backup-20260506-115506/full_database_clean.custom.dump` | Preferred staging restore artifact. |
| `supabase-clean-backup-20260506-115506/full_database_clean.readable.sql` | Human inspection artifact. |
| `supabase-clean-backup-20260506-115351/full_database_clean.custom.dump` | Do not use; zero-byte failed attempt. |

## Expected App Row Counts

After restore, validate:

```sql
select 'public.users' as object, count(*) from public.users
union all select 'public.user_fragrances', count(*) from public.user_fragrances
union all select 'public.user_settings', count(*) from public.user_settings
union all select 'public.global_fragrances', count(*) from public.global_fragrances
union all select 'public.conversations', count(*) from public.conversations
union all select 'public.messages', count(*) from public.messages;
```

Expected:

- `public.users`: 4
- `public.user_fragrances`: 23
- `public.user_settings`: 4
- `public.global_fragrances`: 36
- `public.conversations`: 0
- `public.messages`: 0

## Recommended Staging Restore

1. Create a clean staging Supabase/Postgres target.
2. Take a backup of that staging target if it is not disposable.
3. Restore the old dump using Supabase-supported full restore tooling when possible.
4. If manually restoring into a Supabase-managed project, prefer restoring the public app schema/data. Do not overwrite managed `auth`, `storage`, or `realtime` system schemas unless using official full-project restore tooling.
5. Validate row counts and constraints.
6. Run the API against staging by setting local or staging Railway `DATABASE_URL` to the restored DB.
7. Test:
   - `GET /api/healthz`
   - `GET /api/auth/google`
   - Google callback creates/loads the existing `public.users` row
   - `GET /api/wardrobe` with an old bearer token returns old rows
   - `GET /api/share-settings`
8. Cut production Railway `DATABASE_URL` over only after staging works.

## Compatibility Helpers

These helper scripts are non-destructive and do not import old row data:

1. `RECOVERY_SCHEMA.sql`
2. `RECOVERY_RLS.sql`
3. `RECOVERY_SEED.sql`

Use them when a target DB has missing app schema or RLS blocks the direct backend DB role. They are not a replacement for the old dump.

## Important Cutover Checks

- Railway `DATABASE_URL` points to the restored DB.
- `DATABASE_SSL_REJECT_UNAUTHORIZED` is set appropriately for the Supabase pooler/direct URL.
- Vercel `BACKEND_ORIGIN` points to the correct Railway API.
- Google Console redirect URI matches the public app callback: `/api/auth/google/callback`.
- Firebase env points to the intended project if old image cache should be reused.

## Do Not

- Do not use the zero-byte `115351` dump.
- Do not recreate users manually by email if preserving old wardrobe ownership.
- Do not paste SQL row data or env secret values into docs/chat.
- Do not clear Firestore cache until Postgres login and wardrobe restoration are validated.

