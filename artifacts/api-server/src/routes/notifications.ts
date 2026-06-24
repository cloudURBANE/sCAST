import { Router } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { inAppNotificationsTable } from "@workspace/db/schema";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";

const router = Router();

/**
 * In-app notification CRUD.
 *
 * Mirrors push notification history into a persistent feed the user can view
 * across devices. All endpoints are authenticated and tenant-scoped.
 *
 * Tolerates the `in_app_notifications` table not existing yet (Postgres 42P01)
 * and additive columns (e.g. `read_at`) not existing yet (42703) so a deploy
 * never 500s these endpoints before `drizzle-kit push` lands.
 */

// GET /notifications — last 50 notifications for the authenticated user, plus a
// server-authoritative unread count over ALL of the user's rows (not just the
// 50-row page), so the bell badge can show a real number that isn't capped at
// the page size.
router.get("/notifications", requireAuth, async (req: AuthRequest, res) => {
  const scope = and(
    eq(inAppNotificationsTable.userId, req.user!.id),
    eq(inAppNotificationsTable.tenantId, getTenantId(req)),
  );
  try {
    const [rows, unreadRows] = await Promise.all([
      db
        .select()
        .from(inAppNotificationsTable)
        .where(scope)
        .orderBy(desc(inAppNotificationsTable.createdAt))
        .limit(50),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(inAppNotificationsTable)
        .where(and(scope, eq(inAppNotificationsTable.read, false))),
    ]);
    res.json({ notifications: rows, unreadCount: unreadRows[0]?.count ?? 0 });
  } catch (err: unknown) {
    if (isMissingTableOrColumn(err)) {
      res.json({ notifications: [], unreadCount: 0 });
      return;
    }
    throw err;
  }
});

// PATCH /notifications/:id/read — mark a single notification as read.
router.patch("/notifications/:id/read", requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;
  if (typeof id !== "string") {
    res.status(400).json({ error: "Invalid notification ID." });
    return;
  }
  const where = and(
    eq(inAppNotificationsTable.id, id),
    eq(inAppNotificationsTable.userId, req.user!.id),
  );
  try {
    const updated = await markRead(where, true);
    if (!updated) {
      res.status(404).json({ error: "Notification not found." });
      return;
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    if (isMissingTableOrColumn(err)) {
      res.status(404).json({ error: "Notification not found." });
      return;
    }
    throw err;
  }
});

// PATCH /notifications/read-all — mark all notifications as read for the user.
router.patch("/notifications/read-all", requireAuth, async (req: AuthRequest, res) => {
  const where = and(
    eq(inAppNotificationsTable.userId, req.user!.id),
    eq(inAppNotificationsTable.tenantId, getTenantId(req)),
  );
  try {
    await markRead(where, false);
    res.json({ ok: true });
  } catch (err: unknown) {
    if (isMissingTableOrColumn(err)) {
      res.json({ ok: true });
      return;
    }
    throw err;
  }
});

// DELETE /notifications/:id — delete a notification (ownership-checked).
// Stays idempotent (200 even when nothing matched) so an optimistic client and
// cross-device double-deletes don't error, but returns `deleted` so the caller
// can still distinguish "removed a row" from "already gone".
router.delete("/notifications/:id", requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;
  if (typeof id !== "string") {
    res.status(400).json({ error: "Invalid notification ID." });
    return;
  }
  try {
    const [deleted] = await db
      .delete(inAppNotificationsTable)
      .where(
        and(
          eq(inAppNotificationsTable.id, id),
          eq(inAppNotificationsTable.userId, req.user!.id),
        ),
      )
      .returning({ id: inAppNotificationsTable.id });
    res.json({ ok: true, deleted: Boolean(deleted) });
  } catch (err: unknown) {
    if (isMissingTableOrColumn(err)) {
      res.json({ ok: true, deleted: false });
      return;
    }
    throw err;
  }
});

// ─── helpers ───────────────────────────────────────────────────────────
/**
 * Mark rows read, stamping `read_at`. If the (additive) `read_at` column hasn't
 * been migrated into the live DB yet, Postgres raises undefined_column (42703);
 * we degrade to setting `read` alone so mark-as-read keeps working pre-migration.
 * When `single` is true the matched row id is returned so the caller can 404.
 */
async function markRead(
  where: ReturnType<typeof and>,
  single: boolean,
): Promise<{ id: string } | undefined> {
  try {
    if (single) {
      const [row] = await db
        .update(inAppNotificationsTable)
        .set({ read: true, readAt: sql`now()` })
        .where(where)
        .returning({ id: inAppNotificationsTable.id });
      return row;
    }
    await db
      .update(inAppNotificationsTable)
      .set({ read: true, readAt: sql`now()` })
      .where(where);
    return undefined;
  } catch (err: unknown) {
    if (!isUndefinedColumn(err)) throw err;
    // read_at not migrated yet — retry with the always-present `read` column.
    if (single) {
      const [row] = await db
        .update(inAppNotificationsTable)
        .set({ read: true })
        .where(where)
        .returning({ id: inAppNotificationsTable.id });
      return row;
    }
    await db
      .update(inAppNotificationsTable)
      .set({ read: true })
      .where(where);
    return undefined;
  }
}

/** Walk drizzle's wrapped-error cause chain and return the first pg error code. */
function pgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Postgres "undefined_table" (42P01) or "undefined_column" (42703). */
function isMissingTableOrColumn(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code === "42P01" || code === "42703";
}

/** Postgres "undefined_column" (42703) only — an un-migrated additive column. */
function isUndefinedColumn(err: unknown): boolean {
  return pgErrorCode(err) === "42703";
}

export default router;
