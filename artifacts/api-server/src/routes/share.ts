import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userFragrancesTable, userSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { hydrateImageUrl, normalizeFragrance } from "../services/fragrancePayload";
import { searchImageUrl } from "../services/imageService";

const router = Router();

function debugLog(location: string, message: string, hypothesisId: string, data: Record<string, unknown>) {
  // #region agent log
  fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'db2024'},body:JSON.stringify({sessionId:'db2024',runId:'baseline-share-access',hypothesisId,location,message,data,timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

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
  debugLog("routes/share.ts:47", "share route entry", "H1", { userId });

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    debugLog("routes/share.ts:57", "share user missing", "H1", { userId });
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
  debugLog("routes/share.ts:71", "raw fragrances prepared", "H2", {
    userId,
    totalRows: fragranceRows.length,
    visibleRows: rawFragrances.length,
    missingTopLevelName: rawFragrances.filter((f) => !f?.name).length,
    missingTopLevelBrand: rawFragrances.filter((f) => !f?.brand).length,
  });

  const fragrances = await Promise.all(
    rawFragrances.map(async (raw) => {
      let frag = normalizeFragrance(raw);
      frag = await hydrateImageUrl(frag);

      const url = typeof frag.imageUrl === "string" ? frag.imageUrl.trim() : "";
      if (url) return frag;

      const name = frag.name as string | undefined;
      const brand = frag.brand as string | undefined;
      if (!name || !brand) return frag;
      try {
        const freshUrl = await searchImageUrl(`${brand} ${name} single fragrance bottle packshot studio no plants`);
        if (freshUrl) return { ...frag, imageUrl: freshUrl };
      } catch {
        /* non-fatal */
      }
      return frag;
    })
  );
  debugLog("routes/share.ts:98", "share payload finalized", "H3", {
    userId,
    hideImages: settings.shareHideImages,
    totalVisibleFragrances: fragrances.length,
    withImageUrl: fragrances.filter((f) => typeof f?.imageUrl === "string" && f.imageUrl.trim().length > 0).length,
    withoutImageUrl: fragrances.filter((f) => !(typeof f?.imageUrl === "string" && f.imageUrl.trim().length > 0)).length,
  });

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
