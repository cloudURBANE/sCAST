import { db } from "@workspace/db";
import { globalFragrancesTable } from "@workspace/db/schema";
import { eq, or, sql, type SQL } from "drizzle-orm";
import type { ScentProfile } from "./scentEngine";
import {
  assertNoPersistedBase64Image,
  safeImageUrlForResponse,
  stripBase64ImageDataUrls,
} from "./persistenceGuards";
import {
  fragranceCatalogSearchTerms,
  hasMeaningfulFragranceQuery,
  sanitizeFragranceQueryInput,
  scoreFragranceCandidate,
} from "./fragranceNameResolver";

export function makeLookupKey(brand: string, name: string): string {
  return `${brand.trim().toLowerCase()}::${name.trim().toLowerCase()}`;
}

function sanitizeCatalogProfile(profile: unknown): ScentProfile {
  return stripBase64ImageDataUrls(profile) as ScentProfile;
}

export type CatalogSearchOptions = {
  minScore?: number;
  limit?: number;
};

export type CatalogSearchHit = {
  profile: ScentProfile;
  score: number;
};

const DEFAULT_CATALOG_MIN_SCORE = 0.82;
const MAX_CATALOG_CANDIDATES = 24;

export async function getCatalogEntry(brand: string, name: string): Promise<ScentProfile | null> {
  const key = makeLookupKey(brand, name);
  const rows = await db
    .select()
    .from(globalFragrancesTable)
    .where(eq(globalFragrancesTable.lookupKey, key))
    .limit(1);
  if (rows.length === 0) return null;
  return sanitizeCatalogProfile(rows[0].profileData);
}

/**
 * Confidence-gated catalog search.
 *
 * Constraints (B1/B6): The previous implementation OR'd `name ILIKE %q%`
 * and `brand ILIKE %q%` separately, so a query of "aventus" non-deterministically
 * matched any fragrance whose name *contained* "aventus" — the first row
 * returned by Postgres won. That silently corrupted user_fragrances rows
 * during rebuild and surfaced wrong images during image hydration.
 *
 * The DB query is only a cheap candidate fetch. The resolver makes the final
 * decision, so a broad ILIKE hit cannot silently replace the user's fragrance
 * with a nearby flanker.
 */
export async function searchCatalog(query: string, options: CatalogSearchOptions = {}): Promise<ScentProfile | null> {
  const hits = await searchCatalogCandidates(query, { ...options, limit: 1 });
  return hits[0]?.profile ?? null;
}

export async function searchCatalogCandidates(
  query: string,
  options: CatalogSearchOptions = {},
): Promise<CatalogSearchHit[]> {
  const q = sanitizeFragranceQueryInput(query).toLowerCase();
  if (!q) return [];
  if (!hasMeaningfulFragranceQuery(q)) return [];
  const minScore = options.minScore ?? DEFAULT_CATALOG_MIN_SCORE;
  const limit = Math.max(1, Math.min(options.limit ?? 1, 10));
  const terms = fragranceCatalogSearchTerms(q);
  const composite = sql`(${globalFragrancesTable.brand} || ' ' || ${globalFragrancesTable.name})`;
  const conditions: SQL[] = [
    sql`${composite} ILIKE ${"%" + q + "%"}`,
    sql`${globalFragrancesTable.lookupKey} ILIKE ${"%" + q + "%"}`,
    ...terms.map((term) => sql`${composite} ILIKE ${"%" + term + "%"}`),
  ];

  const rows = await db
    .select()
    .from(globalFragrancesTable)
    .where(or(...conditions))
    .orderBy(sql`length(${globalFragrancesTable.name}) asc`)
    .limit(MAX_CATALOG_CANDIDATES);

  return rows
    .map((row) => {
      const match = scoreFragranceCandidate(q, { brand: row.brand, name: row.name }, minScore);
      return { row, match };
    })
    .filter(({ match }) => match.matched)
    .sort((a, b) => {
      if (b.match.score !== a.match.score) return b.match.score - a.match.score;
      return a.row.name.length - b.row.name.length;
    })
    .slice(0, limit)
    .map(({ row, match }) => ({
      profile: sanitizeCatalogProfile(row.profileData),
      score: match.score,
    }));
}

export async function saveCatalogEntry(brand: string, name: string, profile: ScentProfile): Promise<void> {
  const key = makeLookupKey(brand, name);
  assertNoPersistedBase64Image(profile, "global_fragrances.profile_data");
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
    imageUrl: safeImageUrlForResponse(profile.imageUrl),
    storagePath: profile.storagePath,
    imageHash: profile.imageHash,
    storageProvider: profile.storageProvider,
    sourceProvider: profile.sourceProvider,
    product: profile.product,
  };
}
