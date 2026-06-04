import { Router } from "express";
import { db } from "@workspace/db";
import { userFragrancesTable, userSettingsTable, usersTable } from "@workspace/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { batchHydrateImageUrls, normalizeFragrance } from "../services/fragrancePayload";
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
        fragranceData: userFragrancesTable.fragranceData,
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
    const fragrances = hydrated.filter((entry): entry is Record<string, any> => entry !== null).slice(0, limit);

    res.json({ fragrances });
  } catch (err) {
    next(err);
  }
});

export default router;
