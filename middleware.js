/**
 * Root-level Vercel middleware for deployments from repository root.
 * Proxies /api/* to BACKEND_ORIGIN (e.g. Railway) to keep browser calls same-origin.
 */
export const config = {
  matcher: "/api/:path*",
  runtime: "nodejs",
};

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
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  /** @type {RequestInit & { duplex?: "half" }} */
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    return await fetch(targetUrl, init);
  } catch {
    return new Response(
      JSON.stringify({
        error: "Could not reach API backend. Check BACKEND_ORIGIN on Vercel.",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
