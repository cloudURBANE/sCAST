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
  runtime: "nodejs",
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
  "host",
  "content-length",
];

/** @param {Request} request @returns {Promise<Response>} */
export default async function middleware(request) {
  const backend = process.env.BACKEND_ORIGIN?.trim().replace(/\/+$/, "");
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
    if (!HOP_BY_HOP.includes(key.toLowerCase())) headers.set(key, value);
  }
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  let body;
  if (!NO_BODY_METHODS.has(request.method)) {
    try {
      body = await request.arrayBuffer();
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
