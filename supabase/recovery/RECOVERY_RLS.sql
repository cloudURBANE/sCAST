-- Scent Cast recovery RLS helper
--
-- Current runtime uses a backend Postgres connection through Drizzle and
-- custom bearer tokens stored in public.users.token. It does not use Supabase
-- Auth JWTs or PostgREST policies.
--
-- The old dump's migration history includes an explicit intent to disable RLS
-- on app-owned public tables. Apply this only if staging validation shows the
-- Railway/API database role is blocked by RLS on public app tables.

alter table if exists public.users disable row level security;
alter table if exists public.user_fragrances disable row level security;
alter table if exists public.global_fragrances disable row level security;
alter table if exists public.user_settings disable row level security;

-- Legacy scaffold tables. Not used by current runtime, but included in the
-- old dump migration history.
alter table if exists public.conversations disable row level security;
alter table if exists public.messages disable row level security;

-- Do not disable RLS on Supabase-managed auth.*, storage.*, or realtime.*
-- schemas here. Those are managed by Supabase services.

