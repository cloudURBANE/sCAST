import { Router } from "express";
import { randomUUID } from "node:crypto";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { db } from "@workspace/db";
import {
  imageCacheTable,
  userFragrancesTable,
} from "@workspace/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { resolveSharedImageUrl } from "../services/imageHydration";
import { rebuildWardrobeForUser } from "../services/wardrobeRebuild";
import { logger } from "../lib/logger";
import {
  batchHydrateImageUrls,
  hydrateImageUrl,
  normalizeFragrance,
  normalizeImageAdjustment,
  sanitizeFragrance,
  slimListFragranceData,
} from "../services/fragrancePayload";
import { assertNoPersistedBase64Image } from "../services/persistenceGuards";
import { nonPerfumeSignal } from "../services/nonPerfumeSignal";
import { persistableImageReference } from "../services/imageReference";
import {
  detailRefreshPatchFromBody,
  hasDetailRefreshPayload,
} from "../services/wardrobeDetailFacts";
import { wardrobeVersionEtag } from "../services/wardrobeVersion";

const router = Router();

async function findUserRowByClientId(tenantId: string, userId: string, clientId: string) {
  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, userId),
      sql`${userFragrancesTable.fragranceData}->>'id' = ${clientId}`,
    ))
    .limit(1);
  return rows[0] ?? null;
}

function stripImageVersionParam(value: string): string {
  try {
    const parsed = new URL(value, "http://local.invalid");
    parsed.searchParams.delete("v");
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? parsed.toString() : path;
  } catch {
    return value;
  }
}

function sourceProviderFromImageCacheRow(image: typeof imageCacheTable.$inferSelect | undefined): string | undefined {
  if (!image) return undefined;
  if (image.sourceProvider === "openai" || image.sourceUrl.startsWith("openai-reimagine:")) {
    return "openai";
  }
  return image.sourceProvider || undefined;
}

async function imageMetadataPatchForUrl(url: string): Promise<Record<string, unknown>> {
  const canonicalUrl = stripImageVersionParam(url);
  const rows = await db
    .select()
    .from(imageCacheTable)
    .where(eq(imageCacheTable.publicUrl, canonicalUrl))
    .orderBy(desc(imageCacheTable.lastUsedAt), desc(imageCacheTable.createdAt))
    .limit(1);
  const image = rows[0];
  const sourceProvider = sourceProviderFromImageCacheRow(image);
  return {
    imageUrl: canonicalUrl,
    ...(image?.storagePath ? { storagePath: image.storagePath } : {}),
    ...(image?.contentHash ? { imageHash: image.contentHash } : {}),
    ...(image?.storageProvider ? { storageProvider: image.storageProvider } : {}),
    ...(sourceProvider ? { sourceProvider } : {}),
  };
}

router.get("/wardrobe", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  // Conditional GET to kill idle-poll egress. The background poll hits this
  // endpoint every 60s per open tab; when nothing changed, re-running the heavy
  // select + image hydration below (and shipping it over the metered Supabase ->
  // Express hop) is pure waste. So first compute a cheap version key from
  // count(*) + max(updated_at) over just this user's rows and answer 304 when it
  // matches the client's If-None-Match — before touching fragrance_data.
  //
  // The key intentionally covers only user_fragrances changes (add/edit/remove),
  // not image_cache hydration: the client sends If-None-Match ONLY on the
  // steady-state interval tick, while focus/visibility and initial loads fetch
  // unconditionally, so returning to a tab still re-runs hydration and picks up
  // any opportunistic image improvement. no-store keeps the browser cache out of
  // our manually managed ETag round-trip.
  const [version] = await db
    .select({
      count: sql<number>`count(*)::int`,
      maxUpdated: sql<string | null>`max(${userFragrancesTable.updatedAt})`,
    })
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, user.id),
    ));

  const etag = wardrobeVersionEtag(version?.count ?? 0, version?.maxUpdated ?? null);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, no-store");
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }

  // Egress: project away the heavy `raw.reviews`/`raw.description` text in
  // Postgres so the (frequently polled) wardrobe payload stays small over the
  // Supabase -> Express hop. Reviews are refetched per-item on detail open via
  // GET /wardrobe/:id/reviews. See slimListFragranceData for why this must be a
  // SQL projection, not a post-fetch object trim.
  const rows = await db
    .select({
      id: userFragrancesTable.id,
      fragranceData: slimListFragranceData(userFragrancesTable.fragranceData),
    })
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, user.id),
    ));

  const normalized = rows.map((r) => normalizeFragrance(r.fragranceData as Record<string, any>));
  const hydrated = await batchHydrateImageUrls(normalized);
  const fragrances = hydrated.map((data, i) => ({ ...data, _dbId: rows[i]!.id }));

  res.json(fragrances);
});

/**
 * Reviews for a single wardrobe row, on demand. The list/poll responses strip
 * the heavy scraped review text (see slimListFragranceData), so the detail
 * modal fetches it here only for the one item the user actually opens. Projects
 * just the reviews JSON path so we never re-pull the whole blob.
 */
