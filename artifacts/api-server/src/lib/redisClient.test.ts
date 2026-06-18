import test from "node:test";
import assert from "node:assert/strict";
import { announceRedisMode, isRedisConfigured } from "./redisClient.ts";
import { logger } from "./logger.ts";

function withRedisUrl(value: string | undefined, fn: () => void): void {
  const prev = process.env.REDIS_URL;
  if (value === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  }
}

/** Capture calls to one logger level for the duration of `fn`, then restore it. */
function captureLevel(level: "warn" | "info", fn: () => void): unknown[][] {
  const original = logger[level] as unknown;
  const calls: unknown[][] = [];
  (logger as unknown as Record<string, unknown>)[level] = (...args: unknown[]): undefined => {
    calls.push(args);
    return undefined;
  };
  try {
    fn();
  } finally {
    (logger as unknown as Record<string, unknown>)[level] = original;
  }
  return calls;
}

test("isRedisConfigured: false when REDIS_URL is unset or blank, true when set", () => {
  withRedisUrl(undefined, () => assert.equal(isRedisConfigured(), false));
  withRedisUrl("   ", () => assert.equal(isRedisConfigured(), false));
  withRedisUrl("redis://localhost:6379", () => assert.equal(isRedisConfigured(), true));
});

test("announceRedisMode: warns (ephemeral) when REDIS_URL is unset", () => {
  withRedisUrl(undefined, () => {
    const warns = captureLevel("warn", () => {
      const infos = captureLevel("info", () => announceRedisMode());
      assert.equal(infos.length, 0, "must not log the durable-mode info line");
    });
    assert.equal(warns.length, 1, "must warn exactly once about ephemeral state");
    assert.match(String(warns[0][0]), /in-memory only/);
  });
});

test("announceRedisMode: info (durable) when REDIS_URL is set", () => {
  withRedisUrl("redis://localhost:6379", () => {
    const infos = captureLevel("info", () => {
      const warns = captureLevel("warn", () => announceRedisMode());
      assert.equal(warns.length, 0, "must not warn when Redis is configured");
    });
    assert.equal(infos.length, 1, "must log the durable-mode info line once");
    assert.match(String(infos[0][0]), /shared state backend enabled/);
  });
});
