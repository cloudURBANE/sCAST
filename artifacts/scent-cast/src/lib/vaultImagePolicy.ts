/**
 * Client-side mirror of the server's crawled-fallback display gate
 * (api-server/src/services/imageProvenanceCore.ts).
 *
 * The engine-crawled Fragrantica share image is owner-rejected site-wide: it
 * never matches the processed vault packshots and it gives the data source
 * away. Server hydration already blanks it on every API response, but guest
 * wardrobes (localStorage) and optimistic adds never round-trip through the
 * server — this filter keeps those paths honest too, so the tile shows its
 * "Fetching…"/"No image" placeholder instead of the fallback while the image
 * pipeline resolves a real packshot.
 */

const FRAGRANTICA_IMAGE_URL_RE = /fimgs\.net|fragrantica\./i;
const CRAWLED_STORAGE_SEGMENT = 'images/processed/crawled/';

export function isBlockedVaultImageUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  return (
    FRAGRANTICA_IMAGE_URL_RE.test(trimmed) ||
    trimmed.toLowerCase().includes(CRAWLED_STORAGE_SEGMENT)
  );
}

/** Returns the url unchanged when displayable, '' when it is the blocked fallback. */
export function displayableVaultImageUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  return trimmed && !isBlockedVaultImageUrl(trimmed) ? trimmed : '';
}

/**
 * Resolve every image spelling produced by the fragrance engines before the
 * guest/optimistic add path converts it to the canonical camelCase field.
 * `imageUrl` stays authoritative when present, matching the server write gate.
 */
export function resolveDisplayableVaultImageUrl(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const canonical = [record.imageUrl, record.image_url, record.image].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
  return displayableVaultImageUrl(canonical);
}
