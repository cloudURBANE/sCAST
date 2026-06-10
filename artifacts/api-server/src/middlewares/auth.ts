import { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { getTenantId } from "./tenant";
import { isAdminUser } from "../lib/adminAccess";

export interface AuthRequest extends Request {
  user?: typeof usersTable.$inferSelect;
}

export function getToken(req: Request): string | null {
  const auth = req.headers["authorization"] as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// users.token is a `uuid` column. A non-UUID token (e.g. a legacy/stale value left
// in a browser's localStorage) makes Postgres throw "invalid input syntax for type
// uuid", which surfaced as a 500. Reject malformed tokens here so callers see a clean
// 401 (and the SPA can re-prompt login) instead of an unrecoverable server error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getUserByToken(token: string, tenantId?: string) {
  if (!UUID_RE.test(token)) return null;
  const users = await db
    .select()
    .from(usersTable)
    .where(
      tenantId
        ? and(eq(usersTable.token, token as any), eq(usersTable.tenantId, tenantId))
        : eq(usersTable.token, token as any),
    )
    .limit(1);
  return users[0] ?? null;
}

/**
 * Like `requireAuth`, but never rejects: a valid token populates `req.user`, while
 * a missing/invalid one simply leaves it undefined and continues. Use on public
 * read routes that want to tailor the response to the caller (e.g. the community
 * feed surfacing the viewer's own reactions/votes) without forcing sign-in.
 */
export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const token = getToken(req);
  if (token) {
    // Scope to the request's tenant, exactly like requireAuth, so a token minted
    // on Tenant A can't surface viewer state against Tenant B.
    const user = await getUserByToken(token, getTenantId(req));
    if (user) req.user = user;
  }
  next();
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Scope the token lookup to the request's tenant: a token minted on Tenant A
  // must not authenticate against Tenant B's subdomain.
  const user = await getUserByToken(token, getTenantId(req));
  if (!user) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  req.user = user;
  next();
}

/**
 * Gate a route to admin users only. Must run *after* `requireAuth` so `req.user`
 * is populated. Returns 403 (authenticated but not authorized) for non-admins,
 * keeping it distinct from the 401 `requireAuth` issues for missing/invalid auth.
 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
