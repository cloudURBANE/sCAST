import {
  type DerivedMetrics,
  type MainAccordDisplayRow,
  normalizedAccordBarPct,
} from "./fragranceApi.ts";
import {
  ACCORD_ALIASES,
  BROAD_NOTE_FAMILY_TERMS,
  FAMILY_TO_ACCORD_MAPPINGS,
  NOTE_ALIASES,
  NOTE_FAMILIES,
  type NoteFamilyWeight,
} from "./noteAccordTaxonomy.ts";

export type NoteAccordLink = {
  row: MainAccordDisplayRow;
  displayPct: number;
};

export function normalizeNoteLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeAccordLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Extract searchable tokens from a normalized note label, including
// parenthetical aliases. "agarwood (oud)" -> ["agarwood", "oud"].
function noteTokens(normalized: string): string[] {
  const tokens = new Set<string>();
  const stripped = normalized.replace(/\s*\([^)]*\)/g, "").trim();
  if (stripped) tokens.add(stripped);
  for (const m of normalized.matchAll(/\(([^)]+)\)/g)) {
    const inner = m[1].trim();
    if (!inner) continue;
    tokens.add(inner);
    for (const alias of inner.split(/\s*(?:[,;/]|\bor\b)\s*/)) {
      const clean = alias.trim();
      if (clean) tokens.add(clean);
    }
  }
  return [...tokens];
}

