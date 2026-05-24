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

const NOTE_FAMILY_TERMS: Record<string, readonly string[]> = {
  amber: ["amber", "ambergris", "ambroxan", "labdanum", "benzoin"],
  aquatic: ["aquatic", "marine", "sea salt", "water", "calone"],
  aromatic: ["lavender", "rosemary", "sage", "thyme", "basil", "juniper", "clary sage"],
  citrus: ["bergamot", "lemon", "lime", "grapefruit", "mandarin", "orange", "yuzu", "citron", "petitgrain"],
  earthy: ["earth", "soil", "moss", "oakmoss", "patchouli", "vetiver"],
  floral: [
    "rose",
    "peony",
    "lily",
    "lily of the valley",
    "jasmine",
    "iris",
    "violet",
    "tuberose",
    "orange blossom",
    "ylang ylang",
    "neroli",
    "magnolia",
    "gardenia",
    "freesia",
    "honeysuckle",
    "lilac",
    "orchid",
    "osmanthus",
    "mimosa",
    "geranium",
    "carnation",
    "narcissus",
    "hyacinth",
    "lotus",
    "water lily",
    "champaca",
    "frangipani",
    "heliotrope",
  ],
  fresh: [
    "aldehyde",
    "aldehydes",
    "bergamot",
    "lemon",
    "lime",
    "grapefruit",
    "mandarin",
    "mint",
    "eucalyptus",
    "green tea",
    "tea",
    "pear",
    "apple",
    "lily of the valley",
    "neroli",
    "petitgrain",
    "marine",
    "ozone",
    "ozonic",
  ],
  fruity: ["apple", "pear", "peach", "plum", "apricot", "blackcurrant", "berry", "berries", "raspberry", "fig", "melon"],
  gourmand: ["vanilla", "caramel", "praline", "chocolate", "cacao", "coffee", "honey", "sugar", "almond", "tonka"],
  green: ["galbanum", "green leaves", "grass", "violet leaf", "fig leaf", "tomato leaf", "basil", "mint", "petitgrain"],
  leather: ["leather", "suede", "saffron", "birch tar"],
  musky: ["musk", "white musk", "clean musk", "ambrette", "cashmeran", "sandalwood", "iso e super"],
  powdery: ["iris", "orris", "violet", "heliotrope", "mimosa", "tonka", "powder"],
  smoky: ["smoke", "incense", "olibanum", "birch tar", "guaiac wood", "oud"],
  spicy: ["pepper", "pink pepper", "cardamom", "cinnamon", "clove", "nutmeg", "saffron", "ginger", "coriander"],
  sweet: ["vanilla", "tonka", "benzoin", "honey", "caramel", "praline", "sugar", "amber", "fruit", "fruity"],
  woody: [
    "wood",
    "woods",
    "cedar",
    "cedarwood",
    "sandalwood",
    "patchouli",
    "vetiver",
    "agarwood",
    "oud",
    "guaiac",
    "guaiac wood",
    "rosewood",
    "birch",
    "oak",
    "cashmere wood",
    "akigalawood",
    "iso e super",
  ],
};

const ACCORD_FAMILY_TERMS: Record<string, readonly string[]> = {
  amber: ["amber", "ambery", "resin", "resinous", "balsamic"],
  aquatic: ["aquatic", "marine", "ozonic", "water"],
  aromatic: ["aromatic", "herbal", "lavender"],
  citrus: ["citrus"],
  earthy: ["earthy", "mossy", "patchouli", "vetiver"],
  floral: ["floral", "flower", "flowers", "white floral", "yellow floral"],
  fresh: ["fresh", "freshness", "clean", "aldehydic"],
  fruity: ["fruity", "fruit"],
  gourmand: ["gourmand", "vanilla", "chocolate", "caramel", "sweet"],
  green: ["green"],
  leather: ["leather", "suede"],
  musky: ["musk", "musky"],
  powdery: ["powdery", "powder"],
  smoky: ["smoky", "smoke", "incense"],
  spicy: ["spicy", "warm spicy", "fresh spicy", "pepper"],
  sweet: ["sweet", "vanilla", "honey"],
  woody: ["woody", "wood", "woods", "woodiness", "cedar", "sandalwood", "oud"],
};

function matchingFamilies(text: string, familyTerms: Record<string, readonly string[]>): Set<string> {
  const families = new Set<string>();
  for (const [family, terms] of Object.entries(familyTerms)) {
    if (terms.some((term) => containsAsWords(text, term))) families.add(family);
  }
  return families;
}

function hasFamilyOverlap(noteNorm: string, accordNorm: string): boolean {
  const noteFamilies = matchingFamilies(noteNorm, NOTE_FAMILY_TERMS);
  if (noteFamilies.size === 0) return false;
  const accordFamilies = matchingFamilies(accordNorm, ACCORD_FAMILY_TERMS);
  for (const family of noteFamilies) {
    if (accordFamilies.has(family)) return true;
  }
  return false;
}

// Returns 4 (exact), 3 (alias/parenthetical token), 2 (word-boundary phrase),
// 1 (scent family), 0 (no match).
function matchScore(noteNorm: string, accordNorm: string): 0 | 1 | 2 | 3 | 4 {
  if (!noteNorm || !accordNorm) return 0;
  if (noteNorm === accordNorm) return 4;
  if (noteTokens(noteNorm).some((t) => t === accordNorm)) return 3;
  if (containsAsWords(noteNorm, accordNorm)) return 2;
  if (hasFamilyOverlap(noteNorm, accordNorm)) return 1;
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
