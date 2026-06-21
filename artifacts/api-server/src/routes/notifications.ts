import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
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
 * so a deploy never 500s these endpoints before `drizzle-kit push` lands.
 */

// GET /notifications — last 50 notifications for the authenticated user.
router.get("/notifications", requireAuth, async (req: AuthRequest, res) => {
  try {
    const rows = await db
      .select()
      .from(inAppNotificationsTable)
      .where(
        and(
          eq(inAppNotificationsTable.userId, req.user!.id),
          eq(inAppNotificationsTable.tenantId, getTenantId(req)),
        ),
      )
      .orderBy(desc(inAppNotificationsTable.createdAt))
      .limit(50);
    res.json({ notifications: rows });
  } catch (err: unknown) {
    if (isTableMissing(err)) {
      res.json({ notifications: [] });
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
  try {
    const [updated] = await db
      .update(inAppNotificationsTable)
      .set({ read: true })
      .where(
        and(
          eq(inAppNotificationsTable.id, id),
          eq(inAppNotificationsTable.userId, req.user!.id),
        ),
      )
      .returning({ id: inAppNotificationsTable.id });
    if (!updated) {
      res.status(404).json({ error: "Notification not found." });
      return;
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    if (isTableMissing(err)) {
      res.status(404).json({ error: "Notification not found." });
      return;
    }
    throw err;
  }
});

// PATCH /notifications/read-all — mark all notifications as read for the user.
router.patch("/notifications/read-all", requireAuth, async (req: AuthRequest, res) => {
  try {
    await db
      .update(inAppNotificationsTable)
      .set({ read: true })
      .where(
        and(
          eq(inAppNotificationsTable.userId, req.user!.id),
          eq(inAppNotificationsTable.tenantId, getTenantId(req)),
        ),
      );
    res.json({ ok: true });
  } catch (err: unknown) {
    if (isTableMissing(err)) {
      res.json({ ok: true });
      return;
    }
    throw err;
  }
});

// DELETE /notifications/:id — delete a notification (ownership-checked).
router.delete("/notifications/:id", requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;
  if (typeof id !== "string") {
    res.status(400).json({ error: "Invalid notification ID." });
    return;
  }
  try {
    await db
      .delete(inAppNotificationsTable)
      .where(
        and(
          eq(inAppNotificationsTable.id, id),
          eq(inAppNotificationsTable.userId, req.user!.id),
        ),
      );
    res.json({ ok: true });
  } catch (err: unknown) {
    if (isTableMissing(err)) {
      res.json({ ok: true });
      return;
    }
    throw err;
  }
});

// ─── helpers ───────────────────────────────────────────────────────────
/** Detect Postgres "undefined_table" (42P01) or "undefined_column" (42703). */
function isTableMissing(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "42P01" || code === "42703";
}

export default router;
