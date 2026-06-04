import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { cleanShareRef, isUuidish, shareHandleFromEmail } from "./shareIdentity";

export function shareHandleSql() {
  return sql<string>`coalesce(nullif(regexp_replace(regexp_replace(lower(split_part(${usersTable.email}, '@', 1)), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), ''), 'user')`;
}

export async function resolveShareUser(
  userRef: string,
  tenantId: string,
): Promise<typeof usersTable.$inferSelect | null> {
  if (isUuidish(userRef)) {
    const rows = await db
      .select()
      .from(usersTable)
      .where(and(
        eq(usersTable.tenantId, tenantId),
        eq(usersTable.id, userRef.toLowerCase() as any),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  const cleanRef = cleanShareRef(userRef);
  if (!cleanRef) return null;

  const rows = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), sql`${shareHandleSql()} = ${cleanRef}`))
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

export async function getShareIdForUser(
  user: typeof usersTable.$inferSelect,
  tenantId: string,
): Promise<string> {
  const handle = shareHandleFromEmail(user.email);
  // Handle collisions only matter within the user's own tenant — share URLs are
  // resolved per-tenant (by subdomain).
  const duplicates = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.tenantId, tenantId),
      sql`${usersTable.id} <> ${user.id}`,
      sql`${shareHandleSql()} = ${handle}`,
    ))
    .limit(1);
  return duplicates.length > 0 ? user.id : `@${handle}`;
}
