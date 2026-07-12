export type WardrobeImageTarget = {
  id?: string | null;
  _dbId?: string | null;
  imageUrl?: string | null;
};

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Stable key for per-row image work. The server-owned row id wins once known. */
export function wardrobeImageTargetKey(target: WardrobeImageTarget): string {
  const dbId = cleanString(target._dbId);
  if (dbId) return `db:${dbId}`;
  const id = cleanString(target.id);
  return id ? `id:${id}` : '';
}

export function hasWardrobeImageReference(target: WardrobeImageTarget): boolean {
  return cleanString(target.imageUrl).length > 0;
}

/**
 * Add one target without disturbing unrelated rows. Kept pure so the coordinator
 * contract can be tested without mounting the full Wardrobe provider.
 */
export function addWardrobeImageTarget<T extends WardrobeImageTarget>(
  current: T[],
  target: T,
): T[] {
  const key = wardrobeImageTargetKey(target);
  if (!key || current.some((item) => wardrobeImageTargetKey(item) === key)) return current;
  return [...current, target];
}

/** Remove exactly one row; finishing A must never cancel B. */
export function removeWardrobeImageTarget<T extends WardrobeImageTarget>(
  current: T[],
  target: WardrobeImageTarget,
): T[] {
  const key = wardrobeImageTargetKey(target);
  if (!key) return current;
  const next = current.filter((item) => wardrobeImageTargetKey(item) !== key);
  return next.length === current.length ? current : next;
}

export function includesWardrobeImageTarget(
  current: WardrobeImageTarget[],
  target: WardrobeImageTarget,
): boolean {
  const key = wardrobeImageTargetKey(target);
  return Boolean(key && current.some((item) => wardrobeImageTargetKey(item) === key));
}
