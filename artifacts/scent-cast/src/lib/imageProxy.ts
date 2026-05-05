/**
 * Route remote http(s) images through `/api/image-proxy`. Without this, hosts that
 * block hotlinks or strip referrers return 403. Data URIs and same-origin paths pass through.
 */
export function proxiedImageUrl(url: string | undefined | null): string {
  if (!url) return "";
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}
