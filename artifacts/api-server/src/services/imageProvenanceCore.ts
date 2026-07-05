/**
 * Pure, dependency-free provenance helpers for processed fragrance images.
 *
 * Three automatic providers exist alongside the generated ("openai*") family:
 *   - "serper"  — winner of the scored, vision-gated Serper image search;
 *   - "crawled" — the engine's harvested Fragrantica og:image passthrough;
 *   - "manual"  — genuinely human-curated (admin upload / paste-URL / wardrobe
 *     PATCH override).
 *
 * "crawled" exists because the Fragrantica share image is a convenience
 * fallback, not a curated choice: it must never outrank the scored Serper
 * winner or a human-curated image. Before this provider was introduced the
 * crawled leg was stamped "manual", which handed the Fragrantica fallback top
 * trust everywhere — every fresh save displayed it, and cache/hydration
 * priority kept it pinned over better images. Rows written during that window
 * still carry sourceProvider "manual"; they are recognized here (and in the
 * SQL priority mirrors in imageCacheService.ts / fragrancePayload.ts) by their
 * Fragrantica source URL and demoted the same way.
 */

export const CRAWLED_SOURCE_PROVIDER = "crawled";

const CRAWLED_STORAGE_SEGMENT = "images/processed/crawled/";
const MANUAL_STORAGE_SEGMENT = "images/processed/manual/";

/**
 * Hosts Fragrantica serves its packshot/share images from (fimgs.net) plus any
 * fragrantica.* locale domain. Keep in sync with the ILIKE mirrors in
 * imageCacheService.sourceProviderPrioritySql and fragrancePayload's batch
 * hydration ORDER BY.
 */
const FRAGRANTICA_IMAGE_URL_RE = /fimgs\.net|fragrantica\./i;

export function isFragranticaImageUrl(url: unknown): boolean {
  return typeof url === "string" && FRAGRANTICA_IMAGE_URL_RE.test(url);
}

export type ImageProvenanceRef = {
  sourceProvider?: string | null;
  sourceUrl?: string | null;
  storagePath?: string | null;
};

/**
 * True when an image ref is (or predates but matches) the engine-crawled
 * Fragrantica fallback. A "serper" ref is never crawled — the Serper scorer may
 * legitimately pick a fimgs.net candidate as the best available packshot, and
 * that scored choice keeps serper trust.
 */
export function isCrawledImageProvenance(
  ref: ImageProvenanceRef | null | undefined,
): boolean {
  if (!ref) return false;
  const provider =
    typeof ref.sourceProvider === "string" ? ref.sourceProvider.trim().toLowerCase() : "";
  if (provider === CRAWLED_SOURCE_PROVIDER) return true;
  const storagePath = typeof ref.storagePath === "string" ? ref.storagePath.toLowerCase() : "";
  if (storagePath.includes(CRAWLED_STORAGE_SEGMENT)) return true;
  if (provider === "serper") return false;
  // Legacy window: engine-crawled Fragrantica images stamped "manual".
  const looksManual = provider === "manual" || storagePath.includes(MANUAL_STORAGE_SEGMENT);
  return looksManual && isFragranticaImageUrl(ref.sourceUrl ?? undefined);
}
