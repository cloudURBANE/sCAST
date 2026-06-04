import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { db } from "@workspace/db";
import { userFragrancesTable, userSettingsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { getTenantId } from "../middlewares/tenant";
import { batchHydrateImageUrls, normalizeFragrance } from "../services/fragrancePayload";
import { isShareHidden, resolvePublicBuyLinksForRows } from "../services/buyLinks";
import { getShareIdForUser, resolveShareUser } from "../services/shareUsers";

const router = Router();

async function getOrCreateSettings(userId: string, tenantId: string) {
  const rows = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId))
    .limit(1);
  if (rows[0]) return rows[0];

  const [created] = await db
    .insert(userSettingsTable)
    .values({ userId, tenantId })
    .onConflictDoNothing({ target: userSettingsTable.userId })
    .returning();
  if (created) return created;

  const retry = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId))
    .limit(1);
  if (retry[0]) return retry[0];
  throw new Error("Failed to create share settings");
}

router.get("/share/:userRef", async (req, res) => {
  const { userRef } = req.params;
  const tenantId = getTenantId(req);

  const user = await resolveShareUser(userRef, tenantId);

  if (!user) {
    res.status(404).json({ error: "Vault not found" });
    return;
  }

  const [settings, fragranceRows] = await Promise.all([
    getOrCreateSettings(user.id, tenantId),
    db
      .select()
      .from(userFragrancesTable)
      .where(and(
        eq(userFragrancesTable.tenantId, tenantId),
        eq(userFragrancesTable.userId, user.id),
      )),
  ]);

  const visibleFragranceRows = fragranceRows.filter((row) => !isShareHidden(row));

  const normalized = visibleFragranceRows.map((row) => normalizeFragrance(row.fragranceData as Record<string, any>));
  const [hydrated, buyLinks] = await Promise.all([
    batchHydrateImageUrls(normalized),
    resolvePublicBuyLinksForRows(visibleFragranceRows),
  ]);
  const fragrances = hydrated.map((frag, i) => ({
    ...(frag as Record<string, any>),
    _dbId: visibleFragranceRows[i]!.id,
  }));

  res.json({ fragrances, hideImages: settings.shareHideImages, shareUserId: user.id, buyLinks });
});

router.get("/share-settings", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);
  const settings = await getOrCreateSettings(user.id, tenantId);
  const shareId = await getShareIdForUser(user, tenantId);
  res.json({
    userId: user.id,
    shareId,
    hideImages: settings.shareHideImages,
  });
});

router.post("/share-settings", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  const { hideImages } = req.body as { hideImages?: boolean };
  if (typeof hideImages !== "boolean") {
    res.status(400).json({ error: "hideImages (boolean) is required" });
    return;
  }

  await db
    .insert(userSettingsTable)
    .values({ userId: user.id, tenantId, shareHideImages: hideImages })
    .onConflictDoUpdate({
      target: userSettingsTable.userId,
      set: { tenantId, shareHideImages: hideImages, updatedAt: new Date() },
    });

  const shareId = await getShareIdForUser(user, tenantId);
  res.json({
    userId: user.id,
    shareId,
    hideImages,
  });
});

export default router;
