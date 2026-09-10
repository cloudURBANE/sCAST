// Cost-bearing public routes now distinguish paid and free signed-in accounts.
// Attach a session ONLY to this app's API, never the external fragrance engine.
export function launchFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (typeof window === "undefined" || !window.location?.href)
    return globalThis.fetch(input, init);
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.href,
  );
  const appOrigin = new URL(
    import.meta.env?.VITE_API_BASE_URL || window.location.origin,
  ).origin;
  if (url.origin !== appOrigin || !url.pathname.startsWith("/api/"))
    return globalThis.fetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  try {
    const token = localStorage.getItem("scent_token");
    if (token && !headers.has("Authorization"))
      headers.set("Authorization", `Bearer ${token}`);
  } catch {
    /* blocked storage leaves the request anonymous */
  }
  return globalThis.fetch(input, { ...init, headers });
}
