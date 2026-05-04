import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userFragrancesTable, userSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { resolveSharedImageUrl } from "../services/imageHydration";
import { searchImageUrl } from "../services/imageService";

const router = Router();

function getToken(req: any): string | null {
  const auth = req.headers["authorization"] as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

async function getUserByToken(token: string) {
  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.token, token as any))
    .limit(1);
  return users[0] ?? null;
}

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
    .returning();
  return created;
}

router.get("/share/:userId", async (req, res) => {
  const { userId } = req.params;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "Vault not found" });
    return;
  }

  const [settings, fragranceRows] = await Promise.all([
    getOrCreateSettings(userId),
    db.select().from(userFragrancesTable).where(eq(userFragrancesTable.userId, userId)),
  ]);

  const rawFragrances = fragranceRows
    .map(r => r.fragranceData as Record<string, any>)
    .filter(data => !data.shareHidden);

  const fragrances = await Promise.all(
    rawFragrances.map(async (frag) => {
      if (frag.imageUrl) return frag;
      const name = frag.name as string | undefined;
      const brand = frag.brand as string | undefined;
      if (!name || !brand) return frag;
      try {
        const imageUrl = await resolveSharedImageUrl(brand, name);
        if (imageUrl) return { ...frag, imageUrl };
        const freshUrl = await searchImageUrl(`${brand} ${name}`);
        if (freshUrl) return { ...frag, imageUrl: freshUrl };
      } catch {
        /* non-fatal */
      }
      return frag;
    })
  );

  res.json({ fragrances, hideImages: settings.shareHideImages });
});

router.get("/share-settings", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const settings = await getOrCreateSettings(user.id);
  res.json({ userId: user.id, hideImages: settings.shareHideImages });
});

router.post("/share-settings", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

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

  res.json({ userId: user.id, hideImages });
});

export default router;
