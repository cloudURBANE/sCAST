import { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

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

export async function getUserByToken(token: string) {
  if (!UUID_RE.test(token)) return null;
  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.token, token as any))
    .limit(1);
  return users[0] ?? null;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = await getUserByToken(token);
  if (!user) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  req.user = user;
  next();
}
