import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { db } from "@workspace/db";
import { userFragrancesTable, userSettingsTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { deriveAppState } from "../services/appStateCore";
import { logger } from "../lib/logger";

const router = Router();

/**
 * Additive app-state endpoint. Returns durable onboarding/discovery state for
 * the authenticated user without changing the `/api/wardrobe` contract.
 *
 * The frontend uses this to gate the dashboard CTA so a completed user never
 * sees the add-3 flow again because of a slow/empty/401 wardrobe load.
 */
router.get("/me/app-state", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userFragrancesTable)
    .where(and(eq(userFragrancesTable.tenantId, tenantId), eq(userFragrancesTable.userId, user.id)));
  const wardrobeCount = countRow?.count ?? 0;

  const [settings] = await db
    .select({ completed: userSettingsTable.wardrobeOnboardingCompleted })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, user.id))
    .limit(1);

  const { state, shouldPersistCompletion } = deriveAppState({
    authenticated: true,
    wardrobeCount,
    onboardingCompletedFlag: settings?.completed ?? false,
  });

  if (shouldPersistCompletion) {
    const now = new Date();
    try {
      await db
        .insert(userSettingsTable)
        .values({
          tenantId,
          userId: user.id,
          wardrobeOnboardingCompleted: true,
          wardrobeOnboardingCompletedAt: now,
        })
        .onConflictDoUpdate({
          target: userSettingsTable.userId,
          set: {
            wardrobeOnboardingCompleted: true,
            wardrobeOnboardingCompletedAt: now,
            updatedAt: now,
          },
        });
    } catch (err) {
      // Non-fatal: the response is already correct; persistence retries on the
      // next call once the wardrobe count is still >= the threshold.
      logger.warn({ err, userId: user.id }, "Failed to persist wardrobe onboarding completion");
    }
  }

  res.json(state);
});

export default router;
