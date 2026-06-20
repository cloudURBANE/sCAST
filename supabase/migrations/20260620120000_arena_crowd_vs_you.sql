-- Arena "Crowd vs You" mode — additive schema (replaces the never-shipped
-- Scent Rush runner). Idempotent: safe to re-run. Apply with the shared runner:
--   corepack pnpm --filter @workspace/scripts exec tsx ./src/apply-sql-migration.ts \
--     supabase/migrations/20260620120000_arena_crowd_vs_you.sql
-- Do NOT use drizzle push for this (shared Supabase project).

-- One scored read per (user, battle). The own_pick is also written to
-- community_votes by the crowd-read endpoint, so this table only records the
-- prediction + reveal outcome and the post-read streak snapshot.
create table if not exists public.arena_crowd_predictions (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id),
  user_id               uuid not null references public.users(id) on delete cascade,
  post_id               uuid not null references public.community_posts(id) on delete cascade,
  predicted_choice      text not null,
  own_pick              text not null,
  leader_at_reveal      text,
  tally_total_at_reveal integer not null,
  was_correct           boolean not null,
  streak_after          integer not null,
  created_at            timestamptz not null default now()
);

create unique index if not exists arena_crowd_predictions_user_post_unique_idx
  on public.arena_crowd_predictions (user_id, post_id);
create index if not exists arena_crowd_predictions_post_idx
  on public.arena_crowd_predictions (post_id);
create index if not exists arena_crowd_predictions_user_idx
  on public.arena_crowd_predictions (user_id);

-- Denormalized hot-path streak/accuracy stats; one row per (tenant, user).
create table if not exists public.arena_crowd_stats (
  tenant_id      uuid not null references public.tenants(id),
  user_id        uuid not null references public.users(id) on delete cascade,
  current_streak integer not null default 0,
  best_streak    integer not null default 0,
  total_reads    integer not null default 0,
  correct_reads  integer not null default 0,
  last_played_on date,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
