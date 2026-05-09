import { createHash } from "node:crypto";

export const IMAGE_PIPELINE_VERSION = "bg-v4-alpha-safe";

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSourceUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.protocol = parsed.protocol.toLowerCase();

  const sorted = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  parsed.search = "";
  for (const [key, value] of sorted) {
    if (/^(utm_|fbclid$|gclid$|igshid$)/i.test(key)) continue;
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}

export function hashSourceUrl(rawUrl: string): string {
  return hashString(normalizeSourceUrl(rawUrl));
}

export function hashSearchQuery(query: string): string {
  return hashString(query.trim().toLowerCase().replace(/\s+/g, " "));
}

function slugLookupKey(lookupKey: string | null | undefined): string {
  if (!lookupKey) return "unscoped";
  const slug = lookupKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || hashString(lookupKey).slice(0, 16);
}

export function buildProcessedImageStorageKey(input: {
  sourceProvider: string;
  lookupKey?: string | null;
  sourceUrlHash: string;
  pipelineVersion?: string;
  extension?: "webp" | "png" | "jpg";
  /**
   * Hash of the final encoded image bytes. When provided, a 12-char prefix is
   * appended to the storage filename so storage keys vary by output content.
   *
   * This matters because storage uploads use long immutable Cache-Control. If
   * the same key is reused to host different pixels (e.g. an old white-bg
   * fallback overwritten by a fresh transparent packshot), the browser/CDN/
   * proxy can keep serving the stale object even after the DB row points to a
   * successful transparent result. Including the content hash in the key
   * forces a new immutable object whenever the rendered image changes.
   */
  contentHash?: string;
}): string {
  const provider = input.sourceProvider.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "unknown";
  const lookup = slugLookupKey(input.lookupKey);
  const version = (input.pipelineVersion ?? IMAGE_PIPELINE_VERSION).replace(/[^a-z0-9_-]+/gi, "-");
  const extension = input.extension ?? "webp";
  const contentSuffix =
    input.contentHash && /^[a-f0-9]+$/i.test(input.contentHash)
      ? `-${input.contentHash.slice(0, 12).toLowerCase()}`
      : "";
  return `images/processed/${provider}/${lookup}/${input.sourceUrlHash}-${version}${contentSuffix}.${extension}`;
}
