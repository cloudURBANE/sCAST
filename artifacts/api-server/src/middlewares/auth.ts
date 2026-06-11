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

// Columns that have always existed on `users`. Used as a fail-safe projection so a
// newly-declared-but-not-yet-migrated column (e.g. a column added to the schema
// before its migration is applied to the live DB) can never take down auth. A
// bare `db.select()` would emit every schema column; if one is missing in the DB,
// Postgres throws "column does not exist" (42703) and EVERY authenticated request
// 500s. We keep the fast path for the healthy case and only narrow on 42703.
const CORE_USER_COLUMNS = {
  id: usersTable.id,
  tenantId: usersTable.tenantId,
  email: usersTable.email,
  token: usersTable.token,
  oauthProvider: usersTable.oauthProvider,
  oauthSubject: usersTable.oauthSubject,
  createdAt: usersTable.createdAt,
} as const;

// drizzle-orm (since 0.41) wraps driver errors in DrizzleQueryError, moving the
// Postgres error (and its `code`) onto `cause` — so walk the cause chain instead
// of reading `code` off the top-level error.
export function isUndefinedColumnError(err: unknown): boolean {
  for (let current = err, depth = 0; typeof current === "object" && current !== null && depth < 5; depth++) {
    if ((current as { code?: string }).code === "42703") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function getUserByToken(token: string, tenantId?: string) {
  if (!UUID_RE.test(token)) return null;
  const whereClause = tenantId
    ? and(eq(usersTable.token, token as any), eq(usersTable.tenantId, tenantId))
    : eq(usersTable.token, token as any);
  try {
    const users = await db.select().from(usersTable).where(whereClause).limit(1);
    return users[0] ?? null;
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    // A schema column is missing from the live DB (migration lag). Re-run with only
    // the columns auth needs so login/sync keep working until the migration lands.
    const rows = await db.select(CORE_USER_COLUMNS).from(usersTable).where(whereClause).limit(1);
    const row = rows[0];
    return row ? ({ ...row, pictureUrl: null } as typeof usersTable.$inferSelect) : null;
  }
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
