// Pure query-composition helpers for the Serper/engine image search layer.
// Kept dependency-free (no axios/logger imports) so the node:test runner can
// unit-test query composition in isolation — same pattern as
// imagePipelineCachePolicy.ts.

import type { SerperRefineMode } from "./imageSolvers";

// Google (which Serper and the engine's Decodo path both mirror) hard-truncates
// queries at 32 words — every token past that is silently dropped. All composed
// queries are capped here so refinement tokens actually reach Google instead of
// being dead weight (image selection audit W2).
export const MAX_QUERY_WORDS = 32;

/**
 * Full packshot refinement appended for normal refresh paths. Kept under ~20
 * words so base fragrance line + suffix stays inside MAX_QUERY_WORDS. (The old
 * 40-word suffix — combined with a second route-level suffix — composed 60-74
 * word queries of which Google only ever saw the first 32.)
 */
export const SERPER_SUFFIX_DEFAULT =
  "single fragrance bottle only packshot product photo plain background no box no packaging no gift set no tester no sample";

/**
 * Shorter suffix on clarify/solver paths so negative keywords stay meaningful.
 * Must NOT contain any token a solver query negates: the previous suffix ended
 * in "no sample no tester", which re-added the literal words `sample`/`tester`
 * after solvers that send `-sample -tester` — a self-contradictory Google query
 * that returns few or zero image results (image selection audit S1).
 * Tester/sample/vial/decant filtering is enforced post-search by
 * BLOCKED_TEXT_HINTS in serperCandidateScoring instead.
 */
export const SERPER_SUFFIX_SOLVER = "single fragrance bottle packshot isolated product photo";

/** Cap a composed query at Google's word limit, keeping the leading (base) words. */
export function capQueryWords(query: string, maxWords: number = MAX_QUERY_WORDS): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ");
}

export function applySerperRefinement(rawQuery: string, refine: SerperRefineMode): string {
  const q = rawQuery.trim();
  if (!q) return q;
  // The word cap only ever trims suffix words: the base fragrance line (and any
  // solver tokens) lead the query, and the suffixes contain no quoted phrases,
  // so truncation cannot split a phrase or unbalance quotes.
  if (refine === "none") return capQueryWords(q);
  if (refine === "solver") return capQueryWords(`${q} ${SERPER_SUFFIX_SOLVER}`.trim());
  return capQueryWords(`${q} ${SERPER_SUFFIX_DEFAULT}`.trim());
}
