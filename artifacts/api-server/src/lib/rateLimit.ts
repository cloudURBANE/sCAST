import type { NextFunction, Request, Response } from "express";
import { getRedis, isRedisConfigured, type RedisLike } from "./redisClient.ts";
import { logger } from "./logger.ts";

// Fixed-window rate limiting with a pluggable store. The default store is the
// process-local `FixedWindowRateLimiter` below (zero-dependency, zero-latency).
// When REDIS_URL is configured the middleware additionally backs the window with
// a shared Redis counter so the limit holds ACROSS replicas and survives a
// redeploy — and falls straight back to the in-memory window if Redis is
// unreachable, so a cache outage can never 500 a request. The two stores share
// the same `RateLimitDecision` shape, exactly the "swap the store behind the
// same interface" seam this file was originally written to leave open.

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
  /**
   * Stable namespace for the Redis counter keys. REQUIRED for correctness once
   * Redis is enabled: two routes that both key by IP would otherwise collide on
   * one shared counter, and the name must be constant across restarts/replicas
   * so the window isn't reset by a redeploy. Ignored by the in-memory store
   * (each middleware already owns a private Map). Defaults to a limit/window
   * signature, but always pass an explicit, descriptive name at the call site.
   */
  name?: string;
};

/**
 * Redis-backed fixed window. Implemented with the canonical INCR + PEXPIRE
 * pattern: the first request in a window sets the TTL, subsequent requests just
 * increment, and the key self-expires at window end. Any Redis error (including
 * "not yet connected") transparently degrades to the shared in-memory limiter,
 * so this is strictly additive — it can only ever make the limit MORE correct,
 * never break a request.
 */
export class RedisRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly keyPrefix: string;
  private readonly fallback: FixedWindowRateLimiter;
  private readonly getClient: () => Promise<RedisLike | null>;
  private loggedError = false;

  constructor(opts: {
    limit: number;
    windowMs: number;
    name: string;
    fallback: FixedWindowRateLimiter;
    /** Injectable for tests; defaults to the shared client. */
    getClient?: () => Promise<RedisLike | null>;
  }) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.keyPrefix = `ratelimit:${opts.name}:`;
    this.fallback = opts.fallback;
    this.getClient = opts.getClient ?? getRedis;
  }

  async check(key: string, now: number = Date.now()): Promise<RateLimitDecision> {
    let client: RedisLike | null;
    try {
      client = await this.getClient();
    } catch {
      client = null;
    }
    if (!client) return this.fallback.check(key, now);

    const redisKey = this.keyPrefix + key;
    try {
      const count = await client.incr(redisKey);
      let resetAt: number;
      if (count === 1) {
        await client.pexpire(redisKey, this.windowMs);
        resetAt = now + this.windowMs;
      } else {
        const ttl = await client.pttl(redisKey);
        if (ttl < 0) {
          // No TTL (e.g. a crash between INCR and PEXPIRE left a persistent key).
          // Repair it so the window can't get stuck open forever.
          await client.pexpire(redisKey, this.windowMs);
          resetAt = now + this.windowMs;
        } else {
          resetAt = now + ttl;
        }
      }
      return {
        allowed: count <= this.limit,
        remaining: Math.max(0, this.limit - count),
        resetAt,
      };
    } catch (err) {
      if (!this.loggedError) {
        this.loggedError = true;
        logger.warn({ err }, "redis rate limiter error — falling back to in-memory window");
      }
      return this.fallback.check(key, now);
    }
  }
}

/**
 * Express middleware enforcing a per-key fixed-window limit. Emits standard
 * `X-RateLimit-*` headers and a 429 with `Retry-After` when exceeded.
 */
export function rateLimitMiddleware(opts: RateLimitMiddlewareOptions) {
  const keyFn = opts.keyFn ?? clientKey;
  // The in-memory window is always present: it's the sole store when Redis is
  // unconfigured, and the fallback for the Redis store when it's configured.
  const memory = new FixedWindowRateLimiter(opts.limit, opts.windowMs);
  const redis = isRedisConfigured()
    ? new RedisRateLimiter({
        limit: opts.limit,
        windowMs: opts.windowMs,
        name: opts.name ?? `${opts.limit}:${opts.windowMs}`,
        fallback: memory,
      })
    : null;
  let requestsSinceSweep = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if ((requestsSinceSweep = (requestsSinceSweep + 1) & 0x3f) === 0) memory.sweep(now);

    const apply = (decision: RateLimitDecision): void => {
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

    if (redis) {
      // The Redis limiter already degrades to `memory` internally; the extra
      // catch is belt-and-suspenders so a rejected promise can never hang a req.
      redis.check(keyFn(req), now).then(apply, () => apply(memory.check(keyFn(req), now)));
    } else {
      apply(memory.check(keyFn(req), now));
    }
  };
}
