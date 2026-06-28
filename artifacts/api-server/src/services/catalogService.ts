import { db } from "@workspace/db";
import { globalFragrancesTable } from "@workspace/db/schema";
import { asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { ScentProfile } from "./scentEngine";
import {
  assertNoPersistedBase64Image,
  safeImageUrlForResponse,
  stripBase64ImageDataUrls,
} from "./persistenceGuards";
import {
  fragranceCatalogSearchTerms,
  hasMeaningfulFragranceQuery,
  matchesFragranceBrandQuery,
  sanitizeFragranceQueryInput,
  scoreFragranceCandidate,
} from "./fragranceNameResolver";
// Brand canonicalization lives in the pure brandAliasCore (unit-tested in
// isolation); re-exported below to keep catalogService's public API stable.
import { canonicalizeBrand, brandSpellings } from "./brandAliasCore";
import { catalogProfileIsMinimal, mergeCatalogProfilePreserveRicher } from "./catalogMergeCore.ts";
import {
  catalogProfileSearchConcepts,
  catalogProfileSearchTerms,
  scoreCatalogProfileForQuery,
} from "./catalogProfileSearch.ts";

export { canonicalizeBrand, brandSpellings };

export function makeLookupKey(brand: string, name: string): string {
  return `${canonicalizeBrand(brand)}::${name.trim().toLowerCase()}`;
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
const MAX_PROFILE_CANDIDATES = 96;

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
  const composite = sql`lower(${globalFragrancesTable.brand} || ' ' || ${globalFragrancesTable.name})`;
  const lookupKey = sql`lower(${globalFragrancesTable.lookupKey})`;
  const conditions: SQL[] = [
    sql`${composite} LIKE ${"%" + q + "%"}`,
    sql`${lookupKey} LIKE ${"%" + q + "%"}`,
    ...terms.map((term) => sql`${composite} LIKE ${"%" + term + "%"}`),
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

/** Index-backed candidate fetch for descriptive profile retrieval. */
function selectProfileCandidates(profileText: SQL, textMatchCount: SQL<number>, terms: string[]) {
  return db
    .select()
    .from(globalFragrancesTable)
    .where(or(...terms.map((term) => sql`${profileText} LIKE ${"%" + term + "%"}`)))
    .orderBy(sql`${textMatchCount} desc`, asc(globalFragrancesTable.lookupKey))
    .limit(MAX_PROFILE_CANDIDATES);
}

/**
 * Beam-only descriptive retrieval. Exact identity lookup above intentionally
 * keeps its strict name/brand confidence gate; this path searches profile JSON
 * for how users describe scents (notes, accords, family, context, and vectors).
 */
export async function searchCatalogProfileCandidates(
  query: string,
  options: Pick<CatalogSearchOptions, "limit"> = {},
): Promise<CatalogSearchHit[]> {
  const q = sanitizeFragranceQueryInput(query).toLowerCase();
  if (!q) return [];
  // Preserve identity semantics when a fragrance name also contains a descriptive
  // word (for example "Oud Wood" or "Green Tea").
  const identityHits = await searchCatalogCandidates(query, options);
  if (identityHits.length > 0) return identityHits;
  const concepts = catalogProfileSearchConcepts(q);
  const limit = Math.max(1, Math.min(options.limit ?? 8, 12));
  const terms = catalogProfileSearchTerms(q);
  if (concepts.length === 0 && terms.length === 0) return [];
  // Exclude vector keys: "%fresh%" must not match "freshness" on every row.
  //
  // This `lower((profile_data - 'scent_vector')::text) LIKE '%term%'` filter is
  // backed by the GIN trigram index `global_fragrances_profile_trgm_idx`
  // (supabase/migrations/20260619120000_global_fragrances_profile_search.sql),
  // so it is an index-accelerated lookup rather than a sequential scan. The
  // index expression must stay character-for-character identical to this one
  // for the planner to use it. If the index has not been applied the same query
  // still runs (as a slower seq scan), so retrieval degrades but never breaks.
  const profileText = sql`lower((${globalFragrancesTable.profileData} - 'scent_vector')::text)`;
  const textMatchCount = sql<number>`(${sql.join(
    terms.map((term) => sql`case when ${profileText} LIKE ${"%" + term + "%"} then 1 else 0 end`),
    sql` + `,
  )})`;
  let rows: Awaited<ReturnType<typeof selectProfileCandidates>>;
  try {
    rows = await selectProfileCandidates(profileText, textMatchCount, terms);
  } catch {
    // Safe fallback: a descriptive-retrieval DB failure must not 500 a Beam turn
    // or poison the identity path. Identity hits were already returned above when
    // present; here there are none, so degrade to "no descriptive candidates".
    return [];
  }

  return rows
    .map((row) => {
      const profile = sanitizeCatalogProfile(row.profileData);
      return { profile, score: scoreCatalogProfileForQuery(q, profile) };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function searchCatalogBrandCandidates(
  query: string,
  options: Pick<CatalogSearchOptions, "limit"> = {},
): Promise<CatalogSearchHit[]> {
  const q = sanitizeFragranceQueryInput(query).toLowerCase();
  if (!q) return [];
  if (!hasMeaningfulFragranceQuery(q)) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 12, 24));
  const terms = fragranceCatalogSearchTerms(q);
  const brand = sql`lower(${globalFragrancesTable.brand})`;
  const conditions: SQL[] = [
    sql`${brand} LIKE ${"%" + q + "%"}`,
    ...terms.map((term) => sql`${brand} LIKE ${"%" + term + "%"}`),
  ];

  const rows = await db
    .select()
    .from(globalFragrancesTable)
    .where(or(...conditions))
    .orderBy(sql`length(${globalFragrancesTable.name}) asc`)
    .limit(MAX_CATALOG_CANDIDATES);

  const seen = new Set<string>();
  return rows
    .filter((row) => {
      if (!matchesFragranceBrandQuery(q, row.brand)) return false;
      if (seen.has(row.lookupKey)) return false;
      seen.add(row.lookupKey);
      return true;
    })
    .slice(0, limit)
    .map((row) => ({
      profile: sanitizeCatalogProfile(row.profileData),
      score: 1,
    }));
}

export async function saveCatalogEntry(brand: string, name: string, profile: ScentProfile): Promise<void> {
  const key = makeLookupKey(brand, name);
  assertNoPersistedBase64Image(profile, "global_fragrances.profile_data");

  // WS-8: the catalog is shared across all users — a save must never downgrade
  // a populated row. A minimal/pending profile (no notes, no real family, no
  // image) is create-only: it seeds a row when absent but is forbidden from
  // clobbering a richer one another path already wrote.
  if (catalogProfileIsMinimal(profile)) {
    await db
      .insert(globalFragrancesTable)
      .values({
        lookupKey: key,
        name: name.trim(),
        brand: brand.trim(),
        profileData: profile as any,
      })
      .onConflictDoNothing({ target: globalFragrancesTable.lookupKey });
    return;
  }

  // A real save re-reads the current row and merges so a field the incoming save
  // happens to lack (e.g. a notes enrichment with no image, or an image refresh
  // with stale notes) can't blank out what the row already has. The in-flight
  // build dedup (scentEngine.buildProfile) collapses concurrent identical builds,
  // so the read→merge→write window is not a meaningful race for the same key.
  const existingRows = await db
    .select({ profileData: globalFragrancesTable.profileData })
    .from(globalFragrancesTable)
    .where(eq(globalFragrancesTable.lookupKey, key))
    .limit(1);
  const merged = existingRows.length
    ? mergeCatalogProfilePreserveRicher(sanitizeCatalogProfile(existingRows[0].profileData), profile)
    : profile;
  assertNoPersistedBase64Image(merged, "global_fragrances.profile_data");

  await db
    .insert(globalFragrancesTable)
    .values({
      lookupKey: key,
      name: name.trim(),
      brand: brand.trim(),
      profileData: merged as any,
    })
    .onConflictDoUpdate({
      target: globalFragrancesTable.lookupKey,
      set: {
        profileData: merged as any,
        updatedAt: new Date(),
      },
    });
}

/** Flatten a ScentProfile into the flat shape the frontend expects */
export function flattenProfile(profile: ScentProfile): Record<string, unknown> {
  const extra = profile as ScentProfile & Record<string, unknown>;
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
    ...(extra.source_url ? { source_url: extra.source_url } : {}),
    ...(extra.source_coverage ? { source_coverage: extra.source_coverage } : {}),
    ...(extra.derived_metrics ? { derived_metrics: extra.derived_metrics } : {}),
    ...(extra.enrichment ? { enrichment: extra.enrichment } : {}),
    ...(extra.raw ? { raw: extra.raw } : {}),
  };
}
