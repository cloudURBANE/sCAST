export type PyramidNotes = {
  top: string[];
  heart: string[];
  base: string[];
};

export type DisplayPyramidNotes = PyramidNotes & {
  flat: string[];
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

export function normalizePyramidNotes(value: unknown): DisplayPyramidNotes {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? (value as PyramidInput)
    : null;
  return {
    top: normalizeNoteList(input?.top),
    heart: normalizeNoteList(input?.heart ?? input?.middle),
    base: normalizeNoteList(input?.base),
    flat: normalizeNoteList(input?.flat ?? input?.notes),
  };
}

export function hasTieredPyramidNotes(pyramid: Pick<PyramidNotes, "top" | "heart" | "base">): boolean {
  return pyramid.top.length > 0 || pyramid.heart.length > 0 || pyramid.base.length > 0;
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

export function resolveDisplayPyramid(
  derivedNotes?: PyramidInput,
  legacyPyramid?: PyramidInput,
  fallbackNotes?: unknown,
): DisplayPyramidNotes {
  const derived = normalizePyramidNotes(derivedNotes);
  const legacy = normalizePyramidNotes(legacyPyramid);
  const flat = normalizeNoteList([derived.flat, legacy.flat, fallbackNotes]);

  const merged = {
    top: derived.top.length > 0 ? derived.top : legacy.top,
    heart: derived.heart.length > 0 ? derived.heart : legacy.heart,
    base: derived.base.length > 0 ? derived.base : legacy.base,
  };

  if (hasTieredPyramidNotes(merged)) {
    return { ...merged, flat };
  }

  return { ...buildPyramidFromFlatNotes(flat), flat };
}
