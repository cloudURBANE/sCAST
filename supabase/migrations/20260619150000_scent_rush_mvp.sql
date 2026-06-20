create table if not exists public.scent_rush_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.users(id) on delete cascade,
  fragrance_id text not null,
  level integer not null check (level between 1 and 3),
  seed integer not null,
  manifest_version integer not null,
  manifest jsonb not null,
  event_plan jsonb not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  event_digest text,
  result jsonb,
  created_at timestamptz not null default now()
);

create index if not exists scent_rush_runs_user_created_idx
  on public.scent_rush_runs (tenant_id, user_id, created_at);
create index if not exists scent_rush_runs_expiry_idx
  on public.scent_rush_runs (expires_at);

create table if not exists public.scent_rush_progress (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.users(id) on delete cascade,
  fragrance_id text not null,
  level integer not null check (level between 1 and 3),
  best_score integer not null default 0 check (best_score >= 0),
  best_performance real not null default 0 check (best_performance between 0 and 1),
  beam_power integer not null default 0 check (beam_power between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists scent_rush_progress_user_fragrance_level_unique_idx
  on public.scent_rush_progress (tenant_id, user_id, fragrance_id, level);
create index if not exists scent_rush_progress_fragrance_idx
  on public.scent_rush_progress (tenant_id, fragrance_id);
