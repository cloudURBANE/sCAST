import type { NextFunction, Request, Response } from "express";

// Lightweight in-memory fixed-window rate limiter. Intentionally process-local:
// the API runs as a single Railway instance, so a shared store (Redis) would be
// over-engineering here. If the deployment ever scales horizontally, swap the
// FixedWindowRateLimiter store for a shared backend behind the same interface.

export type RateLimitDecision = {
  allowed: boolean;
  /** Requests still permitted in the current window (>= 0). */
  remaining: number;
  /** Epoch-ms when the current window resets. */
  resetAt: number;
};

export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      const resetAt = now + this.windowMs;
      this.hits.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: Math.max(0, this.limit - 1), resetAt };
    }
    if (entry.count >= this.limit) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }
    entry.count += 1;
    return { allowed: true, remaining: this.limit - entry.count, resetAt: entry.resetAt };
  }

  /** Drop expired windows so the map does not grow without bound. */
  sweep(now: number = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }
}

function clientKey(req: Request): string {
  // `trust proxy` is enabled in app.ts, so req.ip is the real client behind the
  // Railway/Vercel proxy chain.
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export type RateLimitMiddlewareOptions = {
  limit: number;
  windowMs: number;
  keyFn?: (req: Request) => string;
};

/**
 * Express middleware enforcing a per-key fixed-window limit. Emits standard
 * `X-RateLimit-*` headers and a 429 with `Retry-After` when exceeded.
 */
export function rateLimitMiddleware(opts: RateLimitMiddlewareOptions) {
  const limiter = new FixedWindowRateLimiter(opts.limit, opts.windowMs);
  const keyFn = opts.keyFn ?? clientKey;
  let requestsSinceSweep = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if ((requestsSinceSweep = (requestsSinceSweep + 1) & 0x3f) === 0) limiter.sweep(now);

    const decision = limiter.check(keyFn(req), now);
    res.setHeader("X-RateLimit-Limit", String(opts.limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, decision.remaining)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));

    if (!decision.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((decision.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ error: `Rate limit exceeded. Try again in ${retryAfterSec}s.` });
      return;
    }
    next();
  };
}
