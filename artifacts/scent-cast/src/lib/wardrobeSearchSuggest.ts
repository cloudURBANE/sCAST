import type { WardrobeImageSolverId } from '@/lib/imageRefreshSolvers';
import { WARDROBE_CLARIFY_SOLVERS } from '@/lib/imageRefreshSolvers';

/** Minimal shape for suggestion ranking (matches Wardrobe Fragrance fields used in search). */
export type WardrobeSuggestionFragranceShape = {
  id: string;
  name?: string;
  brand?: string;
  family?: string;
  notes?: string[];
  product?: { name?: string; brand?: string };
};

export type WardrobeSearchSuggestionFragrance = { kind: 'fragrance'; item: WardrobeSuggestionFragranceShape };
export type WardrobeSearchSuggestionSolver = {
  kind: 'solver';
  id: WardrobeImageSolverId;
  label: string;
};
export type WardrobeSearchSuggestion =
  | WardrobeSearchSuggestionFragrance
  | WardrobeSearchSuggestionSolver;

function entryName(item: WardrobeSuggestionFragranceShape): string {
  return item?.name || item?.product?.name || '';
}

function entryBrand(item: WardrobeSuggestionFragranceShape): string {
  return item?.brand || item?.product?.brand || '';
}

/** Vault filter + ranked fragrance hits + solver labels matched against the same query. */
export function buildWardrobeSearchSuggestions(
  items: WardrobeSuggestionFragranceShape[],
  queryRaw: string,
  opts?: { maxFragrances?: number; maxSolvers?: number },
): WardrobeSearchSuggestion[] {
  const maxFragrances = opts?.maxFragrances ?? 8;
  const maxSolvers = opts?.maxSolvers ?? 6;
  const q = queryRaw.trim().toLowerCase();
  if (!q) return [];

  const fragRows = items
    .map((item) => {
      const name = entryName(item);
      const brand = entryBrand(item);
      if (!name || !brand) return null;
      const hn = name.toLowerCase();
      const hb = brand.toLowerCase();
      const hf = item.family?.toLowerCase() ?? '';
      const notes = (item.notes ?? []).join(' ').toLowerCase();
      const hay = `${hn} ${hb} ${hf} ${notes}`;
      if (!hay.includes(q)) return null;

      let score = 0;
      if (hn.startsWith(q)) score += 14;
      else if (hn.includes(q)) score += 8;
      if (hb.startsWith(q)) score += 12;
      else if (hb.includes(q)) score += 6;
      if (hf.includes(q)) score += 3;
      if (notes.includes(q)) score += 2;
      return { item, score };
    })
    .filter(Boolean)
    .sort((a, b) => (b!.score ?? 0) - (a!.score ?? 0))
    .slice(0, maxFragrances)
    .map((r) => ({ kind: 'fragrance' as const, item: r!.item }));

  const solverRows: WardrobeSearchSuggestionSolver[] = WARDROBE_CLARIFY_SOLVERS.filter((s) => {
    const idHay = s.id.replace(/_/g, ' ').toLowerCase();
    const labelHay = s.label.toLowerCase();
    return labelHay.includes(q) || idHay.includes(q);
  })
    .slice(0, maxSolvers)
    .map((s) => ({ kind: 'solver' as const, id: s.id, label: s.label }));

  return [...fragRows, ...solverRows];
}
