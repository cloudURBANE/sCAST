import type { RequestHandler, Response } from "express";

/**
 * Cache-Control safety net for /api responses (post-cutover parity).
 *
 * The deleted Vercel edge middleware (middleware.js) applied this to every
 * proxied /api/* response. CloudFront's /api/* behavior forwards origin
 * headers untouched and its CachingDisabled policy adds none of its own, so
 * after the cutover an /api response that forgets Cache-Control ships with no
 * caching directives at all. Same semantics as the old edge function:
 *
 *   - a response carrying Set-Cookie is forced to `private, no-store` (and
 *     CDN override headers are dropped) even when a route set something
 *     cacheable, so a session can never land in a shared cache;
 *   - otherwise `private, no-store` is applied only when the route set no
 *     Cache-Control of its own (image proxy / wardrobe / SSE keep theirs).
 */

const SAFETY_CACHE_CONTROL = "private, no-store";

export function applyApiCacheSafetyHeaders(res: Response): void {
  if (res.getHeader("set-cookie")) {
    res.setHeader("Cache-Control", SAFETY_CACHE_CONTROL);
    res.removeHeader("CDN-Cache-Control");
    res.removeHeader("Vercel-CDN-Cache-Control");
    return;
  }

  if (!res.getHeader("cache-control")) {
    res.setHeader("Cache-Control", SAFETY_CACHE_CONTROL);
  }
}

// Wrapping writeHead (the on-headers pattern) instead of setting the header
// up front: the Set-Cookie override must see the FINAL headers, and routes
// set both Cache-Control and cookies at arbitrary points before send.
export const apiCacheSafety: RequestHandler = (_req, res, next) => {
  const originalWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    applyApiCacheSafetyHeaders(res);
    return originalWriteHead(...args);
  }) as typeof res.writeHead;
  next();
};