// True if `phrase` appears as a complete word sequence inside `text`,
// bounded by start/end or non-letter/number characters on either side.
function containsAsWords(text: string, phrase: string): boolean {
  const parts = phrase.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const escaped = parts.map(escapeRegExp).join("[\\s/-]+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

const MATCH_WEIGHT = {
  exact: 100,
  alias: 80,
  knownMaterialFamily: 60,
  broadFamilyFallback: 30,
} as const;

function addWeightedFamily(
  target: Map<string, number>,
  family: string,
  weight: number,
): void {
  target.set(family, Math.max(target.get(family) ?? 0, weight));
}

function aliasesForTerm(term: string, aliases: Record<string, readonly string[]>): Set<string> {
  const result = new Set<string>();
  for (const alias of aliases[term] ?? []) result.add(alias);

  for (const [canonical, canonicalAliases] of Object.entries(aliases)) {
    if (canonicalAliases.includes(term)) result.add(canonical);
  }

  return result;
}

function noteSearchTerms(noteNorm: string): Set<string> {
  const terms = new Set<string>(noteTokens(noteNorm));
  terms.add(noteNorm);

  for (const term of [...terms]) {
    for (const alias of aliasesForTerm(term, NOTE_ALIASES)) {
      terms.add(alias);
    }
  }

  return terms;
}

function accordSearchTerms(accordNorm: string): Set<string> {
  const terms = new Set<string>([accordNorm]);

  for (const alias of aliasesForTerm(accordNorm, ACCORD_ALIASES)) {
    terms.add(alias);
  }

  return terms;
}

function familyWeightsFromEntries(entries: readonly NoteFamilyWeight[]): Map<string, number> {
  const families = new Map<string, number>();
  for (const entry of entries) {
    addWeightedFamily(families, entry.family, entry.weight);
  }
  return families;
}

function knownMaterialFamilyWeights(noteNorm: string): Map<string, number> {
  const families = new Map<string, number>();

  for (const term of noteSearchTerms(noteNorm)) {
    const entries = NOTE_FAMILIES[term];
    if (!entries) continue;
    for (const [family, weight] of familyWeightsFromEntries(entries)) {
      addWeightedFamily(families, family, weight);
    }
  }

  return families;
}

function broadNoteFamilyWeights(noteNorm: string): Map<string, number> {
  const families = new Map<string, number>();

  for (const [family, terms] of Object.entries(BROAD_NOTE_FAMILY_TERMS)) {
    if (terms.some((term) => containsAsWords(noteNorm, term))) {
      addWeightedFamily(families, family, 1);
    }
  }

  return families;
}

function accordFamilyWeights(accordNorm: string): Map<string, number> {
  const families = new Map<string, number>();
  const accordTerms = accordSearchTerms(accordNorm);

  for (const [family, mappings] of Object.entries(FAMILY_TO_ACCORD_MAPPINGS)) {
    for (const mapping of mappings) {
      const mappingTerms = new Set<string>([mapping.accord]);
      for (const alias of aliasesForTerm(mapping.accord, ACCORD_ALIASES)) {
        mappingTerms.add(alias);
      }

      const matches = [...mappingTerms].some((mappingTerm) => accordTerms.has(mappingTerm));
      if (matches) addWeightedFamily(families, family, mapping.weight);
    }
  }

  return families;
}

function weightedFamilyScore(
  noteFamilies: Map<string, number>,
  accordFamilies: Map<string, number>,
  baseWeight: number,
): number {
  let score = 0;
  for (const [family, noteWeight] of noteFamilies) {
    const accordWeight = accordFamilies.get(family);
    if (accordWeight === undefined) continue;
    score = Math.max(score, baseWeight * noteWeight * accordWeight);
  }
  return score;
}

function hasAliasMatch(noteNorm: string, accordNorm: string): boolean {
  const noteTerms = noteSearchTerms(noteNorm);
  const accordTerms = accordSearchTerms(accordNorm);

  for (const term of noteTerms) {
    if (accordTerms.has(term)) return true;
  }

  for (const term of accordTerms) {
    if (containsAsWords(noteNorm, term)) return true;
  }

  return false;
}

function matchScore(noteNorm: string, accordNorm: string): number {
  if (!noteNorm || !accordNorm) return 0;
  if (noteNorm === accordNorm) return MATCH_WEIGHT.exact;
  if (hasAliasMatch(noteNorm, accordNorm)) return MATCH_WEIGHT.alias;

  const accordFamilies = accordFamilyWeights(accordNorm);
  if (accordFamilies.size === 0) return 0;

  const knownFamilyScore = weightedFamilyScore(
    knownMaterialFamilyWeights(noteNorm),
    accordFamilies,
    MATCH_WEIGHT.knownMaterialFamily,
  );
  if (knownFamilyScore > 0) return knownFamilyScore;

  return weightedFamilyScore(
    broadNoteFamilyWeights(noteNorm),
    accordFamilies,
    MATCH_WEIGHT.broadFamilyFallback,
  );
}

/**
 * Collect linkable accord rows from main_accords.
 *
 * Accepts items[], array-shaped scent_vector, and top_accords.
 * Returns [] for object-shaped scent_vector - catalog axis labels like
 * "Freshness" / "Woodiness" are internal and should not be matched to notes.
 */
export function collectLinkableMainAccordRows(
  main: DerivedMetrics["main_accords"] | null | undefined,
): MainAccordDisplayRow[] {
  if (!main) return [];

  const fromItems = (main.items ?? [])
    .map((item) => ({
      label: typeof item.label === "string" ? item.label.trim() : "",
      score: typeof item.score === "number" ? item.score : undefined,
      pct: typeof item.pct === "number" ? item.pct : undefined,
    }))
    .filter((row) => row.label);
  if (fromItems.length > 0) return fromItems;

  const svRaw = (main as { scent_vector?: unknown }).scent_vector;
  if (Array.isArray(svRaw)) {
    const fromVector = svRaw
      .map((row) => {
        if (!row || typeof row !== "object") return { label: "" };
        const item = row as { accord?: unknown; score?: unknown };
        return {
          label: typeof item.accord === "string" ? item.accord.trim() : "",
          score: typeof item.score === "number" ? item.score : undefined,
        };
      })
      .filter((row) => row.label);
    if (fromVector.length > 0) return fromVector;
  }

  // Object-shaped scent_vector means catalog axes, which are not note-linkable.
  if (isPlainObjectRecord(svRaw)) return [];

  const top = (main.top_accords ?? [])
    .map((a) => (typeof a === "string" ? a.trim() : ""))
    .filter(Boolean);
  if (top.length === 0) return [];
  return top.map((label, i, arr) => ({
    label,
    pct:
      arr.length <= 1
        ? 90
        : Math.round(Math.max(42, Math.min(96, 96 - i * ((96 - 42) / (arr.length - 1))))),
  }));
}

/**
 * Resolve which accord row best matches each note label.
 *
 * Returns a map keyed by original note label. Only matched notes are included.
 * When multiple accords match at the same priority, the one with higher
 * displayed bar intensity wins.
 */
export function resolveNoteAccordLinks(
  notes: string[],
  accordRows: MainAccordDisplayRow[],
): Map<string, NoteAccordLink> {
  const result = new Map<string, NoteAccordLink>();
  if (!notes.length || !accordRows.length) return result;

  const total = accordRows.length;
  const withPct = accordRows.map((row, i) => ({
    row,
    displayPct: normalizedAccordBarPct(row, i, total),
  }));

  for (const note of notes) {
    const noteNorm = normalizeNoteLabel(note);
    let bestScore = 0;
    let bestPct = -1;
    let bestLink: NoteAccordLink | null = null;

    for (const { row, displayPct } of withPct) {
      const score = matchScore(noteNorm, normalizeAccordLabel(row.label));
      if (score === 0) continue;
      if (score > bestScore || (score === bestScore && displayPct > bestPct)) {
        bestScore = score;
        bestPct = displayPct;
        bestLink = { row, displayPct };
      }
    }

    if (bestLink) result.set(note, bestLink);
  }

  return result;
}
