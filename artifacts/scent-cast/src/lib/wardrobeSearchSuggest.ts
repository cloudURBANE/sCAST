/** Minimal shape for suggestion ranking (matches Wardrobe Fragrance fields used in search). */
export type WardrobeSuggestionFragranceShape = {
  id: string;
  name?: string;
  brand?: string;
  family?: string;
  concentration?: string;
  notes?: string[];
  product?: { name?: string; brand?: string };
};

export type WardrobeSearchSuggestionFragrance = { kind: 'fragrance'; item: WardrobeSuggestionFragranceShape };
export type WardrobeSearchSuggestion = WardrobeSearchSuggestionFragrance;


/**
 * Placeholder labels that occasionally leak in from persisted data or engine
 * payloads. They carry no information, so display paths must drop them rather
 * than render "Unknown Family" as if it were a real scent family.
 */
const PLACEHOLDER_FAMILY_LABELS = new Set([
  'unknown family',
  'unknown',
  'n/a',
  'na',
  'none',
  'undefined',
  'null',
]);

/** Returns a family label fit for display, or null when it's absent/placeholder junk. */
export function sanitizeFamilyLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (PLACEHOLDER_FAMILY_LABELS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function entryName(item: WardrobeSuggestionFragranceShape): string {
  return item?.name || item?.product?.name || '';
}

function entryBrand(item: WardrobeSuggestionFragranceShape): string {
  return item?.brand || item?.product?.brand || '';
}

function tokenizeQuery(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function fieldTokenScore(field: string, token: string): number {
  if (!field) return 0;
  if (field === token) return 7;
  if (field.startsWith(token)) return 5;
  if (field.includes(` ${token}`)) return 4;
  if (field.includes(token)) return 2;
  return 0;
}

export function scoreWardrobeQueryMatch(
  item: WardrobeSuggestionFragranceShape,
  queryRaw: string,
): number {
  const q = queryRaw.trim().toLowerCase();
  if (!q) return 0;

  const name = entryName(item).toLowerCase();
  const brand = entryBrand(item).toLowerCase();
  const family = item.family?.toLowerCase() ?? '';
  const concentration = item.concentration?.toLowerCase() ?? '';
  const notes = (item.notes ?? []).join(' ').toLowerCase();
  const all = `${name} ${brand} ${family} ${concentration} ${notes}`.trim();
  if (!all) return 0;

  const tokens = tokenizeQuery(q);
  if (tokens.length === 0) return 0;

  let score = 0;
  for (const token of tokens) {
    const tokenScore = Math.max(
      fieldTokenScore(name, token),
      fieldTokenScore(brand, token),
      fieldTokenScore(family, token),
      fieldTokenScore(concentration, token),
      fieldTokenScore(notes, token),
      fieldTokenScore(all, token),
    );
    if (tokenScore === 0) return 0;
    score += tokenScore;
  }

  if (all.includes(q)) score += 6;
  if (name.startsWith(q)) score += 5;
  if (brand.startsWith(q)) score += 4;
  if (family.includes(q)) score += 2;
  if (concentration.includes(q)) score += 2;
  if (notes.includes(q)) score += 1;

  return score;
}

export function matchesWardrobeQuery(
  item: WardrobeSuggestionFragranceShape,
  queryRaw: string,
): boolean {
  return scoreWardrobeQueryMatch(item, queryRaw) > 0;
}

/** Vault filter + ranked fragrance hits matched against the same query. */
export function buildWardrobeSearchSuggestions(
  items: WardrobeSuggestionFragranceShape[],
  queryRaw: string,
  opts?: { maxFragrances?: number },
): WardrobeSearchSuggestion[] {
  const maxFragrances = opts?.maxFragrances ?? 8;
  const q = queryRaw.trim().toLowerCase();
  if (!q) return [];

  const fragRows = items
    .map((item) => {
      const name = entryName(item);
      const brand = entryBrand(item);
      if (!name || !brand) return null;
      const score = scoreWardrobeQueryMatch(item, q);
      if (score <= 0) return null;
      return { item, score };
    })
    .filter(Boolean)
    .sort((a, b) => (b!.score ?? 0) - (a!.score ?? 0))
    .slice(0, maxFragrances)
    .map((r) => ({ kind: 'fragrance' as const, item: r!.item }));

  return fragRows;
}
