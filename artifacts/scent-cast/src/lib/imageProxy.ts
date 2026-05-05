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
  const base = `/api/image-proxy?url=${encodeURIComponent(u)}`;
  if (options?.packshot) return `${base}&trim=1`;
  return base;
}
