import { db } from "@workspace/db";
import { userFragrancesTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { buildProfile } from "./scentEngine";
import { flattenProfile } from "./catalogService";
import { logger } from "../lib/logger";
import {
  normalizeFragrance,
  sanitizeFragrance,
} from "./fragrancePayload";
import { assertNoPersistedBase64Image } from "./persistenceGuards";
import { usableImageUrlForResponse } from "./imageReference";

export type WardrobeRebuildResult = {
  total: number;
  rebuilt: number;
  skipped: number;
  /** Rows skipped because they were already rebuilt within `resumeWithinMs`. */
  resumed: number;
  failures: { id: string; reason: string }[];
};

export type WardrobeRebuildOptions = {
  /**
   * WS-17: resumability. When set, a row whose persisted `rebuilt_at` is newer
   * than `now - resumeWithinMs` is treated as already done and skipped. This lets
   * a rebuild that crashed partway be re-run and pick up where it left off
   * (each row's update is committed individually and stamps `rebuilt_at`) without
   * redoing — or paying Serper/engine cost for — the rows that already finished.
   * Omitted (the default) means a full refresh: every row is rebuilt.
   */
  resumeWithinMs?: number;
};

export async function rebuildWardrobeForUser(
  tenantId: string,
  userId: string,
  options: WardrobeRebuildOptions = {},
): Promise<WardrobeRebuildResult> {
  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(and(
      eq(userFragrancesTable.tenantId, tenantId),
      eq(userFragrancesTable.userId, userId),
    ));

  const failures: { id: string; reason: string }[] = [];
  let rebuilt = 0;
  let skipped = 0;
  let resumed = 0;
  const resumeCutoff =
    typeof options.resumeWithinMs === "number" && options.resumeWithinMs > 0
      ? Date.now() - options.resumeWithinMs
      : null;

  for (const r of rows) {
    const data = normalizeFragrance(r.fragranceData as Record<string, any>);

    if (resumeCutoff !== null) {
      const rebuiltAt = typeof data.rebuilt_at === "string" ? Date.parse(data.rebuilt_at) : NaN;
      if (Number.isFinite(rebuiltAt) && rebuiltAt >= resumeCutoff) {
        resumed++;
        continue;
      }
    }

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
        },
        { allowCatalogFuzzy: false },
      );

      if (!("product" in profile)) {
        skipped++;
        failures.push({ id: r.id, reason: profile.error });
        continue;
      }

      const flat = flattenProfile(profile);
      const rebuiltName = typeof flat.name === "string" && flat.name.trim() ? flat.name : name;
      const rebuiltBrand = typeof flat.brand === "string" && flat.brand.trim() ? flat.brand : brand;
      const flatImageUrl = await usableImageUrlForResponse(flat.imageUrl);
      const merged = sanitizeFragrance({
        ...data,
        ...flat,
        name: rebuiltName,
        brand: rebuiltBrand,
        product: {
          ...(typeof flat.product === "object" && flat.product ? flat.product : {}),
          name: rebuiltName,
          brand: rebuiltBrand,
        },
        imageUrl: flatImageUrl ?? "",
        id: r.id,
        season: typeof data.season === "string" && data.season ? data.season : "Universal",
        intents: data.intents,
        energies: data.energies,
        shareHidden: data.shareHidden,
        // WS-17: per-row completion marker so a crashed rebuild can resume.
        rebuilt_at: new Date().toISOString(),
      });
      assertNoPersistedBase64Image(merged, "user_fragrances.fragrance_data");

      await db
        .update(userFragrancesTable)
        .set({ fragranceData: merged as any })
        .where(and(
          eq(userFragrancesTable.tenantId, tenantId),
          eq(userFragrancesTable.id, r.id),
        ));
      rebuilt++;
    } catch (err: any) {
      logger.warn({ err: err?.message, id: r.id }, "wardrobe/rebuild: row failed");
      skipped++;
      failures.push({ id: r.id, reason: err?.message ?? "rebuild error" });
    }
  }

  return { total: rows.length, rebuilt, skipped, resumed, failures };
}
