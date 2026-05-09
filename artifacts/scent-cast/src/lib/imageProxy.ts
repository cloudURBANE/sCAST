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
  // Extract v= before encoding so the proxy URL itself varies by version,
  // ensuring both browser and any in-front CDN treat each version as distinct.
  let version: string | null = null;
  try {
    const parsed = new URL(u);
    version = parsed.searchParams.get("v");
    parsed.searchParams.delete("v");
    u = parsed.toString();
  } catch {
    // malformed URL — use as-is without extracting version
  }
  const base = `/api/image-proxy?url=${encodeURIComponent(u)}${version !== null ? `&v=${encodeURIComponent(version)}` : ""}`;
  if (options?.packshot) return `${base}&trim=1`;
  return base;
}
