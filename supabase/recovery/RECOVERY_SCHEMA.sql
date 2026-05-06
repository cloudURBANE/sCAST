-- Scent Cast recovery schema helper
-- Evidence:
-- - Current runtime schema: lib/db/src/schema/*
-- - Historical reference schema: initial setup ref files for recovery/src/schema/*
-- - Old backup: supabase-clean-backup-20260506-115506/full_database_clean.readable.sql
--
-- This file is intentionally non-destructive. It does not import old rows.
-- For 1:1 continuity, restore the old dump into staging first.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token uuid not null default gen_random_uuid(),
  oauth_provider text,
  oauth_subject text,
  created_at timestamp without time zone not null default now()
);

alter table public.users add column if not exists id uuid default gen_random_uuid();
alter table public.users add column if not exists email text;
alter table public.users add column if not exists token uuid default gen_random_uuid();
alter table public.users add column if not exists oauth_provider text;
alter table public.users add column if not exists oauth_subject text;
alter table public.users add column if not exists created_at timestamp without time zone default now();

create table if not exists public.global_fragrances (
  id uuid primary key default gen_random_uuid(),
  lookup_key text not null,
  name text not null,
  brand text not null,
  profile_data jsonb not null,
  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now()
);

alter table public.global_fragrances add column if not exists id uuid default gen_random_uuid();
alter table public.global_fragrances add column if not exists lookup_key text;
alter table public.global_fragrances add column if not exists name text;
alter table public.global_fragrances add column if not exists brand text;
alter table public.global_fragrances add column if not exists profile_data jsonb;
alter table public.global_fragrances add column if not exists created_at timestamp without time zone default now();
alter table public.global_fragrances add column if not exists updated_at timestamp without time zone default now();

create table if not exists public.user_fragrances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  fragrance_data jsonb not null,
  created_at timestamp without time zone not null default now()
);

alter table public.user_fragrances add column if not exists id uuid default gen_random_uuid();
alter table public.user_fragrances add column if not exists user_id uuid;
alter table public.user_fragrances add column if not exists fragrance_data jsonb;
alter table public.user_fragrances add column if not exists created_at timestamp without time zone default now();

create table if not exists public.user_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  share_hide_images boolean not null default false,
  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now()
);

alter table public.user_settings add column if not exists id uuid default gen_random_uuid();
alter table public.user_settings add column if not exists user_id uuid;
alter table public.user_settings add column if not exists share_hide_images boolean default false;
alter table public.user_settings add column if not exists created_at timestamp without time zone default now();
alter table public.user_settings add column if not exists updated_at timestamp without time zone default now();

-- Low-confidence legacy scaffold: present in schema files and old backup with 0 rows,
-- but not exported by current lib/db/src/schema/index.ts and not used by runtime.
create sequence if not exists public.conversations_id_seq;
create table if not exists public.conversations (
  id integer primary key default nextval('public.conversations_id_seq'::regclass),
  title text not null,
  created_at timestamp with time zone not null default now()
);

create sequence if not exists public.messages_id_seq;
create table if not exists public.messages (
  id integer primary key default nextval('public.messages_id_seq'::regclass),
  conversation_id integer not null references public.conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamp with time zone not null default now()
);

-- Safe indexes. Unique indexes are guarded by current data quality; if duplicates
-- exist, these statements will fail and should be investigated, not forced.
create unique index if not exists users_email_unique_idx on public.users (email);
create unique index if not exists users_id_unique_idx on public.users (id);
create index if not exists users_token_idx on public.users (token);
create index if not exists users_oauth_provider_subject_idx on public.users (oauth_provider, oauth_subject);
create unique index if not exists global_fragrances_id_unique_idx on public.global_fragrances (id);
create unique index if not exists global_fragrances_lookup_key_unique_idx on public.global_fragrances (lookup_key);
create index if not exists global_fragrances_brand_name_idx on public.global_fragrances (brand, name);
create unique index if not exists user_fragrances_id_unique_idx on public.user_fragrances (id);
create index if not exists user_fragrances_user_id_idx on public.user_fragrances (user_id);
create unique index if not exists user_settings_id_unique_idx on public.user_settings (id);
create unique index if not exists user_settings_user_id_unique_idx on public.user_settings (user_id);
create index if not exists messages_conversation_id_idx on public.messages (conversation_id);

-- Add missing foreign keys where possible. These blocks do not delete or repair data.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_fragrances_user_id_users_id_fk'
      and conrelid = 'public.user_fragrances'::regclass
  ) then
    alter table public.user_fragrances
      add constraint user_fragrances_user_id_users_id_fk
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
exception
  when others then
    raise notice 'Could not add user_fragrances FK: %', sqlerrm;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_settings_user_id_users_id_fk'
      and conrelid = 'public.user_settings'::regclass
  ) then
    alter table public.user_settings
      add constraint user_settings_user_id_users_id_fk
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
exception
  when others then
    raise notice 'Could not add user_settings FK: %', sqlerrm;
end $$;

comment on table public.users is 'Scent Cast app users. Current runtime auth uses this table and users.token, not Supabase Auth.';
comment on table public.user_fragrances is 'Scent Cast wardrobe rows. fragrance_data stores the full JSONB item payload.';
comment on table public.global_fragrances is 'Shared fragrance profile/catalog cache used by search and image hydration.';
comment on table public.user_settings is 'Per-user share settings.';
