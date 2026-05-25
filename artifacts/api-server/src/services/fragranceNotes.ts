export type PyramidNotes = {
  top: string[];
  heart: string[];
  base: string[];
};

type PyramidInput = Partial<PyramidNotes & { middle?: unknown; flat?: unknown; notes?: unknown }> | null | undefined;

const TOP_NOTE_TERMS = [
  "aldehyde",
  "apple",
  "bergamot",
  "bigarade",
  "cardamom",
  "cedrat",
  "citrus",
  "grapefruit",
  "lavender",
  "lemon",
  "lime",
  "mandarin",
  "mint",
  "neroli",
  "orange",
  "pear",
  "petitgrain",
  "pineapple",
  "pink pepper",
  "rosemary",
];

const BASE_NOTE_TERMS = [
  "agarwood",
  "amber",
  "ambrette",
  "ambrox",
  "benzoin",
  "cashmeran",
  "cedar",
  "incense",
  "labdanum",
  "leather",
  "moss",
  "musk",
  "oakmoss",
  "oud",
  "papyrus",
  "patchouli",
  "resin",
  "sandalwood",
  "tobacco",
  "tonka",
  "vanilla",
  "vetiver",
  "wood",
];

const HEART_NOTE_TERMS = [
  "clary sage",
  "coconut",
  "cypress",
  "elemi",
  "galbanum",
  "geranium",
  "iris",
  "jasmine",
  "pepper",
  "rum",
  "sage",
  "salt",
  "spice",
  "violet",
];

function noteContains(note: string, terms: string[]): boolean {
  const lower = note.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

export function normalizeNoteList(value: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const visit = (item: unknown) => {
    if (typeof item === "string") {
      for (const part of item.split(/\s*,\s*/)) {
        const note = part.trim();
        const key = note.toLowerCase();
        if (!note || seen.has(key)) continue;
        seen.add(key);
        out.push(note);
      }
      return;
    }
    if (Array.isArray(item)) item.forEach(visit);
  };

  visit(value);
  return out;
}

export function normalizePyramidNotes(value: PyramidInput): PyramidNotes {
  return {
    top: normalizeNoteList(value?.top),
    heart: normalizeNoteList(value?.heart ?? value?.middle),
    base: normalizeNoteList(value?.base),
  };
}

export function hasTieredPyramidNotes(pyramid: Pick<PyramidNotes, "top" | "heart" | "base"> | null | undefined): boolean {
  return Boolean(pyramid && (pyramid.top.length > 0 || pyramid.heart.length > 0 || pyramid.base.length > 0));
}

export function buildPyramidFromFlatNotes(notes: unknown): PyramidNotes {
  const top: string[] = [];
  const heart: string[] = [];
  const base: string[] = [];

  for (const note of normalizeNoteList(notes)) {
    if (noteContains(note, BASE_NOTE_TERMS)) {
      base.push(note);
    } else if (noteContains(note, TOP_NOTE_TERMS)) {
      top.push(note);
    } else if (noteContains(note, HEART_NOTE_TERMS)) {
      heart.push(note);
    } else {
      heart.push(note);
    }
  }

  return { top, heart, base };
}

export function resolvePyramidNotes(
  primary?: PyramidInput,
  fallback?: PyramidInput,
  flatNotes?: unknown,
): PyramidNotes | undefined {
  const primaryPyramid = normalizePyramidNotes(primary);
  const fallbackPyramid = normalizePyramidNotes(fallback);

  const merged = {
    top: primaryPyramid.top.length > 0 ? primaryPyramid.top : fallbackPyramid.top,
    heart: primaryPyramid.heart.length > 0 ? primaryPyramid.heart : fallbackPyramid.heart,
    base: primaryPyramid.base.length > 0 ? primaryPyramid.base : fallbackPyramid.base,
  };
  if (hasTieredPyramidNotes(merged)) return merged;

  const inferred = buildPyramidFromFlatNotes([primary?.flat, primary?.notes, fallback?.flat, fallback?.notes, flatNotes]);
  return hasTieredPyramidNotes(inferred) ? inferred : undefined;
}
