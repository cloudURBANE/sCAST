import { AsyncLocalStorage } from "node:async_hooks";

interface TenantStore {
  tenantId: string;
}

const storage = new AsyncLocalStorage<TenantStore>();

/**
 * Run `fn` (and everything it awaits) bound to a tenant. The tenant-resolution
 * middleware wraps the rest of each request in this so deep service calls that
 * cannot easily thread a `tenantId` argument (e.g. recordApiUsage) can recover
 * it via getCurrentTenantId().
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/** The tenant bound to the current async context, or null outside a request. */
export function getCurrentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}
