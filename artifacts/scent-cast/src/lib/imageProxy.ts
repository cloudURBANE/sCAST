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
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  const base = `/api/image-proxy?url=${encodeURIComponent(url)}`;
  if (options?.packshot) return `${base}&trim=1`;
  return base;
}
