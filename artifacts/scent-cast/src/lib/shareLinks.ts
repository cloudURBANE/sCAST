export function publicShareBuyLinkEndpoint(userRef: string, fragranceId: string): string {
  return `/api/share/${encodeURIComponent(userRef)}/fragrances/${encodeURIComponent(fragranceId)}/buy-link`;
}
