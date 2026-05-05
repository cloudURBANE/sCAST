import { db } from "@workspace/db";
import { globalFragrancesTable } from "@workspace/db/schema";
import { eq, or, sql } from "drizzle-orm";
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
  if (rows.length === 0) return null;
  return rows[0].profileData as ScentProfile;
}

/**
 * Fuzzy catalog search.
 *
 * Constraints (B1/B6): The previous implementation OR'd `name ILIKE %q%`
 * and `brand ILIKE %q%` separately, so a query of "aventus" non-deterministically
 * matched any fragrance whose name *contained* "aventus" — the first row
 * returned by Postgres won. That silently corrupted user_fragrances rows
 * during rebuild and surfaced wrong images during image hydration.
 *
 * New rules:
 *  - Match only against the concatenated "brand name" or the lookup_key
 *    (the same composite the catalog actually uses to identify products).
 *  - Order shortest match first so "Aventus" beats "Aventus Cologne" /
 *    "Aventus for Her" deterministically.
 */
export async function searchCatalog(query: string): Promise<ScentProfile | null> {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const rows = await db
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
