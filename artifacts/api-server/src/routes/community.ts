import { Router } from "express";
import { db } from "@workspace/db";
import { userFragrancesTable, userSettingsTable, usersTable } from "@workspace/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { batchHydrateImageUrls, normalizeFragrance, slimListFragranceData } from "../services/fragrancePayload";
import { shareHandleFromEmail } from "../services/shareIdentity";
import { getTenantId } from "../middlewares/tenant";

const router = Router();

const DEFAULT_LIMIT = 48;
const MAX_LIMIT = 96;
const FETCH_MULTIPLIER = 3;

function parseLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, parsed);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const strings = values
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
  return strings.length > 0 ? strings : undefined;
}

function noteList(fragrance: Record<string, any>, key: "top" | "heart" | "base"): string[] | undefined {
  const camelKey = `${key}Notes`;
  return (
    stringList(fragrance[camelKey]) ??
    stringList(fragrance.pyramid?.[key]) ??
    stringList(fragrance.raw_engine_detail?.raw?.notes?.[key]) ??
    stringList(fragrance.raw?.notes?.[key])
  );
}

function toCommunityFragrance(row: {
  rowId: string;
  userEmail: string;
  fragrance: Record<string, any>;
}): Record<string, any> | null {
  const { fragrance } = row;
  const name = firstString(fragrance.name, fragrance.product?.name);
  const brand = firstString(fragrance.brand, fragrance.house, fragrance.product?.brand);
  const imageUrl = firstString(fragrance.imageUrl, fragrance.image_url);
  const family = firstString(fragrance.family);
  const topNotes = noteList(fragrance, "top");
  const heartNotes = noteList(fragrance, "heart");
  const baseNotes = noteList(fragrance, "base");

  if (!name || !brand || !imageUrl) return null;

  return {
    id: `community:${row.rowId}`,
    name,
    brand,
    imageUrl,
    curator: `@${shareHandleFromEmail(row.userEmail)}`,
    ...(family ? { family } : {}),
    ...(fragrance.imageAdjustment ? { imageAdjustment: fragrance.imageAdjustment } : {}),
    // Orientation Engine geometry from image hydration. The chosen image is only
    // tagged with imageProperties when it's our normalized square cache object, so
    // forwarding it lets the SPA mark the packshot data-normalized (uniform square
    // framing + the baseline-anchored detail scale). Dropped here previously.
    ...(fragrance.imageProperties ? { imageProperties: fragrance.imageProperties } : {}),
    ...(topNotes ? { topNotes } : {}),
    ...(heartNotes ? { heartNotes } : {}),
    ...(baseNotes ? { baseNotes } : {}),
  };
}

router.get("/community/fragrances", async (req, res, next) => {
  try {
    const tenantId = getTenantId(req);
    const limit = parseLimit(req.query.limit);
    const fetchLimit = Math.min(MAX_LIMIT * FETCH_MULTIPLIER, limit * FETCH_MULTIPLIER);

    const rows = await db
      .select({
        rowId: userFragrancesTable.id,
        // Community cards never render reviews — strip the heavy scraped text in
        // Postgres so the feed query stays small (see slimListFragranceData).
        fragranceData: slimListFragranceData(userFragrancesTable.fragranceData),
        userEmail: usersTable.email,
      })
      .from(userFragrancesTable)
      .innerJoin(
        usersTable,
        and(eq(userFragrancesTable.userId, usersTable.id), eq(usersTable.tenantId, tenantId)),
      )
      .leftJoin(userSettingsTable, eq(userSettingsTable.userId, usersTable.id))
      .where(
        and(
          eq(userFragrancesTable.tenantId, tenantId),
          sql`coalesce(${userSettingsTable.shareHideImages}, false) = false`,
          sql`lower(coalesce(${userFragrancesTable.fragranceData}->>'shareHidden', 'false')) <> 'true'`,
        ),
      )
      .orderBy(desc(userFragrancesTable.createdAt))
      .limit(fetchLimit);

    const normalizedRows = rows.flatMap((row) => {
      if (!row.fragranceData || typeof row.fragranceData !== "object" || Array.isArray(row.fragranceData)) {
        return [];
      }
      return [{
        rowId: row.rowId,
        userEmail: row.userEmail,
        fragrance: normalizeFragrance(row.fragranceData as Record<string, any>),
      }];
    });
    const hydratedFragrances = await batchHydrateImageUrls(normalizedRows.map((row) => row.fragrance));
    const hydrated = normalizedRows.map((row, i) =>
      toCommunityFragrance({ ...row, fragrance: hydratedFragrances[i]! }),
    );
    // De-dupe by fragrance identity: many users vault the same bottle, and the
    // marquee otherwise repeats it back-to-back. FETCH_MULTIPLIER over-fetches
    // precisely so the feed still fills `limit` after dropping duplicates.
    const seenIdentity = new Set<string>();
    const fragrances = hydrated
      .filter((entry): entry is Record<string, any> => entry !== null)
      .filter((entry) => {
        const identity = [entry.brand, entry.name]
          .map((value) => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, ""))
          .join(":");
        if (seenIdentity.has(identity)) return false;
        seenIdentity.add(identity);
        return true;
      })
      .slice(0, limit);

    // Public, non-personalized data: let the CDN/edge serve it for a minute and
    // keep serving stale while it revalidates, so a Community tap on iPad does
    // not block on a cold backend round-trip every time.
    res.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.json({ fragrances });
  } catch (err) {
    next(err);
  }
});

export default router;
