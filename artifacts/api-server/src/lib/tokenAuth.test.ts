import test from "node:test";
import assert from "node:assert/strict";
import {
  hashToken,
  resolveTokenTtl,
  evaluateTokenExpiry,
  shouldRefreshLastUsed,
} from "./tokenAuth.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

test("hashToken is a stable, non-plaintext SHA-256 hex digest", () => {
  const token = "11111111-1111-4111-8111-111111111111";
  const hash = hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
  assert.equal(hash, hashToken(token)); // deterministic
  assert.notEqual(hash, hashToken("22222222-2222-4222-8222-222222222222"));
});

test("resolveTokenTtl defaults to 90d absolute / 30d idle", () => {
  const ttl = resolveTokenTtl({});
  assert.equal(ttl.absoluteMs, 90 * DAY_MS);
  assert.equal(ttl.idleMs, 30 * DAY_MS);
});

test("resolveTokenTtl reads positive overrides and ignores junk", () => {
  assert.equal(
    resolveTokenTtl({ TOKEN_ABSOLUTE_TTL_DAYS: "7", TOKEN_IDLE_TTL_DAYS: "2" }).absoluteMs,
    7 * DAY_MS,
  );
  assert.equal(
    resolveTokenTtl({ TOKEN_ABSOLUTE_TTL_DAYS: "7", TOKEN_IDLE_TTL_DAYS: "2" }).idleMs,
    2 * DAY_MS,
  );
  // non-positive / non-numeric fall back to defaults
  assert.equal(resolveTokenTtl({ TOKEN_ABSOLUTE_TTL_DAYS: "0" }).absoluteMs, 90 * DAY_MS);
  assert.equal(resolveTokenTtl({ TOKEN_IDLE_TTL_DAYS: "nope" }).idleMs, 30 * DAY_MS);
});

test("evaluateTokenExpiry: null timestamps never expire (legacy rows)", () => {
  const now = Date.now();
  const ttl = resolveTokenTtl({});
  assert.deepEqual(
    evaluateTokenExpiry({ issuedAt: null, lastUsedAt: null, now, ttl }),
    { expired: false },
  );
});

test("evaluateTokenExpiry: absolute TTL", () => {
  const now = Date.now();
  const ttl = resolveTokenTtl({});
  const fresh = new Date(now - 10 * DAY_MS);
  assert.equal(
    evaluateTokenExpiry({ issuedAt: fresh, lastUsedAt: fresh, now, ttl }).expired,
    false,
  );
  const old = new Date(now - 91 * DAY_MS);
  assert.deepEqual(
    evaluateTokenExpiry({ issuedAt: old, lastUsedAt: new Date(now), now, ttl }),
    { expired: true, reason: "absolute" },
  );
});

test("evaluateTokenExpiry: idle TTL", () => {
  const now = Date.now();
  const ttl = resolveTokenTtl({});
  const issued = new Date(now - 5 * DAY_MS);
  const idle = new Date(now - 31 * DAY_MS);
  assert.deepEqual(
    evaluateTokenExpiry({ issuedAt: issued, lastUsedAt: idle, now, ttl }),
    { expired: true, reason: "idle" },
  );
});

test("shouldRefreshLastUsed throttles to hourly", () => {
  const now = Date.now();
  assert.equal(shouldRefreshLastUsed(null, now), true);
  assert.equal(shouldRefreshLastUsed(new Date(now - 30 * 60 * 1000), now), false);
  assert.equal(shouldRefreshLastUsed(new Date(now - 61 * 60 * 1000), now), true);
});
