/**
 * Brand + name identity used to tell whether a search result is already in the
 * vault. Adding a fragrance replaces the engine id with a fresh local id, so the
 * row's original id can't be matched back. Brand + name is the stable signal
 * shared across the search result and the saved vault entry.
 */
export function vaultIdentityKey(brand?: string | null, name?: string | null): string {
  const norm = (value?: string | null) =>
    (value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const b = norm(brand);
  const n = norm(name);
  if (!n) return '';
  return `${b}|${n}`;
}
