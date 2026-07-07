-- Bearer-token hardening (production-readiness C1/C2).
--
-- C1 — store a SHA-256 hash of users.token so the live credential is never at
--      rest in plaintext. Auth reads by token_hash first and falls back to the
--      plaintext token column for one release; a later operator step backfills
--      token_hash for existing rows and then drops the plaintext column.
-- C2 — track token lifetime so a leaked-and-forgotten credential expires.
--
-- All columns nullable / additive so drizzle-kit push and a live deploy that
-- hasn't backfilled yet keep working. NULL timestamps never expire until the
-- app stamps them on next login (routes/oauth.ts stampTokenSecurity).
alter table public.users
  add column if not exists token_hash text,
  add column if not exists token_issued_at timestamp without time zone,
  add column if not exists token_last_used_at timestamp without time zone;

-- Auth's hot per-request lookup is now by token_hash.
create index if not exists users_token_hash_idx on public.users (token_hash);
