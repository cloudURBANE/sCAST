import { Router } from "express";
import { randomUUID } from "node:crypto";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { db } from "@workspace/db";
import {
  globalFragrancesTable,
  imageCacheTable,
  userFragrancesTable,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { resolveSharedImageUrl } from "../services/imageHydration";
import { makeLookupKey } from "../services/catalogService";
import { rebuildWardrobeForUser } from "../services/wardrobeRebuild";
import { logger } from "../lib/logger";
import {
  hydrateImageUrl,
  normalizeFragrance,
  normalizeImageAdjustment,
  sanitizeFragrance,
} from "../services/fragrancePayload";
import { assertNoPersistedBase64Image } from "../services/persistenceGuards";
import { persistableImageReference } from "../services/imageReference";
import { deleteCachedImage } from "../services/firebaseCache";
import { getImageObjectStorage } from "../services/imageObjectStorage";

const router = Router();

async function findUserRowByClientId(userId: string, clientId: string) {
  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.userId, userId),
      sql`${userFragrancesTable.fragranceData}->>'id' = ${clientId}`,
    ))
    .limit(1);
  return rows[0] ?? null;
}

router.get("/wardrobe", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;

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

router.post("/wardrobe", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;

  const fragrance = req.body;
  if (!fragrance || !fragrance.id) {
    res.status(400).json({ error: "Fragrance data with id is required" });
    return;
  }

  const clean = sanitizeFragrance(normalizeFragrance(fragrance));
  assertNoPersistedBase64Image(clean, "user_fragrances.fragrance_data");
  const clientId = typeof clean.id === "string" ? clean.id.trim() : "";
  if (!clientId) {
    res.status(400).json({ error: "Fragrance data with id is required" });
    return;
  }

  const existing = await findUserRowByClientId(user.id, clientId);
  if (existing) {
    const existingData = normalizeFragrance(existing.fragranceData as Record<string, any>);
    const merged = sanitizeFragrance({ ...existingData, ...clean, id: existing.id });
    assertNoPersistedBase64Image(merged, "user_fragrances.fragrance_data");
    await db
      .update(userFragrancesTable)
      .set({ fragranceData: merged as any })
      .where(and(
        eq(userFragrancesTable.id, existing.id),
        eq(userFragrancesTable.userId, user.id),
      ));

    const hydrated = await hydrateImageUrl(merged);
    res.json({ ...hydrated, _dbId: existing.id });
    return;
  }

  let rowId: string;
  if (isUuidish(clientId)) {
    rowId = clientId;
  } else {
    rowId = randomUUID();
  }
  const cleanWithUuid = { ...clean, id: rowId };

  const [row] = await db
    .insert(userFragrancesTable)
    .values({ id: rowId as any, userId: user.id, fragranceData: cleanWithUuid })
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
router.post("/wardrobe/rebuild", requireAuth, async (req: AuthRequest, res) => {
  const summary = await rebuildWardrobeForUser(req.user!.id);
  res.json(summary);
});

/**
 * Resolve a wardrobe row owned by `userId`. Prefers the DB primary key
 * (the canonical, unique `_dbId` the GET response surfaces). If no DB row
 * has that UUID, falls back to `fragrance_data.id` so optimistic client rows
 * with UUID-shaped local IDs still work before the next GET refresh.
 */
function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function findUserRow(userId: string, idParam: string) {
  if (isUuidish(idParam)) {
    const rows = await db
      .select()
      .from(userFragrancesTable)
      .where(and(
        eq(userFragrancesTable.id, idParam as any),
        eq(userFragrancesTable.userId, userId),
      ))
      .limit(1);
    if (rows[0]) return rows[0];
  }

  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.userId, userId),
      sql`${userFragrancesTable.fragranceData}->>'id' = ${idParam}`,
    ))
    .limit(1);
  return rows[0] ?? null;
}

router.patch("/wardrobe/:fragranceId/visibility", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;

  const fragranceId = req.params.fragranceId as string;
  const { shareHidden } = req.body as { shareHidden?: boolean };
  if (typeof shareHidden !== "boolean") {
    res.status(400).json({ error: "shareHidden (boolean) is required" });
    return;
  }

  const match = await findUserRow(user.id, fragranceId);
  if (!match) { res.status(404).json({ error: "Fragrance not found" }); return; }

  const existing = match.fragranceData as Record<string, any>;
  const updated = sanitizeFragrance({ ...existing, id: match.id, shareHidden });
  assertNoPersistedBase64Image(updated, "user_fragrances.fragrance_data");

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: updated as any })
    .where(and(
      eq(userFragrancesTable.id, match.id),
      eq(userFragrancesTable.userId, user.id),
    ));

  res.json({ id: fragranceId, shareHidden });
});

/**
 * Merge the latest bottle image from the global catalog / cache into this vault row.
 * Use after `/api/refresh-image` so the client does not rely on ephemeral local state.
 */
