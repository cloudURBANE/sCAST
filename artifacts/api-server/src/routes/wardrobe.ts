import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userFragrancesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { resolveSharedImageUrl } from "../services/imageHydration";
import { buildProfile } from "../services/scentEngine";
import { flattenProfile } from "../services/catalogService";
import { logger } from "../lib/logger";

const router = Router();

async function getUserByToken(token: string) {
  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.token, token as any))
    .limit(1);
  return users[0] ?? null;
}

function getToken(req: any): string | null {
  const auth = req.headers["authorization"] as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

/** Strip base64 data URLs — they're huge and already stored in the global catalog */
function sanitizeFragrance(fragrance: Record<string, any>): Record<string, any> {
  const clean = { ...fragrance };
  if (typeof clean.imageUrl === "string" && clean.imageUrl.startsWith("data:")) {
    clean.imageUrl = "";
  }
  return clean;
}

/**
 * Older inserts stored a raw ScentProfile (only `product.name`/`product.brand`).
 * Surface the canonical top-level fields the dashboard expects so legacy rows
 * stop falling through the `if (!item.name || !item.brand)` filter on the client.
 */
function normalizeFragrance(fragrance: Record<string, any>): Record<string, any> {
  const product = fragrance.product as Record<string, any> | undefined;
  const name = fragrance.name || product?.name;
  const brand = fragrance.brand || product?.brand;
  const perfumer = fragrance.perfumer || product?.perfumer;

  return {
    ...fragrance,
    ...(name ? { name } : {}),
    ...(brand ? { brand } : {}),
    ...(perfumer ? { perfumer } : {}),
  };
}

/** Fill in imageUrl from the global catalog if the stored record has none */
async function hydrateImageUrl(fragrance: Record<string, any>): Promise<Record<string, any>> {
  if (fragrance.imageUrl) return fragrance;
  const name = fragrance.name as string | undefined;
  const brand = fragrance.brand as string | undefined;
  if (!name || !brand) return fragrance;
  try {
    const imageUrl = await resolveSharedImageUrl(brand, name);
    if (imageUrl) return { ...fragrance, imageUrl };
  } catch {
    /* non-fatal */
  }
  return fragrance;
}

router.get("/wardrobe", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(eq(userFragrancesTable.userId, user.id));

  // #region agent log
  fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6001a3'},body:JSON.stringify({sessionId:'6001a3',hypothesisId:'A_data_audit',location:'wardrobe.ts:GET /wardrobe',message:'rows fetched from user_fragrances',data:{userEmail:user.email,userId:user.id,rowCount:rows.length,rowSummaries:rows.map(r=>{const d=r.fragranceData as Record<string,any>;return {dbId:r.id,topName:d?.name??null,topBrand:d?.brand??null,productName:d?.product?.name??null,productBrand:d?.product?.brand??null,hasImageUrl:Boolean(d?.imageUrl),imageUrlLen:typeof d?.imageUrl==='string'?d.imageUrl.length:0,imageUrlKind:typeof d?.imageUrl==='string'?(d.imageUrl.startsWith('data:')?'data':d.imageUrl.startsWith('http')?'http':d.imageUrl===''?'empty':'other'):'missing',shareHidden:Boolean(d?.shareHidden)};})},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  const fragrances = await Promise.all(
    rows.map(async (r) => {
      const data = normalizeFragrance(r.fragranceData as Record<string, any>);
      const hydrated = await hydrateImageUrl(data);
      // #region agent log
      fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6001a3'},body:JSON.stringify({sessionId:'6001a3',hypothesisId:'A_data_audit',location:'wardrobe.ts:GET /wardrobe row',message:'post-normalize+hydrate row',data:{dbId:r.id,name:hydrated?.name??null,brand:hydrated?.brand??null,hasImageUrl:Boolean(hydrated?.imageUrl),imageUrlKind:typeof hydrated?.imageUrl==='string'?(hydrated.imageUrl.startsWith('data:')?'data':hydrated.imageUrl.startsWith('http')?'http':hydrated.imageUrl===''?'empty':'other'):'missing'},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      return { ...hydrated, _dbId: r.id };
    })
  );

  res.json(fragrances);
});

router.post("/wardrobe", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const fragrance = req.body;
  if (!fragrance || !fragrance.id) {
    res.status(400).json({ error: "Fragrance data with id is required" });
    return;
  }

  const clean = sanitizeFragrance(normalizeFragrance(fragrance));

  const [row] = await db
    .insert(userFragrancesTable)
    .values({ userId: user.id, fragranceData: clean })
    .returning();

  const hydrated = await hydrateImageUrl(row.fragranceData as Record<string, any>);
  res.json({ ...hydrated, _dbId: row.id });
});

