-- Tenant-scoped, newest-first wardrobe feed query.
--
-- routes/community.ts filters user_fragrances by tenant_id and orders by
-- created_at desc. The existing (tenant_id, user_id) index does not cover the
-- created_at ordering, so the feed query sorts via a heap scan. This composite
-- index lets Postgres satisfy the filter + ORDER BY directly.
--
-- Applied transactionally by scripts/src/apply-sql-migration.ts (plain CREATE
-- INDEX — the runner wraps SQL in BEGIN/COMMIT, so CONCURRENTLY is not used
-- here). The table is small, so the brief lock is acceptable; on a large table
-- apply the equivalent CREATE INDEX CONCURRENTLY by hand instead.
create index if not exists user_fragrances_tenant_created_at_idx
on public.user_fragrances (tenant_id, created_at desc);
