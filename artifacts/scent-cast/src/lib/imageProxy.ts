/**
 * Route remote http(s) images through `/api/image-proxy`. Without this, hosts that
 * block hotlinks or strip referrers return 403. Data URIs pass through.
 */
export type ProxiedImageOptions = {
  /** Adds `trim=1` for packshot edge normalization (JPEG). Use from bottle UI only. */
  packshot?: boolean;
  /** Test hook; defaults to Vite's configured backend origin. */
  apiBaseUrl?: string;
  /**
   * Force routing through `/api/image-proxy` even for our own processed CDN
   * objects that would normally render directly. This is the Phase-4 client
   * fallback: when a direct CDN URL fails (e.g. a transient 403 from a
   * referrer/CDN policy), the UI retries the same object through the proxy once
   * before giving up. Local `/api/image-objects/...` and non-http(s) inputs are
   * still returned as-is (proxying localhost would fail SSRF and gains nothing).
   */
  forceProxy?: boolean;
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

const rawApiBase =
  (import.meta.env?.VITE_API_BASE_URL as string | undefined) ||
  (import.meta.env?.VITE_API_ORIGIN as string | undefined);
const API_BASE_URL = normalizeApiBaseUrl(rawApiBase);

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
 * Whether to render our processed objects DIRECTLY from the storage bucket
 * (browser → CDN), skipping `/api/image-proxy`. This is the lowest-latency path,
 * but it only works when the bucket object is publicly reachable from the browser
 * (public-read rules, correct public host, valid download token, no CORS/CORP
 * block). When any of those is off, the direct <img> 403/404s and the tile shows
 * "Unavailable".
 *
 * Defaults to OFF so processed images load through the same-origin proxy, which
 * reads the object with the server's storage credentials and is robust to bucket
 * misconfiguration. Set `VITE_IMAGE_DIRECT_CDN=true` to opt back into direct CDN
 * rendering once the bucket is confirmed publicly reachable.
 */
function envFlagEnabled(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

const DIRECT_CDN_ENABLED = envFlagEnabled(import.meta.env?.VITE_IMAGE_DIRECT_CDN);

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
  if (!u || u === "null" || u === "undefined") return "";
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

  const processed = isProcessedStorageImageUrl(u);

  // Our own processed images are immutable WebPs. When direct-CDN rendering is
  // explicitly enabled AND the object is publicly reachable, render them directly
  // and skip the proxy entirely (lowest latency). By default direct CDN is OFF,
  // so processed objects fall through to /api/image-proxy, which reads them with
  // the server's storage credentials — robust to a non-public/misconfigured
  // bucket. `forceProxy` (Phase-4 fallback) also routes through the proxy.
  if (!options?.forceProxy && processed && DIRECT_CDN_ENABLED) return u;

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
  // Never JPEG-trim our own processed objects — they are transparent WebPs and the
  // backend skips trim for them anyway.
  if (options?.packshot && !processed) return `${base}&trim=1`;
  return base;
}
