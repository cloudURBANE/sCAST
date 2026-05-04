import { db } from "@workspace/db";
import { globalFragrancesTable } from "@workspace/db/schema";
import { eq, or, ilike, sql } from "drizzle-orm";
import type { ScentProfile } from "./scentEngine";

export function makeLookupKey(brand: string, name: string): string {
  return `${brand.trim().toLowerCase()}::${name.trim().toLowerCase()}`;
}

export async function getCatalogEntry(brand: string, name: string): Promise<ScentProfile | null> {
  const key = makeLookupKey(brand, name);
  const rows = await db
    .select()
    .from(globalFragrancesTable)
    .where(eq(globalFragrancesTable.lookupKey, key))
    .limit(1);
  // #region agent log
  fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6001a3'},body:JSON.stringify({sessionId:'6001a3',hypothesisId:'C_catalog_lookup',location:'catalogService.ts:getCatalogEntry',message:'exact lookup_key result',data:{inputBrand:brand,inputName:name,key,hit:rows.length>0,returnedName:rows[0]?.name??null,returnedBrand:rows[0]?.brand??null,returnedLookupKey:rows[0]?.lookupKey??null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (rows.length === 0) return null;
  return rows[0].profileData as ScentProfile;
}

export async function searchCatalog(query: string): Promise<ScentProfile | null> {
  const q = query.trim().toLowerCase();

  const rows = await db
    .select()
    .from(globalFragrancesTable)
    .where(
      or(
        // name alone matches the query
        ilike(globalFragrancesTable.name, `%${q}%`),
        // brand alone matches the query
        ilike(globalFragrancesTable.brand, `%${q}%`),
        // "brand name" concatenated matches (e.g. "Creed Aventus")
        sql`(${globalFragrancesTable.brand} || ' ' || ${globalFragrancesTable.name}) ILIKE ${"%" + q + "%"}`,
        // query is contained in the lookup_key (e.g. "aventus" in "creed::aventus")
        sql`${globalFragrancesTable.lookupKey} ILIKE ${"%" + q + "%"}`,
      )
    )
    .limit(1);

  // #region agent log
  fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6001a3'},body:JSON.stringify({sessionId:'6001a3',hypothesisId:'C_fuzzy_match',location:'catalogService.ts:searchCatalog',message:'fuzzy ILIKE result',data:{inputQuery:query,normalizedQ:q,hit:rows.length>0,returnedName:rows[0]?.name??null,returnedBrand:rows[0]?.brand??null,returnedLookupKey:rows[0]?.lookupKey??null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  if (rows.length === 0) return null;
  return rows[0].profileData as ScentProfile;
}

export async function saveCatalogEntry(brand: string, name: string, profile: ScentProfile): Promise<void> {
  const key = makeLookupKey(brand, name);
  await db
    .insert(globalFragrancesTable)
    .values({
      lookupKey: key,
      name: name.trim(),
      brand: brand.trim(),
      profileData: profile as any,
    })
    .onConflictDoUpdate({
      target: globalFragrancesTable.lookupKey,
      set: {
        profileData: profile as any,
        updatedAt: new Date(),
      },
    });
}

/** Flatten a ScentProfile into the flat shape the frontend expects */
export function flattenProfile(profile: ScentProfile): Record<string, unknown> {
  return {
    name: profile.product.name,
    brand: profile.product.brand,
    perfumer: profile.product.perfumer ?? "",
    family: profile.family,
    notes: profile.notes,
    description: profile.description ?? "",
    pyramid: profile.pyramid ?? { top: [], heart: [], base: [] },
    accords: profile.accords ?? [],
    scent_vector: profile.scent_vector,
    performance: profile.performance,
    context: profile.context,
    concentration: profile.concentration,
    imageUrl: profile.imageUrl ?? "",
    product: profile.product,
  };
}
