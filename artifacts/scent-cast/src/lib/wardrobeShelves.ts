// Pure helpers for the wardrobe/vault shelf grid.
//
// Wardrobe items are laid out in shelves (rows) of `perShelf` cards. The final
// shelf also hosts an "Add Fragrance" card. The previous render guard only drew
// that card when the last shelf was partially filled, so a wardrobe whose item
// count was an exact multiple of `perShelf` (4, 8, 12, …) lost the only way to
// add more. The card must appear on the last shelf regardless of how full it is
// (wrapping onto a fresh row when the last shelf is already full).

export const WARDROBE_ITEMS_PER_SHELF = 4;

/** Split a flat item list into shelves (rows) of at most `perShelf` items. */
export function chunkWardrobeShelves<T>(
  items: readonly T[],
  perShelf: number = WARDROBE_ITEMS_PER_SHELF,
): T[][] {
  const size = Math.max(1, Math.floor(perShelf));
  const shelves: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    shelves.push(items.slice(i, i + size));
  }
  return shelves;
}

/**
 * Index of the shelf that should host the "Add Fragrance" card, or `null` when
 * there are no items (an empty wardrobe shows a dedicated empty-state CTA, not a
 * shelf). For any positive count this is the last shelf — including when the
 * count is an exact multiple of `perShelf`, in which case the add card wraps to
 * a new row on that shelf.
 */
export function addFragranceShelfIndex(
  itemCount: number,
  perShelf: number = WARDROBE_ITEMS_PER_SHELF,
): number | null {
  if (!Number.isFinite(itemCount) || itemCount <= 0) return null;
  const size = Math.max(1, Math.floor(perShelf));
  return Math.ceil(itemCount / size) - 1;
}
