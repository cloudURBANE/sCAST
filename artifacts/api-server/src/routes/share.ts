import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userFragrancesTable, userSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { hydrateImageUrl, normalizeFragrance } from "../services/fragrancePayload";

const router = Router();

function getToken(req: any): string | null {
  const auth = req.headers["authorization"] as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function shareHandleFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const normalized = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "user";
}

async function resolveShareUser(userRef: string) {
  if (isUuidish(userRef)) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, userRef)).limit(1);
    if (rows[0]) return rows[0];
  }

  const cleanRef = userRef.trim().toLowerCase().replace(/^@+/, "");
  if (!cleanRef) return null;
  const users = await db.select().from(usersTable);
  return (
    users.find((u) => shareHandleFromEmail(u.email) === cleanRef) ??
    null
  );
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

router.get("/share-settings", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const settings = await getOrCreateSettings(user.id);
  res.json({
    userId: user.id,
    shareId: `@${shareHandleFromEmail(user.email)}`,
    hideImages: settings.shareHideImages,
  });
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

  res.json({
    userId: user.id,
    shareId: `@${shareHandleFromEmail(user.email)}`,
    hideImages,
  });
});

export default router;
