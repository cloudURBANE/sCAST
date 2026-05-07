/**
 * Read-only debug endpoint. Surfaces the exact runtime evidence I'd otherwise
 * gather via instrumentation logs — but as a JSON response so it works against
 * a deployed (Railway/Vercel) instance with no network egress to localhost.
 *
 * GET /api/_debug/wardrobe-audit
 *   Auth: Bearer <user token>     (same token the SPA uses)
 *   Returns: per-row DB snapshot + catalog/image-resolution audit. Performs
 *   NO writes and NO image-generation calls.
 *
 * Remove this file once the discrepancy is diagnosed.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userFragrancesTable, globalFragrancesTable } from "@workspace/db/schema";
import { eq, or, sql } from "drizzle-orm";
import { makeLookupKey } from "../services/catalogService";
import { imageReferenceDiagnostic, type ImageReferenceDiagnostic } from "../services/imageReference";

const router = Router();

function getToken(req: any): string | null {
  const auth = req.headers["authorization"] as string | undefined;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

router.get("/_debug/wardrobe-audit", async (req, res) => {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.token, token as any))
    .limit(1);
  const user = users[0];
  if (!user) { res.status(401).json({ error: "Invalid token" }); return; }

  const rows = await db
    .select()
    .from(userFragrancesTable)
    .where(eq(userFragrancesTable.userId, user.id));

  const audit = await Promise.all(
    rows.map(async (r) => {
      const data = r.fragranceData as Record<string, any>;
      const topName = (data?.name as string | undefined) ?? null;
      const topBrand = (data?.brand as string | undefined) ?? null;
      const productName = (data?.product?.name as string | undefined) ?? null;
      const productBrand = (data?.product?.brand as string | undefined) ?? null;
      const effectiveName = topName || productName || null;
      const effectiveBrand = topBrand || productBrand || null;

      // Exact catalog lookup by lookup_key
      let exactHit: {
        hit: boolean;
        returnedName: string | null;
        returnedBrand: string | null;
        returnedLookupKey: string | null;
        catalogImage: ImageReferenceDiagnostic;
      } | null = null;
      let fuzzyHit: {
        hit: boolean;
        query: string;
        returnedName: string | null;
        returnedBrand: string | null;
        returnedLookupKey: string | null;
        nameDrift: boolean | null;
        brandDrift: boolean | null;
        catalogImage: ImageReferenceDiagnostic;
      } | null = null;

      if (effectiveName && effectiveBrand) {
        const key = makeLookupKey(effectiveBrand, effectiveName);
        const exactRows = await db
          .select()
          .from(globalFragrancesTable)
          .where(eq(globalFragrancesTable.lookupKey, key))
          .limit(1);
        const exactRow = exactRows[0];
        const exactProfile = exactRow?.profileData as Record<string, any> | undefined;
        exactHit = {
          hit: !!exactRow,
          returnedName: exactRow?.name ?? null,
          returnedBrand: exactRow?.brand ?? null,
          returnedLookupKey: exactRow?.lookupKey ?? null,
          catalogImage: await imageReferenceDiagnostic(exactProfile?.imageUrl),
        };

        // Fuzzy search (same logic searchCatalog uses)
        const q = `${effectiveBrand} ${effectiveName}`.trim().toLowerCase();
        const fuzzyRows = await db
          .select()
          .from(globalFragrancesTable)
          .where(
            or(
              sql`(${globalFragrancesTable.brand} || ' ' || ${globalFragrancesTable.name}) ILIKE ${"%" + q + "%"}`,
              sql`${globalFragrancesTable.lookupKey} ILIKE ${"%" + q + "%"}`,
            ),
          )
          .orderBy(sql`length(${globalFragrancesTable.name}) asc`)
          .limit(1);
        const fuzzyRow = fuzzyRows[0];
        const fuzzyProfile = fuzzyRow?.profileData as Record<string, any> | undefined;
        fuzzyHit = {
          hit: !!fuzzyRow,
          query: q,
          returnedName: fuzzyRow?.name ?? null,
          returnedBrand: fuzzyRow?.brand ?? null,
          returnedLookupKey: fuzzyRow?.lookupKey ?? null,
          nameDrift: fuzzyRow ? (fuzzyRow.name ?? "").toLowerCase() !== effectiveName.toLowerCase() : null,
          brandDrift: fuzzyRow ? (fuzzyRow.brand ?? "").toLowerCase() !== effectiveBrand.toLowerCase() : null,
          catalogImage: await imageReferenceDiagnostic(fuzzyProfile?.imageUrl),
        };
      }

      return {
        dbId: r.id,
        createdAt: r.createdAt,
        topName,
        topBrand,
        productName,
        productBrand,
        effectiveName,
        effectiveBrand,
        storedImage: await imageReferenceDiagnostic(data?.imageUrl),
        storedImageLen: typeof data?.imageUrl === "string" ? data.imageUrl.length : 0,
        shareHidden: Boolean(data?.shareHidden),
        hasNotes: Array.isArray(data?.notes) && data.notes.length > 0,
        hasFamily: typeof data?.family === "string" && data.family.length > 0,
        hasScentVector: !!data?.scent_vector,
        exactCatalog: exactHit,
        fuzzyCatalog: fuzzyHit,
        // Top-level vs product-level mismatch — surfaces inserts that lost flat keys
        flatKeysPresent: !!(topName && topBrand),
        productKeysPresent: !!(productName && productBrand),
      };
    }),
  );

  // Total catalog row count + which lookup_keys exist that match this user's brands
  const [{ count: catalogCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(globalFragrancesTable);

  res.json({
    user: { id: user.id, email: user.email },
    rowCount: rows.length,
    visibleOnDashboard: audit.filter(a => !!a.effectiveName && !!a.effectiveBrand).length,
    visibleOnShare: audit.filter(a => !a.shareHidden).length,
    catalogTotalRows: Number(catalogCount),
    rows: audit,
  });
});

export default router;
