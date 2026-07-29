import { Request, Response, NextFunction } from "express";
import { runWithTenant } from "../lib/tenantContext";
import { DEFAULT_TENANT_SLUG, getDefaultTenantId, getTenantBySlug } from "../services/tenants";

// Augment Express' Request so every handler (authenticated or public) can read
// the resolved tenant without importing a custom request type.
declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      tenantSlug?: string;
    }
  }
}

// Tenants live at `<slug>.<APP_BASE_DOMAIN>`. When unset, host-based resolution
// is disabled and everything falls back to the default tenant.
const APP_BASE_DOMAIN = process.env.APP_BASE_DOMAIN?.trim().toLowerCase() || "";

function publicHost(req: Request): string {
  const forwarded = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwarded || req.get("host") || "").toLowerCase();
  return host.split(":")[0]; // strip any :port
}

/**
 * Derive a tenant slug from a host, or null when the host is the apex domain,
 * `www`, or does not sit under APP_BASE_DOMAIN (preview/localhost/etc.). Only
 * the left-most label is treated as the tenant slug.
 */
export function tenantSlugFromHost(host: string): string | null {
  if (!host || !APP_BASE_DOMAIN) return null;
  if (host === APP_BASE_DOMAIN) return null;
  const suffix = `.${APP_BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length).split(".")[0];
  if (!label || label === "www") return null;
  return label;
}

/** Resolve the request's tenant from its host and bind it for the request. */
export async function resolveTenant(req: Request, res: Response, next: NextFunction) {
  try {
    const slug = tenantSlugFromHost(publicHost(req));
    const tenant = slug ? await getTenantBySlug(slug) : null;
    const tenantId = tenant ? tenant.id : await getDefaultTenantId();

    req.tenantId = tenantId;
    req.tenantSlug = tenant ? tenant.slug : DEFAULT_TENANT_SLUG;

    runWithTenant(tenantId, () => next());
  } catch (err) {
    next(err);
  }
}

/**
 * Return the resolved tenant id, throwing if the resolveTenant middleware did
 * not run. Use in security-critical handlers so a misconfigured mount fails
 * closed instead of leaking across tenants.
 */
export function getTenantId(req: Request): string {
  if (!req.tenantId) {
    throw new Error("Tenant not resolved; resolveTenant middleware must run before this handler");
  }
  return req.tenantId;
}
