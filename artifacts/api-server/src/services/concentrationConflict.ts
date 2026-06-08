import { CONCENTRATION_PATTERNS, type Concentration } from "./scentParser.ts";

// Pure, dependency-light helpers for detecting concentration mismatches between
// a target fragrance and an image-search candidate. Kept free of axios / db /
// sharp so the Node test runner can load it directly.

/**
 * Detect the concentration referenced anywhere in a free-text blob (title,
 * source, decoded URL path, …). Reuses the same ordered pattern table the scent
 * parser uses, so "eau de parfum" is recognised as EDP before the looser bare
 * "parfum" rule can fire. Returns "Unknown" when nothing matches.
 *
 * The shared `CONCENTRATION_PATTERNS` regexes carry only the `i` flag (no `g`/
 * `y`), so repeated `.test()` calls are stateless and safe to reuse here.
 */
export function detectConcentration(text: string): Concentration {
  for (const { pattern, value } of CONCENTRATION_PATTERNS) {
    if (pattern.test(text)) return value;
  }
  return "Unknown";
}

/**
 * Two concentrations conflict only when both are confidently known and differ.
 * If either side is "Unknown" we stay silent — we never penalise a candidate for
 * a concentration we could not read. This is what stops an "Eau de Toilette"
 * packshot from satisfying an "Eau de Parfum" request even though they share the
 * brand/line tokens (e.g. "Bleu de Chanel EDT" vs "Bleu de Chanel EDP").
 */
export function concentrationsConflict(target: Concentration, candidate: Concentration): boolean {
  if (target === "Unknown" || candidate === "Unknown") return false;
  return target !== candidate;
}

/**
 * Some concentration mismatches are genuinely ambiguous rather than disqualifying.
 * The bare "Parfum" value is a marketing catch-all: the parser fires it for loose
 * uses like "Le Parfum" / "The Parfum" that retailers routinely list as an
 * "Eau de Parfum" (and historically "parfum" meant the extrait). So when one side
 * is the unreliable bare "Parfum" and the other is also in the concentrated parfum
 * family (Parfum / Extrait / Eau de Parfum), the mismatch is soft — it should be
 * penalised, not hard-skipped, so the correct packshot survives (BE-8).
 *
 * The lighter fresh tier (Eau de Toilette / Eau de Cologne) is excluded: an EDT/EDC
 * vs EDP mismatch stays a firm conflict.
 */
export function concentrationsAmbiguouslyAdjacent(a: Concentration, b: Concentration): boolean {
  if (a === b) return false;
  const parfumFamily: ReadonlySet<Concentration> = new Set(["Parfum", "Extrait", "Eau de Parfum"]);
  return (a === "Parfum" || b === "Parfum") && parfumFamily.has(a) && parfumFamily.has(b);
}
