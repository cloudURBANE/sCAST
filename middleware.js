/**
 * Root-level Vercel middleware for deployments from repository root.
 * Proxies /api/* to BACKEND_ORIGIN (e.g. Railway) to keep browser calls same-origin.
 *
 * Body handling: buffers the request body to an ArrayBuffer before forwarding
 * because Vercel runtime rejects forwarding ReadableStream bodies via fetch
 * (even with duplex: "half") on POST/PUT/PATCH/DELETE.
 */
export const config = {
  matcher: "/api/:path*",
};

const NO_BODY_METHODS = new Set(["GET", "HEAD"]);
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const BLOCKED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  "host",
  "origin",
  "referer",
  "accept-encoding",
  "content-length",
]);

function normalizeBackendOrigin(raw) {
  const value = raw?.trim();
  if (!value) return "";

  const candidates = value.split(",").map((candidate) => candidate.trim()).filter(Boolean);
  if (candidates.length > 1) {
    console.warn(
      `[middleware] BACKEND_ORIGIN expected one origin, got ${candidates.length}; using the first valid origin.`,
    );
  }

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {
      // Try the next candidate.
    }
  }

  console.warn("[middleware] BACKEND_ORIGIN does not contain a valid http(s) origin.");
  return "";
}

/** @param {Request} request @returns {Promise<Response>} */
export async function middleware(request) {
  const backend = normalizeBackendOrigin(process.env.BACKEND_ORIGIN);
  if (!backend) {
    return new Response(
      JSON.stringify({
        error:
          "Set BACKEND_ORIGIN on Vercel to your API origin (e.g. https://xxx.up.railway.app)",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  const url = new URL(request.url);
  const targetUrl = `${backend}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);

  let body;
  if (!NO_BODY_METHODS.has(request.method)) {
    try {
      const buffered = await request.arrayBuffer();
      body = buffered.byteLength > 0 ? buffered : undefined;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Failed to read request body for proxy" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
  }

  const init = {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  };

  try {
    const upstream = await fetch(targetUrl, init);
    const passthrough = new Headers(upstream.headers);
    HOP_BY_HOP.forEach((h) => passthrough.delete(h));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: passthrough,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return new Response(
      JSON.stringify({
        error: "Could not reach API backend. Check BACKEND_ORIGIN on Vercel.",
        detail: message,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
