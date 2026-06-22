import test from "node:test";
import assert from "node:assert/strict";
import { FixedWindowRateLimiter, RedisRateLimiter } from "./rateLimit.ts";
import type { RedisLike } from "./redisClient.ts";

/**
 * Minimal in-process fake of the RedisLike slice the limiter uses, with TTL
 * expiry driven by an explicit clock so the window-reset path is testable
 * without a real server. Keep `now` in step with the `now` passed to check().
 */
class FakeRedis implements RedisLike {
  now = 0;
  private store = new Map<string, { value: string; expireAt: number | null }>();

  private live(key: string): { value: string; expireAt: number | null } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expireAt !== null && this.now >= e.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  /** Seed a persistent (no-TTL) counter, simulating INCR-without-PEXPIRE. */
  seedNoTtl(key: string, value: number): void {
    this.store.set(key, { value: String(value), expireAt: null });
  }

  /**
   * Executes the fixed-window script the limiter ships: INCR, arm the TTL on the
   * first hit, self-heal a missing TTL, and return [count, ttlMs]. (The real Lua
   * is verified against a live server separately; this mirrors its semantics so
   * the limiter's decision + fallback logic stays unit-testable offline.)
   */
  async eval(_script: string, _numKeys: number, key: string, windowMs: string | number): Promise<unknown> {
    const ms = Number(windowMs);
    const e = this.live(key);
    const count = (e ? Number(e.value) : 0) + 1;
    const entry = { value: String(count), expireAt: e?.expireAt ?? null };
    this.store.set(key, entry);
    let ttl: number;
    if (count === 1) {
      entry.expireAt = this.now + ms;
      ttl = ms;
    } else if (entry.expireAt === null) {
      entry.expireAt = this.now + ms;
      ttl = ms;
    } else {
      ttl = entry.expireAt - this.now;
    }
    return [count, ttl];
  }
  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, _mode: "PX", ttlMs: number): Promise<unknown> {
    this.store.set(key, { value, expireAt: this.now + ttlMs });
    return "OK";
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  // Stream methods are unused by the limiter; present to satisfy RedisLike.
  async xadd(): Promise<string | null> {
    return null;
  }
  async xrange(): Promise<Array<[string, string[]]>> {
    return [];
  }
  async pexpire(): Promise<number> {
    return 1;
  }
}

function makeLimiter(opts: {
  limit: number;
  windowMs: number;
  name: string;
  client: RedisLike | null;
  fallback?: FixedWindowRateLimiter;
}) {
  return new RedisRateLimiter({
    limit: opts.limit,
    windowMs: opts.windowMs,
    name: opts.name,
    fallback: opts.fallback ?? new FixedWindowRateLimiter(opts.limit, opts.windowMs),
    getClient: async () => opts.client,
  });
}

test("redis limiter: allows up to the limit then denies within the window", async () => {
  const client = new FakeRedis();
  const limiter = makeLimiter({ limit: 2, windowMs: 1000, name: "t", client });

  client.now = 1000;
  const a = await limiter.check("ip", 1000);
  assert.equal(a.allowed, true);
  assert.equal(a.remaining, 1);
  assert.equal(a.resetAt, 2000);

  client.now = 1001;
  const b = await limiter.check("ip", 1001);
  assert.equal(b.allowed, true);
  assert.equal(b.remaining, 0);
  // resetAt stays anchored to the first request's window.
  assert.equal(b.resetAt, 2000);

  client.now = 1002;
  const c = await limiter.check("ip", 1002);
  assert.equal(c.allowed, false);
  assert.equal(c.remaining, 0);
  assert.equal(c.resetAt, 2000);
});

test("redis limiter: window resets after the TTL elapses", async () => {
  const client = new FakeRedis();
  const limiter = makeLimiter({ limit: 1, windowMs: 1000, name: "t", client });

  client.now = 5000;
  assert.equal((await limiter.check("k", 5000)).allowed, true);
  client.now = 5999;
  assert.equal((await limiter.check("k", 5999)).allowed, false);
  // At/after the TTL a fresh window opens.
  client.now = 6000;
  assert.equal((await limiter.check("k", 6000)).allowed, true);
});

test("redis limiter: names namespace counters so routes don't collide", async () => {
  const client = new FakeRedis();
  client.now = 1000;
  const a = makeLimiter({ limit: 1, windowMs: 1000, name: "route-a", client });
  const b = makeLimiter({ limit: 1, windowMs: 1000, name: "route-b", client });

  assert.equal((await a.check("ip", 1000)).allowed, true);
  assert.equal((await a.check("ip", 1000)).allowed, false);
  // Same IP, different route name => independent budget.
  assert.equal((await b.check("ip", 1000)).allowed, true);
});

test("redis limiter: repairs a key that lost its TTL", async () => {
  const client = new FakeRedis();
  const limiter = makeLimiter({ limit: 5, windowMs: 1000, name: "t", client });
  // Simulate a persistent key (INCR ran, PEXPIRE didn't): seed count with no TTL.
  client.seedNoTtl("ratelimit:t:ip", 1); // value 1, no expiry
  client.now = 2000;
  const decision = await limiter.check("ip", 2000);
  assert.equal(decision.allowed, true);
  // The script saw ttl < 0 and re-armed the window.
  assert.equal(decision.resetAt, 3000);
});

test("redis limiter: falls back to in-memory when the client errors", async () => {
  const throwing: RedisLike = {
    eval: async () => {
      throw new Error("redis down");
    },
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
    xadd: async () => null,
    xrange: async () => [],
    pexpire: async () => 1,
  };
  const fallback = new FixedWindowRateLimiter(1, 1000);
  const limiter = makeLimiter({ limit: 1, windowMs: 1000, name: "t", client: throwing, fallback });

  // First call served by the in-memory fallback (allowed), second denied — proving
  // the fallback is actually enforcing, not silently allowing everything.
  assert.equal((await limiter.check("ip", 1000)).allowed, true);
  assert.equal((await limiter.check("ip", 1000)).allowed, false);
});

test("redis limiter: falls back to in-memory when no client is available", async () => {
  const fallback = new FixedWindowRateLimiter(1, 1000);
  const limiter = makeLimiter({ limit: 1, windowMs: 1000, name: "t", client: null, fallback });
  assert.equal((await limiter.check("ip", 1000)).allowed, true);
  assert.equal((await limiter.check("ip", 1000)).allowed, false);
});