router.get("/wardrobe/:id/reviews", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);
  const id = String(req.params.id ?? "").trim();
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }

  const rows = await db
    .select({
      reviews: sql<unknown>`${userFragrancesTable.fragranceData} #> '{raw_engine_detail,raw,reviews}'`,
    })
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, user.id),
      isUuidish(id)
        ? eq(userFragrancesTable.id, id as any)
        : sql`${userFragrancesTable.fragranceData}->>'id' = ${id}`,
    ))
    .limit(1);

  if (rows.length === 0) {
    res.status(404).json({ error: "Fragrance not found" });
    return;
  }

  const raw = rows[0]!.reviews;
  res.json({ reviews: Array.isArray(raw) ? raw : [] });
});

router.post("/wardrobe", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

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

  // Companion to the engine's non-perfume ingest gate: keep body-care products
  // (lotions, mists, washes, candles) and test fixtures out of the wardrobe.
  // The classifier never flags an item that resolved to a real perfume page, so
  // this is safe to apply to every write. The id is opaque but may embed a
  // `source:<url>`, so it doubles as a real-perfume-page guard.
  const signal = nonPerfumeSignal(clean.name, clean.brand, [
    clean.source_url,
    clean.sourceUrl,
    clientId,
  ]);
  if (signal.flagged) {
    logger.info(
      { reason: signal.reason, name: clean.name, brand: clean.brand },
      "wardrobe add rejected: non-perfume",
    );
    res.status(422).json({ error: "Only fragrances can be added to the wardrobe", reason: signal.reason });
    return;
  }

  const existing = await findUserRowByClientId(tenantId, user.id, clientId);
  if (existing) {
    const existingData = normalizeFragrance(existing.fragranceData as Record<string, any>);
    const merged = sanitizeFragrance({ ...existingData, ...clean, id: existing.id });
    assertNoPersistedBase64Image(merged, "user_fragrances.fragrance_data");
    await db
      .update(userFragrancesTable)
      .set({ fragranceData: merged as any })
      .where(and(
        eq(userFragrancesTable.tenantId, tenantId),
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
    .values({ id: rowId as any, tenantId, userId: user.id, fragranceData: cleanWithUuid })
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
  const summary = await rebuildWardrobeForUser(getTenantId(req), req.user!.id);
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

async function findUserRow(tenantId: string, userId: string, idParam: string) {
  if (isUuidish(idParam)) {
    const rows = await db
      .select()
      .from(userFragrancesTable)
      .where(and(
        eq(userFragrancesTable.tenantId, tenantId),
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
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, userId),
      sql`${userFragrancesTable.fragranceData}->>'id' = ${idParam}`,
    ))
    .limit(1);
  return rows[0] ?? null;
}

router.patch("/wardrobe/:fragranceId/visibility", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  const fragranceId = req.params.fragranceId as string;
  const { shareHidden } = req.body as { shareHidden?: boolean };
  if (typeof shareHidden !== "boolean") {
    res.status(400).json({ error: "shareHidden (boolean) is required" });
    return;
  }

  const match = await findUserRow(tenantId, user.id, fragranceId);
  if (!match) { res.status(404).json({ error: "Fragrance not found" }); return; }

  const existing = match.fragranceData as Record<string, any>;
  const updated = sanitizeFragrance({ ...existing, id: match.id, shareHidden });
  assertNoPersistedBase64Image(updated, "user_fragrances.fragrance_data");

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: updated as any })
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.id, match.id),
      eq(userFragrancesTable.userId, user.id),
    ));

  res.json({ id: fragranceId, shareHidden });
});

/**
 * A5-GAP5: stamp `fragrance_data.lastWornAt` when the user accepts/wears a
 * recommendation. Stored inside the existing jsonb (no migration), it powers the
 * recency penalty in the recommender so the same bottle doesn't surface every
 * similar day. Idempotent: always writes "now". Accepts an optional client
 * timestamp but clamps it to a sane window (no future, no ancient backdating).
 */
router.patch("/wardrobe/:fragranceId/worn", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  const fragranceId = req.params.fragranceId as string;
  const match = await findUserRow(tenantId, user.id, fragranceId);
  if (!match) { res.status(404).json({ error: "Fragrance not found" }); return; }

  const now = Date.now();
  const raw = (req.body ?? {}) as { wornAt?: unknown };
  const requested = typeof raw.wornAt === "string" ? Date.parse(raw.wornAt) : NaN;
  // Clamp: never in the future, never more than ~2 days stale (a late sync).
  const wornMs = Number.isFinite(requested)
    ? Math.min(now, Math.max(now - 2 * 24 * 60 * 60_000, requested))
    : now;
  const lastWornAt = new Date(wornMs).toISOString();

  const existing = match.fragranceData as Record<string, any>;
  const updated = sanitizeFragrance({ ...existing, id: match.id, lastWornAt });
  assertNoPersistedBase64Image(updated, "user_fragrances.fragrance_data");

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: updated as any })
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.id, match.id),
      eq(userFragrancesTable.userId, user.id),
    ));

  res.json({ id: fragranceId, lastWornAt });
});

