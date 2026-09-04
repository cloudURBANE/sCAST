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

import { escapeSqlLike } from "./catalogSearchCore.ts";

export { canonicalizeBrand, brandSpellings, escapeSqlLike };

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
  try {
    const key = makeLookupKey(brand, name);
    const rows = await db
      .select()
      .from(globalFragrancesTable)
      .where(eq(globalFragrancesTable.lookupKey, key))
      .limit(1);
    if (rows.length === 0) return null;
    return sanitizeCatalogProfile(rows[0].profileData);
  } catch {
    return null;
  }
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
  // WS-2: fetch the top two and apply the same runner-up margin rule
  // bestDatasetMatch uses. When the two best candidates are within ~0.04 and
  // neither is near-exact (>=0.97), the identity is ambiguous (e.g. a flanker and
  // its base both scoring high) — return null so buildProfile falls through to
  // the dataset/scrape path instead of silently substituting a nearby fragrance.
  const hits = await searchCatalogCandidates(query, { ...options, limit: Math.max(2, options.limit ?? 2) });
  const best = hits[0];
  if (!best) return null;
  const second = hits[1];
  if (second && best.score < 0.97 && best.score - second.score < 0.04) return null;
  return best.profile;
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
  const escapedQ = escapeSqlLike(q);
  const conditions: SQL[] = [
    sql`${composite} LIKE ${"%" + escapedQ + "%"}`,
    sql`${lookupKey} LIKE ${"%" + escapedQ + "%"}`,
    ...terms.map((term) => sql`${composite} LIKE ${"%" + escapeSqlLike(term) + "%"}`),
  ];

  let rows: Array<typeof globalFragrancesTable.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(globalFragrancesTable)
      .where(or(...conditions))
      .orderBy(sql`length(${globalFragrancesTable.name}) asc`)
      .limit(MAX_CATALOG_CANDIDATES);
  } catch {
    return [];
  }

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
    .where(or(...terms.map((term) => sql`${profileText} LIKE ${"%" + escapeSqlLike(term) + "%"}`)))
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
    terms.map((term) => sql`case when ${profileText} LIKE ${"%" + escapeSqlLike(term) + "%"} then 1 else 0 end`),
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
  const escapedQ = escapeSqlLike(q);
  const conditions: SQL[] = [
    sql`${brand} LIKE ${"%" + escapedQ + "%"}`,
    ...terms.map((term) => sql`${brand} LIKE ${"%" + escapeSqlLike(term) + "%"}`),
  ];

  let rows: Array<typeof globalFragrancesTable.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(globalFragrancesTable)
      .where(or(...conditions))
      .orderBy(sql`length(${globalFragrancesTable.name}) asc`)
      .limit(MAX_CATALOG_CANDIDATES);
  } catch {
    return [];
  }

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
