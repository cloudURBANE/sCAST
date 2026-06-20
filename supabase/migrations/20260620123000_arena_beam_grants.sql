-- Arena Beam Power grants from the Scent Beam game.
-- Additive and idempotent; old crowd-read tables remain for dormant history.

create table if not exists public.arena_beam_grants (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id),
  user_id       uuid not null references public.users(id) on delete cascade,
  post_id       uuid not null references public.community_posts(id) on delete cascade,
  fragrance_id  text not null,
  run_id        text not null,
  beam_power    integer not null check (beam_power > 0),
  game_score    integer not null check (game_score >= 0),
  created_at    timestamptz not null default now()
);

create index if not exists arena_beam_grants_tenant_fragrance_idx
  on public.arena_beam_grants (tenant_id, fragrance_id);
create index if not exists arena_beam_grants_tenant_post_idx
  on public.arena_beam_grants (tenant_id, post_id);
create index if not exists arena_beam_grants_user_idx
  on public.arena_beam_grants (user_id);
create unique index if not exists arena_beam_grants_user_post_run_unique_idx
  on public.arena_beam_grants (user_id, post_id, run_id);
