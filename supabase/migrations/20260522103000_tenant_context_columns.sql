-- Migration: Tenant context schema
-- The application schema references tenant_id on core user-owned tables. Keep
-- this idempotent so older restored databases can catch up safely.

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now()
);

alter table if exists public.users
  add column if not exists tenant_id uuid;

alter table if exists public.user_fragrances
  add column if not exists tenant_id uuid;

alter table if exists public.user_settings
  add column if not exists tenant_id uuid;

alter table if exists public.api_usage_ledger
  add column if not exists tenant_id uuid;

do $$
begin
  if to_regclass('public.users') is not null then
    alter table public.users
      add constraint users_tenant_id_tenants_id_fk
      foreign key (tenant_id) references public.tenants(id);
  end if;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  if to_regclass('public.user_fragrances') is not null then
    alter table public.user_fragrances
      add constraint user_fragrances_tenant_id_tenants_id_fk
      foreign key (tenant_id) references public.tenants(id);
  end if;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  if to_regclass('public.user_settings') is not null then
    alter table public.user_settings
      add constraint user_settings_tenant_id_tenants_id_fk
      foreign key (tenant_id) references public.tenants(id);
  end if;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  if to_regclass('public.api_usage_ledger') is not null then
    alter table public.api_usage_ledger
      add constraint api_usage_ledger_tenant_id_tenants_id_fk
      foreign key (tenant_id) references public.tenants(id);
  end if;
exception
  when duplicate_object then null;
end $$;

create index if not exists users_tenant_id_idx
  on public.users (tenant_id);

create index if not exists user_fragrances_tenant_id_idx
  on public.user_fragrances (tenant_id);

create index if not exists user_settings_tenant_id_idx
  on public.user_settings (tenant_id);

do $$
begin
  if to_regclass('public.api_usage_ledger') is not null then
    create index if not exists api_usage_ledger_tenant_id_idx
      on public.api_usage_ledger (tenant_id);
  end if;
end $$;
