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
  // A raw Fragrantica url as the DISPLAY url is the un-processed fallback
  // itself (processed pipeline objects always live on our own storage), no
  // matter what provider label the row carries — including rows that never got
  // one (e.g. a client payload that persisted the engine's image_url verbatim).
  if (isFragranticaImageUrl(nonEmptyString(candidate.imageUrl) ?? undefined)) {
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
 * and the crawled Fragrantica fallback is never DISPLAYABLE at all
 * (owner-rejected: it is a data-source giveaway that never matches the
 * processed vault look). A crawled candidate is treated as "no image": the
 * other candidate wins if it is clean, otherwise the tile honestly shows its
 * placeholder while the background Serper self-heal upgrades the row.
 */
export function chooseHydratedImageUrlWithMetadata(
  shared: HydratedImageCandidate | null | undefined,
  current: HydratedImageCandidate | null | undefined,
): string {
  const currentImageUrl = nonEmptyString(current?.imageUrl);
  const sharedImageUrl = nonEmptyString(shared?.imageUrl);

  const currentCand = currentImageUrl ? { ...(current ?? {}), imageUrl: currentImageUrl } : null;
  const sharedCand = sharedImageUrl ? { ...(shared ?? {}), imageUrl: sharedImageUrl } : null;

  // Hard display gate: the Fragrantica fallback (crawled provider, processed
  // crawled copy, raw fimgs.net/fragrantica.* display url, or the legacy
  // crawled-stamped-"manual" window) is never returned from here.
  const currentUsable = currentCand && !isCrawledImage(currentCand) ? currentImageUrl : null;
  const sharedUsable = sharedCand && !isCrawledImage(sharedCand) ? sharedImageUrl : null;

  if (!currentUsable) return sharedUsable ?? "";
  if (!sharedUsable) return currentUsable;

  // Both candidates are clean from here on.
  const currentIsManual = isManualImage(currentCand!);
  const sharedIsManual = isManualImage(sharedCand!);

  if (sharedIsManual && !currentIsManual) return sharedUsable;
  if (currentIsManual && !sharedIsManual) return currentUsable;

  if (isManualOrGeneratedImage(currentCand!)) return currentUsable;
  if (isManualOrGeneratedImage(sharedCand!)) return sharedUsable;

  return currentUsable;
}
