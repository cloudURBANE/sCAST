import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogProfileSearchTerms,
  scoreCatalogProfileForQuery,
} from "./catalogProfileSearch.ts";
import type { ScentProfile } from "./scentEngineCore.ts";

/**
 * Descriptive-retrieval regressions.
 *
 * These prove the descriptive (profile) search finds relevant fragrances from
 * how a user describes a scent — not from a guessed product name — and that the
 * candidate filter is term-driven rather than dependent on a tiny bounded scan.
 *
 * `searchCatalogProfileCandidates` filters in Postgres with
 *   lower((profile_data - 'scent_vector')::text) LIKE '%term%'
 * over the same terms `catalogProfileSearchTerms` produces, now backed by the
 * `global_fragrances_profile_trgm_idx` GIN trigram index. `candidateMatches`
 * reproduces that exact predicate so the term/recall semantics can be tested
 * without a live database, then `scoreCatalogProfileForQuery` re-ranks — the
 * production flow.
 */

function vector(overrides: Partial<ScentProfile["scent_vector"]> = {}): ScentProfile["scent_vector"] {
  return { freshness: 0, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0, ...overrides };
}

function profile(overrides: Partial<ScentProfile>): ScentProfile {
  return {
    product: { name: "Test", brand: "House" },
    scent_vector: vector(),
    performance: { sillage: 5, longevity: 5 },
    context: { weather: [], occasion: [] },
    notes: [],
    family: "",
    concentration: "EDP",
    accords: [],
    ...overrides,
  };
}

/** Mirror of the SQL candidate predicate: substring over profile text minus scent_vector. */
function candidateMatches(query: string, p: ScentProfile): boolean {
  const terms = catalogProfileSearchTerms(query);
  const { scent_vector: _omit, ...rest } = p;
  const text = JSON.stringify(rest).toLowerCase();
  return terms.some((term) => text.includes(term));
}

const FRESH_WOODY = profile({
  product: { name: "Coastal Cedar", brand: "House" },
  family: "Woody Aromatic",
  notes: ["bergamot", "sandalwood", "vetiver"],
  accords: ["fresh", "woody", "citrus"],
  description: "A clean, airy cedar built for hot humid weather.",
  scent_vector: vector({ freshness: 8, woodiness: 7 }),
});

const SWEET_GOURMAND = profile({
  product: { name: "Velvet Sugar", brand: "House" },
  family: "Amber Gourmand",
  notes: ["vanilla", "tonka", "praline"],
  accords: ["sweet", "gourmand", "vanilla"],
  description: "A warm, sugary dessert fragrance for cold winter wear.",
  scent_vector: vector({ sweetness: 9, warmth: 8 }),
});

const OUD = profile({
  product: { name: "Oud Wood", brand: "House" },
  family: "Woody",
  notes: ["oud", "agarwood", "amber"],
  accords: ["oud", "woody", "smoky"],
  description: "A dark, smoky agarwood for evening wear.",
  scent_vector: vector({ woodiness: 9, warmth: 6 }),
});

/* --------------------------- term extraction --------------------------- */

test("descriptive language yields substring-matchable retrieval terms (no name guessing)", () => {
  const terms = catalogProfileSearchTerms("something clean, airy, woody for humid Dallas nights");
  // Concept expansions the index/LIKE filter can match against profile text.
  for (const expected of ["clean", "fresh", "woody", "wood", "aquatic"]) {
    assert.ok(terms.includes(expected), `expected term "${expected}" in ${JSON.stringify(terms)}`);
  }
  // "dallas"/"nights" are freeform tokens; boilerplate ("something") is dropped.
  assert.ok(!terms.includes("something"));
});

test("compound notes stay reachable via substring terms", () => {
  // "wood" must reach "sandalwood"/"rosewood" — the reason trigram (substring)
  // indexing is used instead of a tsvector lexeme/prefix index.
  const terms = catalogProfileSearchTerms("woody and warm");
  assert.ok(terms.includes("wood"));
  assert.ok("a sandalwood and rosewood blend".includes("wood"));
});

/* ---------------------- candidate recall (SQL parity) ------------------- */

test("descriptive query retrieves the relevant fragrances and rejects unrelated ones", () => {
  const query = "clean airy woody for hot humid nights";
  assert.ok(candidateMatches(query, FRESH_WOODY), "fresh/woody profile should be a candidate");
  assert.ok(candidateMatches(query, OUD), "woody oud profile should be a candidate");
  assert.ok(!candidateMatches(query, SWEET_GOURMAND), "sweet gourmand should not match a fresh/woody query");
});

test("a 'fresh' query is not matched solely by the freshness vector key", () => {
  // The SQL strips scent_vector before the text match; a profile with no fresh
  // language but a high freshness vector must not become a text candidate.
  const onlyVectorFresh = profile({
    product: { name: "Numbers Only", brand: "House" },
    family: "Floral",
    notes: ["rose", "jasmine"],
    accords: ["floral"],
    description: "A soft floral bouquet.",
    scent_vector: vector({ freshness: 9 }),
  });
  assert.ok(!candidateMatches("fresh", onlyVectorFresh));
});

/* ------------------------------- ranking ------------------------------- */

test("scoring ranks the on-brief profile above off-brief candidates", () => {
  const query = "clean airy woody for hot humid nights";
  const fresh = scoreCatalogProfileForQuery(query, FRESH_WOODY);
  const oud = scoreCatalogProfileForQuery(query, OUD);
  const sweet = scoreCatalogProfileForQuery(query, SWEET_GOURMAND);
  assert.ok(fresh > 0, "relevant profile must score above zero");
  assert.ok(fresh > sweet, "fresh/woody should outrank sweet gourmand");
  assert.ok(oud >= sweet, "woody oud should not rank below an unrelated gourmand");
});

test("sweet-gourmand query flips the ranking back", () => {
  const query = "warm sweet vanilla gourmand for cold weather";
  const sweet = scoreCatalogProfileForQuery(query, SWEET_GOURMAND);
  const fresh = scoreCatalogProfileForQuery(query, FRESH_WOODY);
  assert.ok(sweet > 0);
  assert.ok(sweet > fresh, "gourmand should win its own brief");
});
