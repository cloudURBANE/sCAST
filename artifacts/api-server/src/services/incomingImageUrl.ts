export function parseIncomingImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  if (s.startsWith("data:image/")) {
    if (s.length > 4_000_000) return null;
    return s;
  }
  if (s.startsWith("/api/image-objects/images/processed/")) {
    return s;
  }
  try {
    const u = new URL(s);
    if (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.pathname.startsWith("/api/image-objects/images/processed/")
    ) {
      return `${u.pathname}${u.search}`;
    }
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    return null;
  }
  return null;
}
