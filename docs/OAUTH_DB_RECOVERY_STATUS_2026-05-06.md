# OAuth + DB Recovery Status - 2026-05-06

## Short Diagnosis

The restored Supabase/Postgres data is present, but the app cannot use it until the runtime `DATABASE_URL` authenticates successfully.

Two issues were found:

1. `node-postgres` was letting `sslmode=require` from `DATABASE_URL` override the app's intended `DATABASE_SSL_REJECT_UNAUTHORIZED=false` behavior. This produced `SELF_SIGNED_CERT_IN_CHAIN`.
2. After forcing the intended relaxed TLS behavior, the current `DATABASE_URL` failed with `28P01 password authentication failed`. The Supabase CLI could initially query the linked project, so the remote DB exists; the app credential/password is the blocker.

Repeated failed password attempts then triggered Supabase pooler `ECIRCUITBREAKER`, temporarily blocking new connections. Stop retrying until the correct DB password/URL is installed.

## Verified Remote Data

Using `npx supabase db query ... --linked` before the pooler circuit breaker, the linked project had the expected restored row counts:

| Table | Count |
|---|---:|
| `public.users` | 4 |
| `public.user_fragrances` | 23 |
| `public.user_settings` | 4 |
| `public.global_fragrances` | 36 |
| `public.conversations` | 0 |
| `public.messages` | 0 |

Integrity checks returned clean:

- `users_missing_token = 0`
- `users_duplicate_email_groups = 0`
- `users_duplicate_oauth_groups = 0`
- `orphan_user_fragrances = 0`
- `orphan_user_settings = 0`
- `user_fragrances_missing_name_brand = 0`
- `global_fragrances_missing_lookup_key = 0`
- `global_fragrances_duplicate_lookup_key_groups = 0`

RLS was disabled on the six public app tables checked.

## Code Changes Made

Changed `lib/db/src/index.ts` so the runtime pool strips Postgres SSL query params when an explicit SSL config is resolved. This prevents `pg` connection-string parsing from overriding `rejectUnauthorized: false`.

Changed `lib/db/drizzle.config.ts` so Drizzle Kit uses parsed DB credentials plus `ssl: "require"` instead of passing a raw URL that can hit the same SSL parsing problem.

## Remaining Required External Fix

Update the app runtime DB secret with the current Supabase connection string/password:

- local: `ScentCast.env` if testing locally
- Railway: `DATABASE_URL`
- keep or set `DATABASE_SSL_REJECT_UNAUTHORIZED=false` for the Supabase pooler if using its default TLS chain

Do not keep retrying the old password. If Supabase returns `ECIRCUITBREAKER`, wait for the temporary block to clear or set `SUPABASE_DB_PASSWORD` for CLI commands if needed.

## Safe Validation After Secret Fix

1. Verify app DB connection once:

```powershell
cd E:\ScentCast\Scent-Cast-Explore
npx supabase db query "select count(*) from public.users;" --linked
```

2. Run local type/test checks:

```powershell
corepack pnpm run typecheck:libs
corepack pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck
corepack pnpm --filter @workspace/api-server run test
```

3. Start API locally with a `PORT` and corrected DB env:

```powershell
$env:PORT="5000"
corepack pnpm --filter @workspace/api-server run build
corepack pnpm --filter @workspace/api-server run start
```

4. Test API:

```powershell
Invoke-WebRequest http://127.0.0.1:5000/api/healthz
Invoke-WebRequest http://127.0.0.1:5000/api/auth/google -MaximumRedirection 0
```

5. Test through deployment:

- Vercel `/api/healthz` proxies to Railway.
- Google Console redirect URI matches the public app origin plus `/api/auth/google/callback`.
- OAuth callback returns to the app with an old or linked `public.users.token`.
- `/api/wardrobe` with that token returns restored wardrobe rows.

## Quick Mental Model

OAuth is not blocked by Supabase Auth rows. This app uses Google OAuth only to resolve an email/sub and then reads or writes `public.users`. The old `public.users.id` and `public.users.token` values are the continuity anchor for old browser sessions and wardrobe ownership.
