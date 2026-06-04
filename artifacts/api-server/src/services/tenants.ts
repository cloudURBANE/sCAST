import { db } from "@workspace/db";
import {
  apiUsageLedgerTable,
  tenantsTable,
  userFragrancesTable,
  userSettingsTable,
  usersTable,
} from "@workspace/db/schema";
import { eq, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Slug of the fallback tenant. Every host that does not map to a real tenant
 * subdomain (apex domain, localhost, Railway/Vercel preview hosts, the current
 * single-domain production deploy) resolves here, so isolation can ship without
 * changing today's behaviour.
 */
export const DEFAULT_TENANT_SLUG = (process.env.DEFAULT_TENANT_SLUG || "default").toLowerCase();

export interface ResolvedTenant {
  id: string;
  slug: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: ResolvedTenant | null; expires: number }>();

async function lookupTenant(slug: string): Promise<ResolvedTenant | null> {
  const rows = await db
    .select({ id: tenantsTable.id, slug: tenantsTable.slug })
    .from(tenantsTable)
    .where(eq(tenantsTable.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve a tenant by slug, cached briefly to avoid a DB hit per request. */
export async function getTenantBySlug(slug: string): Promise<ResolvedTenant | null> {
  const key = slug.toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;

  const value = await lookupTenant(key);
  cache.set(key, { value, expires: now + CACHE_TTL_MS });
  return value;
}

/** Id of the default tenant. Throws if the baseline has not been provisioned. */
export async function getDefaultTenantId(): Promise<string> {
  const tenant = await getTenantBySlug(DEFAULT_TENANT_SLUG);
  if (!tenant) {
    throw new Error(
      `Default tenant '${DEFAULT_TENANT_SLUG}' not found; ensureTenantBaseline() should have created it`,
    );
  }
  return tenant.id;
}

/**
 * Idempotent startup self-heal so multi-tenancy works without anyone hand-running
 * a migration in the right order:
 *   1. Create the default tenant if it does not exist.
 *   2. Backfill every pre-tenant row (tenant_id IS NULL) onto it, so existing
 *      wardrobes/users/settings/usage stay visible once queries filter by tenant.
 *
 * Safe to run on every boot; a no-op once the data is in place. Never throws past
 * the caller's control — a failure here is logged but must not wedge startup.
 */
export async function ensureTenantBaseline(): Promise<void> {
  // 1. Default tenant.
  await db
    .insert(tenantsTable)
    .values({ name: "Default", slug: DEFAULT_TENANT_SLUG })
    .onConflictDoNothing({ target: tenantsTable.slug });

  cache.delete(DEFAULT_TENANT_SLUG);
  const defaultTenantId = await getDefaultTenantId();

  // 2. Backfill NULL tenant_id rows. user_fragrances first is harmless either way.
  const backfilled = {
    users: 0,
    userFragrances: 0,
    userSettings: 0,
    apiUsageLedger: 0,
  };

  const userRes = await db
    .update(usersTable)
    .set({ tenantId: defaultTenantId })
    .where(isNull(usersTable.tenantId));
  backfilled.users = userRes.rowCount ?? 0;

  const fragRes = await db
    .update(userFragrancesTable)
    .set({ tenantId: defaultTenantId })
    .where(isNull(userFragrancesTable.tenantId));
  backfilled.userFragrances = fragRes.rowCount ?? 0;

  const settingsRes = await db
    .update(userSettingsTable)
    .set({ tenantId: defaultTenantId })
    .where(isNull(userSettingsTable.tenantId));
  backfilled.userSettings = settingsRes.rowCount ?? 0;

  // api_usage_ledger may be absent on freshly-restored DBs; ignore "table missing".
  try {
    const ledgerRes = await db
      .update(apiUsageLedgerTable)
      .set({ tenantId: defaultTenantId })
      .where(isNull(apiUsageLedgerTable.tenantId));
    backfilled.apiUsageLedger = ledgerRes.rowCount ?? 0;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "42P01") throw err;
  }

  const total =
    backfilled.users +
    backfilled.userFragrances +
    backfilled.userSettings +
    backfilled.apiUsageLedger;
  logger.info(
    { defaultTenantId, backfilled },
    total > 0 ? "tenant baseline: backfilled pre-tenant rows" : "tenant baseline ready",
  );
}
