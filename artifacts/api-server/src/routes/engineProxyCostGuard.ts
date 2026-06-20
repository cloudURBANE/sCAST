import type { Request, Response, NextFunction } from "express";
import { rateLimitMiddleware } from "../lib/rateLimit.ts";

// Standalone (db-free) so it can be unit-tested without booting the auth/db
// modules. See fragranceEngineProxy.ts for why this guard exists instead of a
// hard login requirement.

export type GuardedRequest = Request & { user?: unknown };

/**
 * Per-IP cost guard for the engine proxy. The proxy forwards search/detail
 * lookups to the paid Decodo/engine backend, and in production the SPA routes
 * ALL engine calls through it same-origin — including for logged-out guests — so
 * requiring login would break public fragrance search. Instead we cap callers
 * with a per-IP fixed window: a STRICT limit for anonymous clients (so a
 * logged-out caller cannot drive unbounded paid scraping) and a GENEROUS limit
 * for authenticated, accountable users. The two windows are independent
 * limiters, so the anon cap can never throttle a signed-in user sharing an IP.
 */
export function createEngineProxyCostGuard(opts: {
  anonLimit: number;
  authedLimit: number;
  windowMs: number;
}) {
  const anon = rateLimitMiddleware({
    name: "engine-proxy-anon",
    limit: opts.anonLimit,
    windowMs: opts.windowMs,
  });
  const authed = rateLimitMiddleware({
    name: "engine-proxy-auth",
    limit: opts.authedLimit,
    windowMs: opts.windowMs,
  });
  return (req: GuardedRequest, res: Response, next: NextFunction): void => {
    (req.user ? authed : anon)(req, res, next);
  };
}
