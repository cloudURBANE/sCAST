create table if not exists public.image_cache (
  id uuid primary key default gen_random_uuid(),

  user_id uuid null references public.users(id) on delete set null,
  fragrance_id text null,
  lookup_key text null,

  source_provider text not null default 'serper',
  source_url text not null,
  source_url_hash text not null,
  search_query_hash text null,
  pipeline_version text not null,

  content_hash text null,
  perceptual_hash text null,
  storage_provider text not null,
  storage_path text not null,
  public_url text null,

  mime_type text null,
  width integer null,
  height integer null,
  size_bytes integer null,

  background_removed boolean not null default false,
  processing_status text not null default 'ready',
  failure_reason text null,

  hit_count integer not null default 0,
  last_used_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists image_cache_source_pipeline_unique_idx
on public.image_cache (source_url_hash, pipeline_version);

create index if not exists image_cache_lookup_key_idx
on public.image_cache (lookup_key);

create index if not exists image_cache_user_id_idx
on public.image_cache (user_id);

create index if not exists image_cache_source_url_hash_idx
on public.image_cache (source_url_hash);

create index if not exists image_cache_content_hash_idx
on public.image_cache (content_hash);

create index if not exists image_cache_search_query_hash_idx
on public.image_cache (search_query_hash);

create index if not exists image_cache_processing_status_idx
on public.image_cache (processing_status);

comment on table public.image_cache is
  'Metadata-only processed image cache. Binary/base64 image data is forbidden in Postgres.';

comment on column public.image_cache.public_url is
  'Lightweight display URL for an object stored outside Postgres.';

comment on column public.image_cache.storage_path is
  'Object storage key/path. This must not contain base64 image data.';

update public.global_fragrances
set profile_data = jsonb_set(profile_data, '{imageUrl}', '""'::jsonb, true),
    updated_at = now()
where profile_data ->> 'imageUrl' like 'data:image/%';

update public.user_fragrances
set fragrance_data = jsonb_set(fragrance_data, '{imageUrl}', '""'::jsonb, true)
where fragrance_data ->> 'imageUrl' like 'data:image/%';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'global_fragrances_profile_data_no_data_image'
      and conrelid = 'public.global_fragrances'::regclass
  ) then
    alter table public.global_fragrances
      add constraint global_fragrances_profile_data_no_data_image
      check (coalesce(profile_data ->> 'imageUrl', '') not like 'data:image/%');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_fragrances_fragrance_data_no_data_image'
      and conrelid = 'public.user_fragrances'::regclass
  ) then
    alter table public.user_fragrances
      add constraint user_fragrances_fragrance_data_no_data_image
      check (coalesce(fragrance_data ->> 'imageUrl', '') not like 'data:image/%');
  end if;
end $$;
