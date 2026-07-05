/**
 * Pure, dependency-free core for fragrance-payload schema versioning.
 *
 * Lives separately from fragrancePayload.ts so the bare node:test runner
 * (--experimental-strip-types) can import these helpers without following the
 * extensionless-import chain in fragrancePayload.ts. Matches the *Core pattern
 * used by scentEngineCore.ts and imagePipelineCore.ts. (Importing sibling pure
 * cores with explicit .ts extensions is fine for the bare runner.)
 */
import { isFragranticaImageUrl } from "./imageProvenanceCore.ts";

/**
 * Bump when the persisted user_fragrances payload shape changes in a way that
 * requires reading code to migrate or rebuilding code to refresh. Stamped onto
 * every write by `sanitizeFragrance`; consumers can use `isLegacyVaultRow` to
 * tell whether a row was written before the current shape was finalized.
 */
export const CURRENT_VAULT_SCHEMA_VERSION = 1;

export function isLegacyVaultRow(
  fragrance: Record<string, any> | null | undefined,
): boolean {
  if (!fragrance) return true;
  const version = fragrance.schemaVersion;
  return typeof version !== "number" || version < CURRENT_VAULT_SCHEMA_VERSION;
}

export function stampVaultSchemaVersion(
  fragrance: Record<string, any>,
): Record<string, any> {
  return { ...fragrance, schemaVersion: CURRENT_VAULT_SCHEMA_VERSION };
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * The external Python engine (and some legacy/search payloads) carry the bottle
 * image as snake_case `image_url` (or bare `image`), but every persistence,
 * hydration and render path in this app reads camelCase `imageUrl`. Without this
 * alias a *known* image is silently dropped the moment a fragrance is added —
 * stranding the tile on "No image" until the deferred background image pipeline
 * (which can fail, be misconfigured, or time out) happens to backfill it. Resolve
 * every known spelling to the canonical `imageUrl` so a present image survives.
 */
export function resolveCanonicalImageUrl(fragrance: Record<string, any>): unknown {
  return (
    nonEmptyString(fragrance.imageUrl) ??
    nonEmptyString(fragrance.image_url) ??
    nonEmptyString(fragrance.image) ??
    fragrance.imageUrl
  );
}

export function chooseHydratedImageUrl(
  sharedImageUrl: unknown,
  currentImageUrl: unknown,
): string {
  return nonEmptyString(currentImageUrl) ?? nonEmptyString(sharedImageUrl) ?? "";
}

export type HydratedImageCandidate = {
  imageUrl?: unknown;
  sourceProvider?: unknown;
  sourceUrl?: unknown;
  storagePath?: unknown;
  /** Orientation Engine geometry when this candidate is a normalized square. */
  imageProperties?: unknown;
};

function normalizedSourceProvider(value: unknown): string | null {
  const provider = nonEmptyString(value)?.toLowerCase();
  return provider ? provider.replace(/[_\s]+/g, "-") : null;
}

function candidateText(candidate: HydratedImageCandidate): string {
  return [
    candidate.imageUrl,
    candidate.sourceProvider,
    candidate.sourceUrl,
    candidate.storagePath,
  ]
    .map((value) => nonEmptyString(value)?.toLowerCase())
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function isOpenAiReimaginedImage(candidate: HydratedImageCandidate): boolean {
  const provider = normalizedSourceProvider(candidate.sourceProvider);
  if (provider === "openai" || provider === "openai-reimagine") return true;
  return candidateText(candidate).includes("openai-reimagine:");
}

function isManualImage(candidate: HydratedImageCandidate): boolean {
  const provider = normalizedSourceProvider(candidate.sourceProvider);
  if (provider === "manual") return true;
  const text = candidateText(candidate);
  return (
    text.includes("/images/processed/manual/") ||
    text.includes("images/processed/manual/")
  );
}

/**
 * The engine-crawled Fragrantica og:image fallback (see imageProvenanceCore).
 * Post-fix candidates carry sourceProvider "crawled" / a storage path under
 * images/processed/crawled/; legacy cache rows were stamped "manual" and are
 * recognized by their Fragrantica source URL. A "serper" candidate is never
 * crawled — the scorer may legitimately pick a fimgs.net candidate as the best
 * available packshot, and that scored choice keeps serper trust.
 */
function isCrawledImage(candidate: HydratedImageCandidate): boolean {
  const provider = normalizedSourceProvider(candidate.sourceProvider);
  if (provider === "crawled") return true;
  const text = candidateText(candidate);
  if (
    text.includes("/images/processed/crawled/") ||
    text.includes("images/processed/crawled/")
  ) {
    return true;
  }
  if (provider === "serper") return false;
  return (
    isFragranticaImageUrl(nonEmptyString(candidate.sourceUrl) ?? undefined) &&
    isManualImage(candidate)
  );
}

function isManualOrGeneratedImage(candidate: HydratedImageCandidate): boolean {
  if (isManualImage(candidate) || isOpenAiReimaginedImage(candidate)) return true;
  const text = candidateText(candidate);
  return (
    text.includes("/images/processed/openai/") ||
    text.includes("images/processed/openai/")
  );
}

/**
 * Row images are normally authoritative, but stale Serper/catalog row images
 * should not hide a newer generated/manual cache result for the same fragrance —
 * and the crawled Fragrantica fallback is never authoritative: a row that saved
 * the fallback upgrades to a non-crawled shared image the moment one exists.
 */
export function chooseHydratedImageUrlWithMetadata(
  shared: HydratedImageCandidate | null | undefined,
  current: HydratedImageCandidate | null | undefined,
): string {
  const currentImageUrl = nonEmptyString(current?.imageUrl);
  const sharedImageUrl = nonEmptyString(shared?.imageUrl);

  if (!currentImageUrl) return sharedImageUrl ?? "";
  if (!sharedImageUrl) return currentImageUrl;

  const currentCand = { ...(current ?? {}), imageUrl: currentImageUrl };
  const sharedCand = { ...(shared ?? {}), imageUrl: sharedImageUrl };

  // Legacy crawled copies were stamped "manual"; strip that mislabel before the
  // manual (human-curated) preference so the Fragrantica fallback can never
  // ride the curated fast-path.
  const currentIsCrawled = isCrawledImage(currentCand);
  const sharedIsCrawled = isCrawledImage(sharedCand);
  const currentIsManual = isManualImage(currentCand) && !currentIsCrawled;
  const sharedIsManual = isManualImage(sharedCand) && !sharedIsCrawled;

  if (sharedIsManual && !currentIsManual) return sharedImageUrl;
  if (currentIsManual && !sharedIsManual) return currentImageUrl;

  // Crawled demotion: a saved crawled fallback yields to any non-crawled shared
  // image (the deferred Serper upgrade lands in the cache first), and a row's
  // non-crawled image survives a crawled cache row.
  if (currentIsCrawled && !sharedIsCrawled) return sharedImageUrl;
  if (sharedIsCrawled && !currentIsCrawled) return currentImageUrl;

  // The mislabel strip applies here too: a legacy crawled copy stamped "manual"
  // must not win the generated/manual preference either.
  if (isManualOrGeneratedImage(currentCand) && !currentIsCrawled) {
    return currentImageUrl;
  }

  if (isManualOrGeneratedImage(sharedCand) && !sharedIsCrawled) {
    return sharedImageUrl;
  }

  return currentImageUrl;
}
