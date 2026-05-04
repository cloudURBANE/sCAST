/**
 * Proxies /api/* to BACKEND_ORIGIN (e.g. Railway) so the public site stays
 * https://scent-cast-explore.vercel.app while OAuth and APIs hit one browser origin.
 *
 * Set BACKEND_ORIGIN in Vercel → Environment Variables (no trailing slash), e.g.
 * https://your-service.up.railway.app
 *
 * Implemented as .js (not .ts) so Vercel’s middleware bundler is not affected by
 * tsconfig.json "noEmit": true, which otherwise yields "Emit skipped".
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

  return fetch(targetUrl, init);
}
