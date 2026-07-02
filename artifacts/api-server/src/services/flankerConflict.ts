// Pure, dependency-light helpers for detecting flanker/variant-word mismatches
// between a target fragrance and an image-search candidate (image selection
// audit W4). Kept free of axios / db / sharp so the Node test runner can load
// it directly — mirrors concentrationConflict.ts.
//
// Why this exists: the identity tokenizer strips concentration words (elixir,
// extrait, …) from coverage, and detectConcentration stays silent when the
// TARGET carries no concentration at all ("Dior Sauvage" → Unknown). Net
// effect before this module: "Sauvage" vs "Sauvage Elixir" scored identical
// identity, and a wrong-flanker candidate on a trusted host routinely beat the
// right bottle. Flanker words are the words that NAME a different bottle in
// the same line — they need their own conflict check.

/**
 * One flanker "concept" with its accepted surface forms (accent-folded,
 * lowercase). Forms group cross-language / inflected spellings of the SAME
 * flanker (intense/intenso/intensa, noir/noire, absolu/absolue) so a French vs
 * Italian spelling never manufactures a fake conflict.
 *
 * `hardOnCandidateAssert` calibrates the strong direction (candidate asserts a
 * word the target lacks):
 * - true  → confident wrong-bottle evidence → hard skip. A retailer does not
 *   write "Allure Homme Sport" or "Sauvage Elixir" in a product title unless
 *   that IS the product.
 * - false → penalty only. "extrait" is asserted honestly for houses whose
 *   MAINLINE is an extrait ("Nishane Hacivat Extrait de Parfum", "Tiziana
 *   Terenzi Kirke Extrait de Parfum") — hard-skipping would blank those
 *   fragrances entirely. "summer" appears decoratively in seasonal retailer
 *   titles ("… | Summer Sale").
 */
type FlankerGroup = {
  canonical: string;
  forms: readonly string[];
  hardOnCandidateAssert: boolean;
};

const FLANKER_GROUPS: readonly FlankerGroup[] = [
  { canonical: "intense", forms: ["intense", "intensely", "intenso", "intensa"], hardOnCandidateAssert: true },
  { canonical: "elixir", forms: ["elixir", "elixirs"], hardOnCandidateAssert: true },
  { canonical: "noir", forms: ["noir", "noire"], hardOnCandidateAssert: true },
  { canonical: "absolu", forms: ["absolu", "absolue", "absolute"], hardOnCandidateAssert: true },
  { canonical: "sport", forms: ["sport"], hardOnCandidateAssert: true },
  { canonical: "nuit", forms: ["nuit"], hardOnCandidateAssert: true },
  { canonical: "extreme", forms: ["extreme"], hardOnCandidateAssert: true },
  { canonical: "extrait", forms: ["extrait", "extraits", "extract"], hardOnCandidateAssert: false },
  { canonical: "summer", forms: ["summer"], hardOnCandidateAssert: false },
];

// Gender is handled as an OPPOSITION pair, not presence/absence: retailers
// decorate any masculine listing with "for men" / "pour homme", so a candidate
// merely ADDING a gender word is not evidence of a wrong bottle. A candidate
// asserting the OPPOSITE gender of the target (and not also the target's own)
// is — "Dior Homme" vs a "… pour femme" packshot is never the same product.
// Unisex "for men and women" titles assert both sides and therefore never
// oppose anything.
const MASCULINE_FORMS: readonly string[] = ["homme", "uomo", "man", "men", "male"];
const FEMININE_FORMS: readonly string[] = ["femme", "donna", "woman", "women", "female"];

/**
 * Accent-fold, lowercase, and split on non-alphanumerics into a token set.
 * Deliberately does NOT share the identity tokenizer: that one strips
 * concentration words (elixir, extrait, …) as stopwords, which is exactly the
 * information this module needs to keep.
 */
function flankerTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0),
  );
}

function hasAnyForm(tokens: Set<string>, forms: readonly string[]): boolean {
  return forms.some((form) => tokens.has(form));
}

export type FlankerMismatch = {
  /** Canonical flanker words the candidate evidence asserts that the target name lacks. */
  candidateAsserts: string[];
  /** Subset of candidateAsserts from hard groups — confident wrong-bottle evidence. */
  hardCandidateAsserts: string[];
  /** Canonical flanker words the target asserts that the candidate evidence lacks. */
  candidateLacks: string[];
  /** Target and candidate assert opposite genders (homme-vs-femme style). */
  genderOpposition: boolean;
};

/**
 * Compare the target fragrance text (`${brand} ${name}`) against a candidate's
 * evidence text (title + source + decoded URL) for flanker-word mismatches in
 * BOTH directions.
 *
 * Direction asymmetry (audit W4): a candidate that ASSERTS a flanker word the
 * target lacks ("Sauvage Elixir" for target "Sauvage") is naming a different
 * bottle — strong evidence. A candidate that merely LACKS a word the target
 * has ("Dior Homme" for target "Dior Homme Intense") may just be a terse
 * retailer title, so that direction is only ever penalty-grade.
 */
export function detectFlankerMismatch(targetText: string, candidateText: string): FlankerMismatch {
  const target = flankerTokens(targetText);
  const candidate = flankerTokens(candidateText);

  const candidateAsserts: string[] = [];
  const hardCandidateAsserts: string[] = [];
  const candidateLacks: string[] = [];

  for (const group of FLANKER_GROUPS) {
    const inTarget = hasAnyForm(target, group.forms);
    const inCandidate = hasAnyForm(candidate, group.forms);
    if (inCandidate && !inTarget) {
      candidateAsserts.push(group.canonical);
      if (group.hardOnCandidateAssert) hardCandidateAsserts.push(group.canonical);
    } else if (inTarget && !inCandidate) {
      candidateLacks.push(group.canonical);
    }
  }

  const targetMasc = hasAnyForm(target, MASCULINE_FORMS);
  const targetFem = hasAnyForm(target, FEMININE_FORMS);
  const candidateMasc = hasAnyForm(candidate, MASCULINE_FORMS);
  const candidateFem = hasAnyForm(candidate, FEMININE_FORMS);
  const genderOpposition =
    (targetMasc && !targetFem && candidateFem && !candidateMasc) ||
    (targetFem && !targetMasc && candidateMasc && !candidateFem);

  return { candidateAsserts, hardCandidateAsserts, candidateLacks, genderOpposition };
}

/**
 * True when the mismatch is confident enough to disqualify the candidate
 * outright: it asserts a hard flanker word the target lacks, or it asserts the
 * opposite gender. Penalty-grade signals (soft asserts, missing words) never
 * trip this.
 */
export function hasConfidentFlankerMismatch(mismatch: FlankerMismatch): boolean {
  return mismatch.hardCandidateAsserts.length > 0 || mismatch.genderOpposition;
}