/**
 * Rebuild every fragrance in the caller's vault. Re-runs the full profile
 * pipeline (catalog → fuzzy → scrape → image cache) so legacy rows that were
 * persisted before the catalog existed (or that lost top-level name/brand)
 * become first-class records again. Idempotent: catalog hits short-circuit,
 * so re-running on a healthy vault is cheap.
 */
router.post("/wardrobe/rebuild", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(eq(userFragrancesTable.userId, user.id));

  const failures: { id: string; reason: string }[] = [];
  let rebuilt = 0;
  let skipped = 0;

  for (const r of rows) {
    const data = r.fragranceData as Record<string, any>;
    const name = (data.name as string | undefined) || (data.product?.name as string | undefined);
    const brand = (data.brand as string | undefined) || (data.product?.brand as string | undefined);

    if (!name || !brand) {
      skipped++;
      failures.push({ id: r.id, reason: "missing name/brand" });
      continue;
    }

    try {
      const profile = await buildProfile(name, brand, {
        notes: Array.isArray(data.notes) ? data.notes : undefined,
        family: typeof data.family === "string" ? data.family : undefined,
        description: typeof data.description === "string" ? data.description : undefined,
        pyramid: data.pyramid,
        perfumer:
          (typeof data.perfumer === "string" && data.perfumer) ||
          (typeof data.product?.perfumer === "string" ? data.product.perfumer : undefined),
        imageUrl: typeof data.imageUrl === "string" ? data.imageUrl : undefined,
      });

      // #region agent log
      fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6001a3'},body:JSON.stringify({sessionId:'6001a3',hypothesisId:'D_rebuild_overwrite',location:'wardrobe.ts:rebuild row',message:'buildProfile result vs input',data:{dbId:r.id,inputName:name,inputBrand:brand,outputName:('product' in profile)?profile.product?.name:null,outputBrand:('product' in profile)?profile.product?.brand:null,nameDrift:('product' in profile)?(profile.product?.name??'').toLowerCase()!==name.toLowerCase():null,brandDrift:('product' in profile)?(profile.product?.brand??'').toLowerCase()!==brand.toLowerCase():null,hasError:!('product' in profile),errorMsg:!('product' in profile)?profile.error:null,outputImageKind:('product' in profile && typeof profile.imageUrl==='string')?(profile.imageUrl.startsWith('data:')?'data':profile.imageUrl.startsWith('http')?'http':'empty'):'missing'},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      if (!("product" in profile)) {
        skipped++;
        failures.push({ id: r.id, reason: profile.error });
        continue;
      }

      const flat = flattenProfile(profile);
      const flatImageUrl = typeof flat.imageUrl === "string" ? flat.imageUrl : "";
      const merged = sanitizeFragrance({
        ...data,
        ...flat,
        // Don't overwrite a real stored URL with an empty one if the rebuild
        // didn't manage to resolve a fresh image (e.g. Firestore cache miss).
        imageUrl: flatImageUrl || (typeof data.imageUrl === "string" ? data.imageUrl : ""),
        id: typeof data.id === "string" ? data.id : r.id,
        season: typeof data.season === "string" && data.season ? data.season : "Universal",
        intents: data.intents,
        energies: data.energies,
        shareHidden: data.shareHidden,
      });

      await db
        .update(userFragrancesTable)
        .set({ fragranceData: merged as any })
        .where(eq(userFragrancesTable.id, r.id));
      rebuilt++;
    } catch (err: any) {
      logger.warn({ err: err?.message, id: r.id }, "wardrobe/rebuild: row failed");
      skipped++;
      failures.push({ id: r.id, reason: err?.message ?? "rebuild error" });
    }
  }

  res.json({ total: rows.length, rebuilt, skipped, failures });
});

router.patch("/wardrobe/:fragranceId/visibility", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const { fragranceId } = req.params;
  const { shareHidden } = req.body as { shareHidden?: boolean };
  if (typeof shareHidden !== "boolean") {
    res.status(400).json({ error: "shareHidden (boolean) is required" });
    return;
  }

  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(eq(userFragrancesTable.userId, user.id));

  const match = rows.find((r) => {
    const data = r.fragranceData as any;
    return data?.id === fragranceId || r.id === fragranceId;
  });

  if (!match) { res.status(404).json({ error: "Fragrance not found" }); return; }

  const existing = match.fragranceData as Record<string, any>;
  const updated = { ...existing, shareHidden };

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: updated as any })
    .where(eq(userFragrancesTable.id, match.id));

  res.json({ id: fragranceId, shareHidden });
});

router.delete("/wardrobe/:id", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const { id } = req.params;

  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(eq(userFragrancesTable.userId, user.id));

  const match = rows.find((r) => {
    const data = r.fragranceData as any;
    return data?.id === id || r.id === id;
  });

  if (!match) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await db
    .delete(userFragrancesTable)
    .where(eq(userFragrancesTable.id, match.id));

  res.json({ success: true });
});

export default router;
