import { Router } from "express";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { db } from "@workspace/db";
import { userFragrancesTable, userSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { hydrateImageUrl, normalizeFragrance } from "../services/fragrancePayload";
import { getShareIdForUser, resolveShareUser } from "../services/shareUsers";

const router = Router();

async function getOrCreateSettings(userId: string) {
  const rows = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId))
    .limit(1);
  if (rows[0]) return rows[0];

  const [created] = await db
    .insert(userSettingsTable)
    .values({ userId })
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

  const user = await resolveShareUser(userRef);

  if (!user) {
    res.status(404).json({ error: "Vault not found" });
    return;
  }

  const [settings, fragranceRows] = await Promise.all([
    getOrCreateSettings(user.id),
    db.select().from(userFragrancesTable).where(eq(userFragrancesTable.userId, user.id)),
  ]);

  const visibleFragranceRows = fragranceRows
    .map(r => ({ rowId: r.id, data: r.fragranceData as Record<string, any> }))
    .filter(({ data }) => !data.shareHidden);

  const fragrances: Record<string, any>[] = await Promise.all(
    visibleFragranceRows.map(async ({ rowId, data: raw }) => {
      let frag = normalizeFragrance(raw);
      frag = await hydrateImageUrl(frag);

      return { ...(frag as Record<string, any>), _dbId: rowId };
    })
  );

  res.json({ fragrances, hideImages: settings.shareHideImages, shareUserId: user.id });
});

router.get("/share-settings", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const settings = await getOrCreateSettings(user.id);
  const shareId = await getShareIdForUser(user);
  res.json({
    userId: user.id,
    shareId,
    hideImages: settings.shareHideImages,
  });
});

router.post("/share-settings", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;

  const { hideImages } = req.body as { hideImages?: boolean };
  if (typeof hideImages !== "boolean") {
    res.status(400).json({ error: "hideImages (boolean) is required" });
    return;
  }

  await db
    .insert(userSettingsTable)
    .values({ userId: user.id, shareHideImages: hideImages })
    .onConflictDoUpdate({
      target: userSettingsTable.userId,
      set: { shareHideImages: hideImages, updatedAt: new Date() },
    });

  const shareId = await getShareIdForUser(user);
  res.json({
    userId: user.id,
    shareId,
    hideImages,
  });
});

export default router;
