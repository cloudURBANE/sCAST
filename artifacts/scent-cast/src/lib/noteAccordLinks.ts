import {
  type DerivedMetrics,
  type MainAccordDisplayRow,
  normalizedAccordBarPct,
} from "./fragranceApi.ts";

export type NoteAccordLink = {
  row: MainAccordDisplayRow;
  displayPct: number;
};

export function normalizeNoteLabel(label: string): string {
  return label.toLowerCase().trim().replace(/\s+/g, " ");
}

export function normalizeAccordLabel(label: string): string {
  return label.toLowerCase().trim().replace(/\s+/g, " ");
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

// Returns 3 (exact), 2 (alias/parenthetical token), 1 (word-boundary phrase), 0 (no match).
function matchScore(noteNorm: string, accordNorm: string): 0 | 1 | 2 | 3 {
  if (!noteNorm || !accordNorm) return 0;
  if (noteNorm === accordNorm) return 3;
  if (noteTokens(noteNorm).some((t) => t === accordNorm)) return 2;
  if (containsAsWords(noteNorm, accordNorm)) return 1;
  return 0;
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
