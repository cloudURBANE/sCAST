/**
 * Cheap version key for GET /api/wardrobe conditional requests.
 *
 * Derived from the user's row count and newest `updated_at` so any add / edit /
 * remove changes the key, while an idle wardrobe keeps a stable ETag and the
 * poll can be answered with a 304 (see routes/wardrobe.ts). This is a WEAK ETag:
 * it tracks the `user_fragrances` rows, not byte-for-byte response equality —
 * image hydration is intentionally excluded from the key, so the client must
 * fetch unconditionally on focus to pick up opportunistic image improvements.
 */
export function wardrobeVersionEtag(
  count: number,
  maxUpdated: Date | string | null,
): string {
  const safeCount = Number.isFinite(count) ? count : 0;
  const ms = maxUpdated ? new Date(maxUpdated).getTime() : 0;
  const safeMs = Number.isFinite(ms) ? ms : 0;
  return `W/"wardrobe-${safeCount}-${safeMs}"`;
}
