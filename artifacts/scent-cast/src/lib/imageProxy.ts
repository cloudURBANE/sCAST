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
