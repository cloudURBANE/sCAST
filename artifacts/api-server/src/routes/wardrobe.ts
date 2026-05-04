import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userFragrancesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { getCatalogEntry, saveCatalogEntry, flattenProfile } from "../services/catalogService";
import { ai } from "@workspace/integrations-gemini-ai";
import { logger } from "../lib/logger";
import type { ScentProfile } from "../services/scentEngine";

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

/** Fill in imageUrl from the global catalog if the stored record has none */
async function hydrateImageUrl(fragrance: Record<string, any>): Promise<Record<string, any>> {
  if (fragrance.imageUrl) return fragrance;
  const name = fragrance.name as string | undefined;
  const brand = fragrance.brand as string | undefined;
  if (!name || !brand) return fragrance;
  try {
    const catalog = await getCatalogEntry(brand, name);
    if (catalog?.imageUrl) return { ...fragrance, imageUrl: catalog.imageUrl };
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

  const fragrances = await Promise.all(
    rows.map(async (r) => {
      const data = r.fragranceData as Record<string, any>;
      const hydrated = await hydrateImageUrl(data);
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

  const clean = sanitizeFragrance(fragrance);

  const [row] = await db
    .insert(userFragrancesTable)
    .values({ userId: user.id, fragranceData: clean })
    .returning();

  const hydrated = await hydrateImageUrl(row.fragranceData as Record<string, any>);
  res.json({ ...hydrated, _dbId: row.id });
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

router.post("/wardrobe/:fragranceId/synthesize", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const { fragranceId } = req.params;

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
  const name = existing.name as string;
  const brand = existing.brand as string;

  if (!name || !brand) { res.status(400).json({ error: "Missing name or brand" }); return; }

  try {
    const synthesisPrompt = `You are an expert perfumer and olfactory scientist. Perform a deep synthesis analysis for the fragrance "${name}" by ${brand}.

Using your expert knowledge, provide the most accurate and comprehensive profile possible. Return a JSON object with these exact fields:
{
  "name": "${name}",
  "brand": "${brand}",
  "perfumer": "the nose who created it, or empty string",
  "family": "primary fragrance family (Woody, Floral, Oriental, Fresh, Citrus, Fougere, Chypre, Gourmand, Amber, Aquatic)",
  "concentration": "Eau de Parfum / Eau de Toilette / Parfum / Cologne / etc",
  "notes": ["complete", "flat", "list", "of", "all", "olfactory", "notes"],
  "description": "two to three sentence expert description of scent character, personality, and signature",
  "pyramid": {
    "top": ["top note 1", "top note 2"],
    "heart": ["heart note 1", "heart note 2"],
    "base": ["base note 1", "base note 2", "base note 3"]
  },
  "accords": ["dominant accord 1", "dominant accord 2", "dominant accord 3"],
  "scent_vector": {
    "freshness": 0,
    "sweetness": 0,
    "woodiness": 0,
    "spice": 0,
    "warmth": 0,
    "musk": 0
  },
  "performance": {
    "sillage": 0,
    "longevity": 0
  },
  "season": "Spring / Summer / Fall / Winter / Year-Round"
}

For scent_vector: score each dimension 0-10 based on how prominent that characteristic is (0 = absent, 10 = extremely dominant).
For performance: sillage = projection strength (0-10), longevity = how long it lasts (0-10).
Only return valid JSON, no markdown or extra text.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: synthesisPrompt }] }],
      config: { responseMimeType: "application/json" }
    });

    const text = response.text ?? "";
    let enriched: any;
    try {
      enriched = JSON.parse(text);
    } catch {
      const match2 = text.match(/\{[\s\S]*\}/);
      if (match2) {
        try { enriched = JSON.parse(match2[0]); }
        catch { res.status(500).json({ error: "Failed to parse AI synthesis response" }); return; }
      } else {
        res.status(500).json({ error: "Failed to parse AI synthesis response" }); return;
      }
    }

    const existingCatalog = await getCatalogEntry(brand, name);
    const imageUrl = existingCatalog?.imageUrl ?? existing.imageUrl ?? "";

    const synthesizedProfile: ScentProfile = {
      product: {
        name: enriched.name ?? name,
        brand: enriched.brand ?? brand,
        ...(enriched.perfumer ? { perfumer: enriched.perfumer } : {}),
      },
      scent_vector: {
        freshness: Number(enriched.scent_vector?.freshness ?? 5),
        sweetness: Number(enriched.scent_vector?.sweetness ?? 5),
        woodiness: Number(enriched.scent_vector?.woodiness ?? 5),
        spice: Number(enriched.scent_vector?.spice ?? 5),
        warmth: Number(enriched.scent_vector?.warmth ?? 5),
        musk: Number(enriched.scent_vector?.musk ?? 5),
      },
      performance: {
        sillage: Number(enriched.performance?.sillage ?? 6),
        longevity: Number(enriched.performance?.longevity ?? 7),
      },
      context: existingCatalog?.context ?? {
        weather: ["Universal"],
        occasion: ["Daily Wear", "Universal"],
      },
      notes: enriched.notes ?? existing.notes ?? [],
      pyramid: enriched.pyramid ?? existing.pyramid,
      family: enriched.family ?? existing.family ?? "Unknown",
      concentration: enriched.concentration ?? existing.concentration ?? "Eau de Parfum",
      accords: enriched.accords ?? existing.accords ?? [],
      imageUrl,
      description: enriched.description ?? existing.description ?? "",
    };

    await saveCatalogEntry(brand, name, synthesizedProfile);

    const flat = flattenProfile(synthesizedProfile);
    const updatedFragranceData = {
      ...existing,
      ...flat,
      id: existing.id,
      synthesized: true,
      season: enriched.season ?? existing.season ?? "Year-Round",
    };

    await db
      .update(userFragrancesTable)
      .set({ fragranceData: updatedFragranceData as any })
      .where(eq(userFragrancesTable.id, match.id));

    res.json(updatedFragranceData);
  } catch (err: any) {
    logger.error({ err: err.message }, "synthesize: failed");
    res.status(500).json({ error: err.message || "Synthesis failed" });
  }
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
