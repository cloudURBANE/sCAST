export type WithMeState = {
  enabled: boolean;
  fragranceIds: string[];
  updatedAt: string | null;
  loaded: boolean;
};

export type WithMeItemIdentity = { id: string; _dbId?: string };

export const EMPTY_WITH_ME_STATE: WithMeState = {
  enabled: false,
  fragranceIds: [],
  updatedAt: null,
  loaded: false,
};

/** Stable membership id: server row UUID when available, guest/client id otherwise. */
export function withMeItemId(item: WithMeItemIdentity): string {
  return item._dbId?.trim() || item.id.trim();
}

export function effectiveWithMeItems<T extends WithMeItemIdentity>(
  items: T[],
  state: Pick<WithMeState, "enabled" | "fragranceIds">,
): T[] {
  if (!state.enabled) return items;
  const selected = new Set(state.fragranceIds);
  return items.filter((item) => selected.has(withMeItemId(item)));
}

/** Drop deleted/stale ids while preserving the caller's selection order. */
export function reconcileWithMeIds<T extends WithMeItemIdentity>(items: T[], ids: string[]): string[] {
  const owned = new Set(items.map(withMeItemId));
  return [...new Set(ids)].filter((id) => owned.has(id));
}

export function sameWithMeSelection(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