router.patch("/wardrobe/:id", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;

  const { syncImageFromCatalog, imageUrl, imageAdjustment } = req.body as {
    syncImageFromCatalog?: boolean;
    imageUrl?: unknown;
    imageAdjustment?: unknown;
  } & Record<string, unknown>;
  const explicitImageUrl = await persistableImageReference(imageUrl);
  const hasImageAdjustment = imageAdjustment !== undefined;
  const hasDetailRefresh =
    Object.prototype.hasOwnProperty.call(req.body, "derived_metrics") ||
    Object.prototype.hasOwnProperty.call(req.body, "source_coverage") ||
    Object.prototype.hasOwnProperty.call(req.body, "enrichment") ||
    Object.prototype.hasOwnProperty.call(req.body, "raw_engine_detail");
  const normalizedImageAdjustment = normalizeImageAdjustment(imageAdjustment);
  if (syncImageFromCatalog !== true && !explicitImageUrl && !hasImageAdjustment && !hasDetailRefresh) {
    res.status(400).json({
      error:
        "syncImageFromCatalog: true, a valid imageUrl, imageAdjustment, or detail refresh payload is required",
    });
    return;
  }
  if (typeof imageUrl === "string" && imageUrl.trim() && !explicitImageUrl) {
    res.status(400).json({ error: "imageUrl must be an http(s) URL or an existing /api/image-objects/... URL" });
    return;
  }
  if (hasImageAdjustment && !normalizedImageAdjustment) {
    res.status(400).json({
      error:
        "imageAdjustment must be an object with numeric scale, x, y, and crop edges (cropTop, cropRight, cropBottom, cropLeft), or legacy uniform crop",
    });
    return;
  }

  const match = await findUserRow(user.id, req.params.id as string);
  if (!match) {
    res.status(404).json({ error: "Fragrance not found" });
    return;
  }

  const existing = normalizeFragrance(match.fragranceData as Record<string, any>);
  const name = existing.name as string | undefined;
  const brand = existing.brand as string | undefined;
  const shouldUpdateImage = syncImageFromCatalog === true || !!explicitImageUrl;
  if (shouldUpdateImage && (!name || !brand)) {
    res.status(400).json({ error: "Fragrance must have name and brand to sync image" });
    return;
  }

  let url: string | null = null;
  if (shouldUpdateImage) {
    if (explicitImageUrl) {
      url = explicitImageUrl;
    } else if (brand && name) {
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
  }

  const detailPatch: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(req.body, "derived_metrics")) {
    detailPatch.derived_metrics = req.body.derived_metrics ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "source_coverage")) {
    detailPatch.source_coverage = req.body.source_coverage ?? undefined;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "enrichment")) {
    detailPatch.enrichment = req.body.enrichment ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "raw_engine_detail")) {
    detailPatch.raw_engine_detail = req.body.raw_engine_detail ?? null;
  }

  const merged = sanitizeFragrance(
    normalizeFragrance({
      ...existing,
      ...detailPatch,
      id: match.id,
      ...(shouldUpdateImage && url ? { imageUrl: url } : {}),
      ...(hasImageAdjustment ? { imageAdjustment: normalizedImageAdjustment } : {}),
    }),
  );
  assertNoPersistedBase64Image(merged, "user_fragrances.fragrance_data");

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: merged as any })
    .where(and(
      eq(userFragrancesTable.id, match.id),
      eq(userFragrancesTable.userId, user.id),
    ));

  const hydrated = normalizeFragrance(await hydrateImageUrl(merged));
  res.json({ ...hydrated, _dbId: match.id });
});

router.delete("/wardrobe/:id", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;

  const id = req.params.id as string;

  const match = await findUserRow(user.id, id);

  if (!match) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const existing = normalizeFragrance(match.fragranceData as Record<string, any>);
  const name = (existing.name as string | undefined)?.trim()
    || (existing.product?.name as string | undefined)?.trim()
    || "";
  const brand = (existing.brand as string | undefined)?.trim()
    || (existing.product?.brand as string | undefined)?.trim()
    || "";
  const lookupKey = brand && name ? makeLookupKey(brand, name) : null;

  if (lookupKey) {
    // Coordination note for nearby changes:
    // The "delete from vault" contract is a full fragrance-set purge keyed by
    // lookupKey (`brand::name`) across Firestore (`bg_cache`), Supabase/Postgres
    // (`image_cache`, `global_fragrances`), and then the user's wardrobe row.
    // Keep this keying and ordering in sync with catalog/image pipeline changes.
    try {
      const cacheRows = await db
        .select({ storagePath: imageCacheTable.storagePath })
        .from(imageCacheTable)
        .where(eq(imageCacheTable.lookupKey, lookupKey));

      if (cacheRows.length > 0) {
        try {
          const storage = getImageObjectStorage();
          if (typeof storage.deleteObject === "function") {
            await Promise.all(
              cacheRows
                .map((row) => row.storagePath)
                .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
                .map(async (path) => storage.deleteObject?.(path)),
            );
          }
        } catch (err: any) {
          logger.warn(
            { err: err?.message, lookupKey },
            "wardrobe/delete: object-storage cleanup skipped",
          );
        }
      }

      await db
        .delete(imageCacheTable)
        .where(eq(imageCacheTable.lookupKey, lookupKey));

      await db
        .delete(globalFragrancesTable)
        .where(eq(globalFragrancesTable.lookupKey, lookupKey));

      await deleteCachedImage(brand, name);

      await db
        .delete(userFragrancesTable)
        .where(and(
          eq(userFragrancesTable.id, match.id),
          eq(userFragrancesTable.userId, user.id),
        ));
    } catch (err: any) {
      logger.error(
        { err: err?.message, lookupKey, userId: user.id, rowId: match.id },
        "wardrobe/delete: full purge failed",
      );
      res.status(500).json({ error: "Failed to fully delete fragrance set" });
      return;
    }
  } else {
    await db
      .delete(userFragrancesTable)
      .where(and(
        eq(userFragrancesTable.id, match.id),
        eq(userFragrancesTable.userId, user.id),
      ));
  }

  res.json({ success: true });
});

export default router;
