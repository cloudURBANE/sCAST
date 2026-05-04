/**
 * Proxies /api/* to BACKEND_ORIGIN (e.g. Railway) so the public site stays
 * https://scent-cast-explore.vercel.app while OAuth and APIs hit one browser origin.
 *
 * Set BACKEND_ORIGIN in Vercel → Environment Variables (no trailing slash), e.g.
 * https://your-service.up.railway.app
 */
export const config = {
  matcher: "/api/:path*",
  runtime: "nodejs",
};

export default async function middleware(request: Request): Promise<Response> {
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

  const init: RequestInit & { duplex?: "half" } = {
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
