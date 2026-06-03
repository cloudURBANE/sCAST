/**
 * Route remote http(s) images through `/api/image-proxy`. Without this, hosts that
 * block hotlinks or strip referrers return 403. Data URIs pass through.
 */
export type ProxiedImageOptions = {
  /** Adds `trim=1` for packshot edge normalization (JPEG). Use from bottle UI only. */
  packshot?: boolean;
  /** Test hook; defaults to Vite's configured backend origin. */
  apiBaseUrl?: string;
};

function warnInvalidApiBase(envName: string, message: string) {
  if (typeof console !== "undefined") {
    console.warn(`[imageProxy] ${envName}: ${message}`);
  }
}

export function normalizeApiBaseUrl(raw: string | undefined, envName = "VITE_API_BASE_URL"): string {
  const value = raw?.trim();
  if (!value) return "";

  const candidates = value.split(",").map((candidate) => candidate.trim()).filter(Boolean);
  if (candidates.length > 1) {
    warnInvalidApiBase(envName, `expected one origin, got ${candidates.length}; using the first valid origin.`);
  }

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {
      // Try the next candidate below.
    }
  }

  warnInvalidApiBase(envName, "does not contain a valid http(s) origin; falling back to same-origin /api.");
  return "";
}

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env?.VITE_API_BASE_URL as string | undefined);

function apiUrl(path: string, apiBaseUrl = API_BASE_URL): string {
  return apiBaseUrl ? `${apiBaseUrl}${path}` : path;
}

/**
 * Optional comma-separated allowlist of CDN origins/prefixes we control and that
 * serve our already-processed image objects (e.g. a Supabase public bucket base
 * or a CDN domain fronting it). URLs under these are rendered directly instead of
 * being re-fetched through `/api/image-proxy`. Origin- or prefix-match.
 */
function parseImageCdnBases(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((candidate) => candidate.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

const IMAGE_CDN_BASES = parseImageCdnBases(import.meta.env?.VITE_IMAGE_CDN_BASES as string | undefined);

/**
 * True when `url` points at one of our already-processed image objects, which are
 * served from a CDN-backed bucket with long immutable Cache-Control. These never
 * need the proxy — sending them through `/api/image-proxy` only adds a full origin
 * hop (browser → edge → Railway → fetch → CDN) for zero benefit. Genuinely
 * third-party hotlink sources (search candidates, raw Fragrantica/Basenotes
 * thumbnails) are NOT matched here, so they keep using the proxy.
 *
 * Processed objects always live under `images/processed/` (enforced backend-side
 * by `assertSafeStorageKey`). Supabase public URLs and local object URLs keep that
 * path literal; Firebase's `?alt=media` form percent-encodes the slashes, so we
 * match `images%2Fprocessed%2F` too. The CDN-base allowlist is an explicit escape
 * hatch for custom CDN domains where the path heuristic alone is undesirable.
 */
export function isProcessedStorageImageUrl(url: string, cdnBases: string[] = IMAGE_CDN_BASES): boolean {
  if (url.includes("/images/processed/") || /images%2[fF]processed%2[fF]/.test(url)) {
    return true;
  }
  return cdnBases.some((base) => url === base || url.startsWith(`${base}/`));
}

export function proxiedImageUrl(url: string | undefined | null, options?: ProxiedImageOptions): string {
  if (!url) return "";
  let u = url.trim();
  if (u.startsWith("data:")) return u;
  // Protocol-relative CDN URLs: normalize so we route through image-proxy.
  if (u.startsWith("//")) u = `https:${u}`;

  const apiBaseUrl =
    options?.apiBaseUrl !== undefined
      ? normalizeApiBaseUrl(options.apiBaseUrl, "apiBaseUrl")
      : API_BASE_URL;
  if (u.startsWith("/api/image-objects/")) {
    // Processed image objects are already normalized WebPs from our backend.
    // Sending them back through image-proxy is unnecessary, and in local dev it
    // can fail SSRF protection because the proxy would fetch localhost.
    return apiUrl(u, apiBaseUrl);
  }

  if (!/^https?:\/\//i.test(u)) return u;

  // Phase 1: our own processed images are already served immutable from a
  // CDN-backed bucket, so render them directly and skip the proxy entirely.
  // The full URL (including any v= cache-buster) is preserved as-is, and the
  // packshot trim is intentionally ignored — these are processed transparent
  // WebPs that must not be JPEG-trimmed (the backend proxy skips trim for them
  // too). Only third-party hotlink sources fall through to /api/image-proxy.
  if (isProcessedStorageImageUrl(u)) return u;

  // Read v= from the upstream URL so the proxy URL itself can vary by version
  // (helps the browser and any in-front CDN treat each version as distinct).
  // CRITICAL: do not strip v= from the upstream URL before encoding it. The
  // upstream storage object (Firebase / Supabase) is served with long
  // immutable Cache-Control, and the only way to bust an in-front CDN/proxy
  // for that storage fetch is to keep v= on the URL the proxy actually fetches.
  let version: string | null = null;
  try {
    const parsed = new URL(u);
    version = parsed.searchParams.get("v");
  } catch {
    // malformed URL: use as-is without extracting version
  }
  const base = `${apiUrl("/api/image-proxy", apiBaseUrl)}?url=${encodeURIComponent(u)}${version !== null ? `&v=${encodeURIComponent(version)}` : ""}`;
  if (options?.packshot) return `${base}&trim=1`;
  return base;
}
