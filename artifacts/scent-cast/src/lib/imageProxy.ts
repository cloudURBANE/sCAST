/**
 * Route remote http(s) images through `/api/image-proxy`. Without this, hosts that
 * block hotlinks or strip referrers return 403. Data URIs and same-origin paths pass through.
 */
export type ProxiedImageOptions = {
  /** Adds `trim=1` for packshot edge normalization (JPEG). Use from bottle UI only. */
  packshot?: boolean;
};

export function proxiedImageUrl(url: string | undefined | null, options?: ProxiedImageOptions): string {
  if (!url) return "";
  let u = url.trim();
  if (u.startsWith("data:")) return u;
  // Protocol-relative CDN URLs — normalize so we route through image-proxy.
  if (u.startsWith("//")) u = `https:${u}`;
  if (!/^https?:\/\//i.test(u)) return u;
  // Read v= from the upstream URL so the proxy URL itself can vary by version
  // (helps the browser and any in-front CDN treat each version as distinct).
  // CRITICAL: do NOT strip v= from the upstream URL before encoding it. The
  // upstream storage object (Firebase / Supabase) is served with long
  // immutable Cache-Control, and the only way to bust an in-front CDN/proxy
  // for that storage fetch is to keep v= on the URL the proxy actually fetches.
  // Stripping it here was the bug: clients saw fresh-looking proxy URLs while
  // the proxy still hit a stale cached storage object.
  let version: string | null = null;
  try {
    const parsed = new URL(u);
    version = parsed.searchParams.get("v");
    // intentionally do NOT delete `v` here — keep it on the upstream URL
  } catch {
    // malformed URL — use as-is without extracting version
  }
  const base = `/api/image-proxy?url=${encodeURIComponent(u)}${version !== null ? `&v=${encodeURIComponent(version)}` : ""}`;
  if (options?.packshot) return `${base}&trim=1`;
  return base;
}
