-- Migration: Tenant isolation enforcement
--
-- The previous migration (20260522103000_tenant_context_columns) added the
-- `tenants` table and nullable `tenant_id` columns. This migration:
--   1. Guarantees a "default" tenant exists.
--   2. Backfills every existing row to the default tenant.
--   3. Switches users.email from globally unique to per-tenant unique.
--   4. Adds composite indexes matching the new (tenant_id, user_id) access paths.
--
-- NOTE: tenant_id is intentionally left NULLABLE here so this stays compatible
-- with `drizzle-kit push` (the app's primary schema-sync tool) and never fails
-- on pre-tenant rows. The application enforces tenant on every write and the API
-- self-heals the seed + backfill on every boot (ensureTenantBaseline), so this
-- file is an OPTIONAL, idempotent hardening step — the app works without it.
--
-- Idempotent and defensive so restored/older databases can catch up safely.

-- 1. Default tenant -----------------------------------------------------------
insert into public.tenants (name, slug)
values ('Default', 'default')
on conflict (slug) do nothing;

-- 2. Backfill tenant_id on all NULL rows --------------------------------------
do $$
declare
  default_tenant_id uuid;
begin
  select id into default_tenant_id from public.tenants where slug = 'default';
  if default_tenant_id is null then
    raise exception 'default tenant missing; cannot backfill tenant_id';
  end if;

  update public.users          set tenant_id = default_tenant_id where tenant_id is null;
  update public.user_fragrances set tenant_id = default_tenant_id where tenant_id is null;
  update public.user_settings   set tenant_id = default_tenant_id where tenant_id is null;

  if to_regclass('public.api_usage_ledger') is not null then
    update public.api_usage_ledger set tenant_id = default_tenant_id where tenant_id is null;
  end if;
end $$;

-- 3. Email uniqueness: drop global, add per-tenant ----------------------------
-- Drop any single-column unique CONSTRAINT covering exactly users(email),
-- regardless of the name the original schema/drizzle gave it.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'users'
      and con.contype = 'u'
      and (
        select array_agg(att.attname order by att.attnum)
        from unnest(con.conkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = con.conrelid and att.attnum = k.attnum
      ) = array['email']
  loop
    execute format('alter table public.users drop constraint %I', c.conname);
  end loop;
end $$;

-- ...and any bare unique INDEX on exactly users(email) not backed by a constraint
-- (drizzle-kit push can create either form).
do $$
declare
  i record;
begin
  for i in
    select idx.relname as idxname
    from pg_index x
    join pg_class idx on idx.oid = x.indexrelid
    join pg_class rel on rel.oid = x.indrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'users'
      and x.indisunique
      and not x.indisprimary
      and not exists (select 1 from pg_constraint con where con.conindid = x.indexrelid)
      and (
        select array_agg(att.attname order by att.attnum)
        from unnest(x.indkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = x.indrelid and att.attnum = k.attnum
      ) = array['email']
  loop
    execute format('drop index public.%I', i.idxname);
  end loop;
end $$;

do $$
begin
  alter table public.users
    add constraint users_tenant_email_unique unique (tenant_id, email);
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

-- 4. Composite indexes for the new access paths -------------------------------
create index if not exists user_fragrances_tenant_user_idx
  on public.user_fragrances (tenant_id, user_id);

create index if not exists user_settings_tenant_user_idx
  on public.user_settings (tenant_id, user_id);
