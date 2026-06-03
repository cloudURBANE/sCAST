export function publicShareBuyLinkEndpoint(userRef: string, fragranceId: string): string {
  return `/api/share/${encodeURIComponent(userRef)}/fragrances/${encodeURIComponent(fragranceId)}/buy-link`;
}

export function publicShareBuyLinksEndpoint(userRef: string, fragranceIds: string[]): string {
  const params = new URLSearchParams();
  for (const fragranceId of fragranceIds) {
    params.append("ids", fragranceId);
  }
  const query = params.toString();
  return `/api/share/${encodeURIComponent(userRef)}/buy-links${query ? `?${query}` : ""}`;
}
