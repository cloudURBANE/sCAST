import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userFragrancesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { resolveSharedImageUrl, usableImageUrlForResponse } from "../services/imageHydration";
import { buildProfile } from "../services/scentEngine";
import { flattenProfile } from "../services/catalogService";
import { logger } from "../lib/logger";
import { hydrateImageUrl, normalizeFragrance, sanitizeFragrance } from "../services/fragrancePayload";
import { assertNoPersistedBase64Image } from "../services/persistenceGuards";

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
      const data = normalizeFragrance(r.fragranceData as Record<string, any>);
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

  const clean = sanitizeFragrance(normalizeFragrance(fragrance));
  assertNoPersistedBase64Image(clean, "user_fragrances.fragrance_data");

  const [row] = await db
    .insert(userFragrancesTable)
    .values({ userId: user.id, fragranceData: clean })
    .returning();

  const inserted = sanitizeFragrance(normalizeFragrance(row.fragranceData as Record<string, any>));
  const hydrated = await hydrateImageUrl(inserted);
  res.json({ ...hydrated, _dbId: row.id });
});

/**
 * Rebuild every fragrance in the caller's vault. Re-runs the full profile
 * pipeline (catalog → fuzzy → scrape → image cache) so legacy rows that were
 * persisted before the catalog existed (or that lost top-level name/brand)
 * become first-class records again. Idempotent: catalog hits short-circuit,
 * so re-running on a healthy vault is cheap.
 *
 * Display sizing of bottle images is purely client-side CSS; rebuild updates stored
 * URLs and profile fields, not bitmap dimensions in the browser.
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
      const profile = await buildProfile(
        name,
        brand,
        {
          notes: Array.isArray(data.notes) ? data.notes : undefined,
          family: typeof data.family === "string" ? data.family : undefined,
          description: typeof data.description === "string" ? data.description : undefined,
          pyramid: data.pyramid,
          perfumer:
            (typeof data.perfumer === "string" && data.perfumer) ||
            (typeof data.product?.perfumer === "string" ? data.product.perfumer : undefined),
          imageUrl: typeof data.imageUrl === "string" ? data.imageUrl : undefined,
        },
        // B2: never let a substring catalog match swap the user's fragrance
        // for a different product during rebuild.
        { allowCatalogFuzzy: false },
      );

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
        // Pin the user's name/brand. The catalog row may have a slightly
        // different display string (case, trailing edition tags) but the
        // rebuild must never relabel a row.
        name,
        brand,
        product: {
          ...(typeof flat.product === "object" && flat.product ? flat.product : {}),
          name,
          brand,
        },
        // Don't overwrite a real stored URL with an empty one if the rebuild
        // didn't manage to resolve a fresh image (e.g. metadata/object cache miss).
        imageUrl: flatImageUrl || (typeof data.imageUrl === "string" ? data.imageUrl : ""),
        id: typeof data.id === "string" ? data.id : r.id,
        season: typeof data.season === "string" && data.season ? data.season : "Universal",
        intents: data.intents,
        energies: data.energies,
        shareHidden: data.shareHidden,
      });
      assertNoPersistedBase64Image(merged, "user_fragrances.fragrance_data");

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

/**
 * Resolve a wardrobe row owned by `userId`. Prefers the DB primary key
 * (the canonical, unique `_dbId` the GET response surfaces). Falls back
 * to matching `fragrance_data.id` only when the param doesn't look like
 * a UUID, so legacy clients that still send the `Math.random()`-based id
 * keep working but the DB UUID is always tried first (B9).
 */
function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function persistableImageReference(value: unknown): Promise<string | null> {
  const url = await usableImageUrlForResponse(value);
  if (!url) return null;
  if (url.startsWith("/api/image-objects/")) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

async function findUserRow(userId: string, idParam: string) {
  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(eq(userFragrancesTable.userId, userId));

  if (isUuidish(idParam)) {
    const byDbId = rows.find(r => r.id === idParam);
    if (byDbId) return byDbId;
  }
  return rows.find(r => {
    const data = r.fragranceData as any;
    return data?.id === idParam;
  });
}

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

  const match = await findUserRow(user.id, fragranceId);
  if (!match) { res.status(404).json({ error: "Fragrance not found" }); return; }

  const existing = match.fragranceData as Record<string, any>;
  const updated = sanitizeFragrance({ ...existing, shareHidden });
  assertNoPersistedBase64Image(updated, "user_fragrances.fragrance_data");

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: updated as any })
    .where(eq(userFragrancesTable.id, match.id));

  res.json({ id: fragranceId, shareHidden });
});

/**
 * Merge the latest bottle image from the global catalog / cache into this vault row.
 * Use after `/api/refresh-image` so the client does not rely on ephemeral local state.
 */
router.patch("/wardrobe/:id", async (req, res) => {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = await getUserByToken(token);
  if (!user) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  const { syncImageFromCatalog, imageUrl } = req.body as {
    syncImageFromCatalog?: boolean;
    imageUrl?: unknown;
  };
  const explicitImageUrl = await persistableImageReference(imageUrl);
  if (syncImageFromCatalog !== true && !explicitImageUrl) {
    res.status(400).json({ error: "syncImageFromCatalog: true or a valid imageUrl is required" });
    return;
  }
  if (typeof imageUrl === "string" && imageUrl.trim() && !explicitImageUrl) {
    res.status(400).json({ error: "imageUrl must be an http(s) URL or an existing /api/image-objects/... URL" });
    return;
  }

  const match = await findUserRow(user.id, req.params.id);
  if (!match) {
    res.status(404).json({ error: "Fragrance not found" });
    return;
  }

  const existing = normalizeFragrance(match.fragranceData as Record<string, any>);
  const name = existing.name as string | undefined;
  const brand = existing.brand as string | undefined;
  if (!name || !brand) {
    res.status(400).json({ error: "Fragrance must have name and brand to sync image" });
    return;
  }

  let url: string | null = null;
  if (explicitImageUrl) {
    url = explicitImageUrl;
  } else {
    try {
      url = await resolveSharedImageUrl(brand, name);
    } catch {
      url = null;
    }
  }

  if (!url || typeof url !== "string" || !url.trim()) {
    res.status(409).json({ error: "No catalog image available yet for this fragrance; try refresh again." });
    return;
  }

  const merged = sanitizeFragrance(normalizeFragrance({ ...existing, imageUrl: url }));
  assertNoPersistedBase64Image(merged, "user_fragrances.fragrance_data");

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: merged as any })
    .where(eq(userFragrancesTable.id, match.id));

  const hydrated = normalizeFragrance(await hydrateImageUrl(merged));
  res.json({ ...hydrated, _dbId: match.id });
});

router.delete("/wardrobe/:id", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const user = await getUserByToken(token);
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const { id } = req.params;

  const match = await findUserRow(user.id, id);

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
