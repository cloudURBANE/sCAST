# Handoff: Share Settings Failure And Tenant Schema Drift

Date: 2026-05-22

## Immediate Issue

`ShareModal.tsx` loads `GET /api/share-settings` when the share modal opens. The user-facing toast was:

- `Failed to load share settings`
- `Unable to retrieve your current sharing configuration.`

The backend route is `artifacts/api-server/src/routes/share.ts`, specifically `GET /share-settings`.

## Root Cause Found

Commit `966866f` added tenant-aware Drizzle schema fields and relations:

- `users.tenant_id`
- `user_fragrances.tenant_id`
- `user_settings.tenant_id`
- `api_usage_ledger.tenant_id`
- new `tenants` schema/table expectation

But the shipped migration in that commit only updated nested wardrobe UUIDs:

- `supabase/migrations/20260522101605_stable_uuid_migration.sql`

That means a restored or production database could lack `public.user_settings.tenant_id` while the app schema generated SQL selecting/inserting it. `GET /api/share-settings` then fails in `getOrCreateSettings`.

## Fix Applied

Added an idempotent migration:

- `supabase/migrations/20260522103000_tenant_context_columns.sql`

It creates `public.tenants`, adds nullable `tenant_id` columns to the tenant-aware tables, and adds FK/indexes safely when the target tables exist.

Updated `artifacts/api-server/src/routes/share.ts` so share settings creation/upsert carries `user.tenantId ?? null`.

Updated `artifacts/scent-cast/src/components/ShareModal.tsx` so the initial `fetch('/api/share-settings')` rejects non-OK HTTP responses instead of blindly parsing JSON.

## Validation Run

All passed:

```powershell
corepack pnpm --filter @workspace/api-server run typecheck
corepack pnpm --filter @workspace/scent-cast run typecheck
corepack pnpm run typecheck
```

## Continue Here

1. Deploy/apply `supabase/migrations/20260522103000_tenant_context_columns.sql` to the affected database.
2. Hit `GET /api/share-settings` with a valid bearer token and confirm it returns `{ userId, shareId, hideImages }`.
3. Check the API logs for any remaining `user_settings` insert/select errors.
4. Re-test the share modal open, image visibility toggle, and public share page.
5. Audit the rest of the tenant-aware schema additions from `966866f` for similar missing migrations.

## Dirty Local Tree Notes

The worktree had unrelated local edits before this fix. They were intentionally not staged in this handoff commit:

- `.env.example`
- `artifacts/api-server/src/routes/wardrobe.ts`
- `lib/db/src/schema/apiUsageLedger.ts`
- `lib/db/src/schema/index.ts`
- `scripts/src/cleanup-orphaned-images.ts`

There were also untracked scratch scripts with hardcoded database connection strings. Do not commit them as-is; rotate credentials if they were copied anywhere unsafe:

- `artifacts/api-server/src/test-db.ts`
- `lib/db/src/run-tenant-migration.ts`
- `lib/db/src/test-db.ts`
- `lib/db/src/test-drizzle.ts`
