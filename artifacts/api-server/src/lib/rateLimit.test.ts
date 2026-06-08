import test from "node:test";
import assert from "node:assert/strict";
import { FixedWindowRateLimiter } from "./rateLimit.ts";

test("allows up to the limit then denies within the window", () => {
  const limiter = new FixedWindowRateLimiter(3, 1000);
  const t0 = 1_000_000;
  assert.equal(limiter.check("a", t0).allowed, true);
  assert.equal(limiter.check("a", t0 + 1).allowed, true);
  const third = limiter.check("a", t0 + 2);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  assert.equal(limiter.check("a", t0 + 3).allowed, false);
});

test("resets after the window elapses", () => {
  const limiter = new FixedWindowRateLimiter(1, 1000);
  const t0 = 5_000_000;
  assert.equal(limiter.check("k", t0).allowed, true);
  assert.equal(limiter.check("k", t0 + 999).allowed, false);
  // At/after resetAt a fresh window opens.
  assert.equal(limiter.check("k", t0 + 1000).allowed, true);
});

test("tracks keys independently", () => {
  const limiter = new FixedWindowRateLimiter(1, 1000);
  const t0 = 9_000_000;
  assert.equal(limiter.check("ip-1", t0).allowed, true);
  assert.equal(limiter.check("ip-2", t0).allowed, true);
  assert.equal(limiter.check("ip-1", t0).allowed, false);
});

test("sweep drops only expired windows", () => {
  const limiter = new FixedWindowRateLimiter(1, 1000);
  const t0 = 2_000_000;
  limiter.check("old", t0);
  limiter.check("fresh", t0 + 900);
  limiter.sweep(t0 + 1500);
  // "old" window expired and was swept -> a new request is allowed again.
  assert.equal(limiter.check("old", t0 + 1500).allowed, true);
  // "fresh" window still active -> still counted, so it denies.
  assert.equal(limiter.check("fresh", t0 + 1500).allowed, false);
});
