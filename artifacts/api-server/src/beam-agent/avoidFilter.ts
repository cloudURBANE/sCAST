/**
 * Beam Agent — dislike-aware candidate filtering.
 *
 * Captured dislikes (the `avoid` slot) must shape WHAT gets retrieved, not just
 * the answer's wording (audit A3). This pure module drops catalog candidates
 * whose profile is built around an avoided note/family before they ever reach
 * the model, so a "no oud, nothing sweet" request can't surface an oud/gourmand
 * pick. Pure + dependency-free so it is unit-testable in isolation and reusable.
 */

/** A few obvious synonyms so a named family also catches its close cousins. */
const AVOID_SYNONYMS: Record<string, string[]> = {
  sweet: ["sweet", "gourmand", "sugary", "candy"],
  gourmand: ["gourmand", "sweet", "dessert", "edible"],
  oud: ["oud", "agarwood", "oudh"],
  woody: ["woody", "wood", "woods", "sandalwood", "cedar"],
  musk: ["musk", "musky", "white musk"],
  floral: ["floral", "flower", "flowers"],
  leather: ["leather", "leathery", "suede"],
  smoky: ["smoky", "smoke", "smokey"],
  powdery: ["powdery", "powder"],
  aquatic: ["aquatic", "marine", "ozonic", "sea"],
  citrus: ["citrus", "citrusy", "lemon", "bergamot"],
  spicy: ["spicy", "spice", "spices"],
  vanilla: ["vanilla", "vanillic"],
  amber: ["amber", "ambery", "ambergris"],
};

/** Split the comma-joined `avoid` slot into normalized lowercase terms. */
export function parseAvoidTerms(avoid: string | undefined): string[] {
  if (!avoid) return [];
  const out: string[] = [];
  for (const raw of avoid.split(",")) {
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    for (const expanded of AVOID_SYNONYMS[term] ?? [term]) {
      if (!out.includes(expanded)) out.push(expanded);
    }
  }
  return out;
}

/**
 * Keys stripped from a flattened profile before the avoid match runs. The
 * 6-axis scent vector's JSON KEYS ("musk", "spice", …) appear on EVERY
 * vector-bearing candidate, so serializing them made avoid=musk/spicy match the
 * whole pool — `excludeAvoidedHits`'s never-return-empty backstop then returned
 * everything unfiltered, silently disabling the hard exclusion (the same
 * vector-key footgun the catalog SQL search already excludes). `raw` is the
 * unbounded source blob (reviews can say "not musky at all"), so it is dropped
 * too; the descriptive fields (name/brand/family/accords/notes/pyramid/
 * description) remain the haystack.
 */
const AVOID_MATCH_EXCLUDED_KEYS = ["scent_vector", "scentVector", "raw"] as const;

/**
 * Does this candidate's profile feature an avoided term? Matches whole words
 * against the candidate's searchable text (name/brand/family/accords/notes — we
 * stringify the flattened profile so the check is robust to its exact shape).
 */
export function candidateMatchesAvoid(flat: Record<string, unknown>, avoidTerms: string[]): boolean {
  if (avoidTerms.length === 0) return false;
  let searchable = flat;
  if (AVOID_MATCH_EXCLUDED_KEYS.some((key) => key in flat)) {
    searchable = { ...flat };
    for (const key of AVOID_MATCH_EXCLUDED_KEYS) delete searchable[key];
  }
  const haystack = JSON.stringify(searchable).toLowerCase();
  for (const term of avoidTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(haystack)) return true;
  }
  return false;
}

/**
 * Drop hits built around an avoided note/family. Never returns an empty array
 * when the input was non-empty AND filtering removed everything — a thin pool is
 * better than no pool (the prompt's hard-exclusion constraint is the backstop),
 * so in that degenerate case the original hits are returned unfiltered.
 */
export function excludeAvoidedHits<T extends { flat: Record<string, unknown> }>(
  hits: T[],
  avoid: string | undefined,
): T[] {
  const terms = parseAvoidTerms(avoid);
  if (terms.length === 0 || hits.length === 0) return hits;
  const kept = hits.filter((hit) => !candidateMatchesAvoid(hit.flat, terms));
  return kept.length > 0 ? kept : hits;
}
