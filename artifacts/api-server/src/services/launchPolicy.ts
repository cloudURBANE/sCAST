export type Feature = "ai" | "search" | "image";
export function costFeature(method: string, path: string): Feature | null {
  const p = path.toLowerCase().replace(/\/+$/, "");
  if (method === "OPTIONS") return null;
  if (p.startsWith("/engine/")) return "search";
  if ((method === "GET" || method === "HEAD") && p === "/fragrances/search")
    return "search";
  if (method === "POST" && p === "/fragrances/details") return "search";
  if (
    method === "POST" &&
    ["/reimagine-bottle-image", "/refresh-image"].includes(p)
  )
    return "image";
  if (
    method === "POST" &&
    [
      "/beam-agent/runs",
      "/scent-mission",
      "/reviews/summarize",
      "/scent-facts/enrich",
    ].includes(p)
  )
    return "ai";
  if (method === "POST" && ["/scent-profile", "/search-scent"].includes(p))
    return "search";
  return null;
}
export function hasPaidAccess(
  status: string,
  accessUntil: Date | string | null,
  now = Date.now(),
): boolean {
  return (
    status === "active" &&
    accessUntil !== null &&
    new Date(accessUntil).getTime() > now
  );
}
export function nonnegativeInteger(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2_000_000_000)
    throw new Error("Invalid launch limit");
  return n;
}
export function allowance(
  feature: Feature,
  paid: boolean,
  env = process.env,
): number {
  const defaults = paid
    ? { ai: 40, search: 200, image: 2 }
    : { ai: 5, search: 20, image: 0 };
  return nonnegativeInteger(
    env[`LAUNCH_${paid ? "PAID" : "FREE"}_${feature.toUpperCase()}_MONTHLY`],
    defaults[feature],
  );
}
export function reservationCost(feature: Feature, env = process.env): number {
  // No invented provider prices: enable only after measuring and configuring.
  const value = nonnegativeInteger(
    env[`LAUNCH_${feature.toUpperCase()}_RESERVE_MICROUSD`],
    0,
  );
  if (value === 0)
    throw new Error("Launch cost reservations are not configured");
  return value;
}
