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

function shouldLogLocalDev(request) {
  if (process.env.NODE_ENV !== "development") return false;
  try {
    const hostname = new URL(request.url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function debugLog(request, location, message, data, hypothesisId = "H1") {
  if (!shouldLogLocalDev(request)) return;
  fetch(
    "http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "82096a",
      },
      body: JSON.stringify({
        sessionId: "82096a",
        runId: "pre-fix",
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
      }),
    },
  ).catch(() => {});
}

/** @param {Request} request @returns {Promise<Response>} */
export async function middleware(request) {
  debugLog(
    request,
    "middleware.js:30",
    "Middleware entry",
    {
      method: request.method,
      url: request.url,
      hostHeader: request.headers.get("host"),
    },
    "H1",
  );
  const backend = normalizeBackendOrigin(process.env.BACKEND_ORIGIN);
  debugLog(
    request,
    "middleware.js:32",
    "BACKEND_ORIGIN resolution",
    {
      hasBackendOrigin: Boolean(process.env.BACKEND_ORIGIN),
      resolvedBackend: backend || null,
    },
    "H1",
  );
  if (!backend) {
    debugLog(
      request,
      "middleware.js:35",
      "Early return missing backend origin",
      {
        path: new URL(request.url).pathname,
        search: new URL(request.url).search,
      },
      "H2",
    );
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
  debugLog(
    request,
    "middleware.js:47",
    "Proxy target computed",
    {
      pathname: url.pathname,
      search: url.search,
      targetUrl,
    },
    "H3",
  );

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
    debugLog(
      request,
      "middleware.js:79",
      "Upstream fetch success",
      {
        status: upstream.status,
        statusText: upstream.statusText,
        targetUrl,
      },
      "H4",
    );
    const passthrough = new Headers(upstream.headers);
    HOP_BY_HOP.forEach((h) => passthrough.delete(h));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: passthrough,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    debugLog(
      request,
      "middleware.js:89",
      "Upstream fetch failed",
      { targetUrl, error: message },
      "H4",
    );
    return new Response(
      JSON.stringify({
        error: "Could not reach API backend. Check BACKEND_ORIGIN on Vercel.",
        detail: message,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