router.patch("/wardrobe/detail-refresh/batch", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);
  const rawUpdates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  const updates = rawUpdates
    .filter((update: unknown): update is Record<string, unknown> => Boolean(update && typeof update === "object" && !Array.isArray(update)))
    .slice(0, 8);

  if (updates.length === 0) {
    res.status(400).json({ error: "updates must contain at least one detail refresh payload" });
    return;
  }

  const items: Array<Record<string, unknown>> = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const update of updates) {
    const id = typeof update.id === "string" ? update.id.trim() : "";
    if (!id || !hasDetailRefreshPayload(update)) {
      errors.push({ id: id || "unknown", error: "Missing id or detail refresh payload" });
      continue;
    }

    try {
      const match = await findUserRow(tenantId, user.id, id);
      if (!match) {
        errors.push({ id, error: "Fragrance not found" });
        continue;
      }

      const existing = normalizeFragrance(match.fragranceData as Record<string, any>);
      const merged = sanitizeFragrance(
        normalizeFragrance({
          ...existing,
          ...detailRefreshPatchFromBody(update),
          id: match.id,
        }),
      );
      assertNoPersistedBase64Image(merged, "user_fragrances.fragrance_data");

      await db
        .update(userFragrancesTable)
        .set({ fragranceData: merged as any })
        .where(and(
          eq(userFragrancesTable.tenantId, tenantId),
          eq(userFragrancesTable.id, match.id),
          eq(userFragrancesTable.userId, user.id),
        ));

      const hydrated = normalizeFragrance(await hydrateImageUrl(merged));
      items.push({ ...hydrated, _dbId: match.id });
    } catch (err) {
      logger.warn({ err, id }, "wardrobe detail-refresh batch item failed");
      errors.push({ id, error: err instanceof Error ? err.message : "Update failed" });
    }
  }

  res.json({ items, errors });
});

/**
 * Merge the latest bottle image from the global catalog / cache into this vault row.
 * Use after `/api/refresh-image` so the client does not rely on ephemeral local state.
 */
router.patch("/wardrobe/:id", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  const { syncImageFromCatalog, imageUrl, imageAdjustment } = req.body as {
    syncImageFromCatalog?: boolean;
    imageUrl?: unknown;
    imageAdjustment?: unknown;
  } & Record<string, unknown>;
  const explicitImageUrl = await persistableImageReference(imageUrl);
  const hasImageAdjustment = imageAdjustment !== undefined;
  const hasDetailRefresh = hasDetailRefreshPayload(req.body);
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

  const match = await findUserRow(tenantId, user.id, req.params.id as string);
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
  let imagePatch: Record<string, unknown> = {};
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
    imagePatch = await imageMetadataPatchForUrl(url);

    // A user who explicitly picks/saves a specific image (via the bottle image
    // selector, refresh, or reimagine) is making a deliberate, authoritative
    // choice for their own vault row. Stamp it as "manual" so hydrateImageUrl
    // treats the saved row image as authoritative and does NOT override it with
    // a previously cached generated/openai-reimagined image for the same
    // fragrance. Without this, choosing a new bottle image for a fragrance that
    // was once "reimagined" silently reverts to the old reimagined image on the
    // next hydrate (PATCH response) and on the 60s wardrobe poll, because the
    // freshly-picked image's own provider (e.g. "serper") loses to the shared
    // reimagined cache in chooseHydratedImageUrlWithMetadata.
    //
    // This only applies to explicit picks — the syncImageFromCatalog-only path
    // (no explicitImageUrl) keeps the resolved provider so auto-populated rows
    // can still be upgraded by a better generated cache later.
    if (explicitImageUrl) {
      imagePatch.sourceProvider = "manual";
    }
  }

  const detailPatch = detailRefreshPatchFromBody(req.body);

  const merged = sanitizeFragrance(
    normalizeFragrance({
      ...existing,
      ...detailPatch,
      id: match.id,
      ...(shouldUpdateImage && url ? imagePatch : {}),
      ...(hasImageAdjustment ? { imageAdjustment: normalizedImageAdjustment } : {}),
    }),
  );
  assertNoPersistedBase64Image(merged, "user_fragrances.fragrance_data");

  await db
    .update(userFragrancesTable)
    .set({ fragranceData: merged as any })
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.id, match.id),
      eq(userFragrancesTable.userId, user.id),
    ));

  const hydrated = normalizeFragrance(await hydrateImageUrl(merged));
  res.json({ ...hydrated, _dbId: match.id });
});

router.delete("/wardrobe/:id", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const tenantId = getTenantId(req);

  const id = req.params.id as string;

  const match = await findUserRow(tenantId, user.id, id);

  if (!match) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    await db
      .delete(userFragrancesTable)
      .where(and(
        eq(userFragrancesTable.tenantId, tenantId),
        eq(userFragrancesTable.id, match.id),
        eq(userFragrancesTable.userId, user.id),
      ));
  } catch (err: any) {
    logger.error(
      { err: err?.message, userId: user.id, rowId: match.id },
      "wardrobe/delete: user row delete failed",
    );
    res.status(500).json({ error: "Failed to delete wardrobe item" });
    return;
  }

  res.json({ success: true });
});

export default router;
