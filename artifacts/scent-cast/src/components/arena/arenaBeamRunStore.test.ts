import assert from "node:assert/strict";
import test from "node:test";
import {
  readBeamRunStats,
  recordBeamPowerClaim,
  recordBeamRunEnd,
} from "./arenaBeamRunStore.ts";

const STORAGE_KEY = "scentbeam_arena_beam_runs_v1";

type TestContext = { after: (fn: () => void) => void };

function installFakeWindow(t: TestContext): Map<string, string> {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const hadWindow = "window" in globalThis;
  const previous = (globalThis as Record<string, unknown>).window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
  t.after(() => {
    if (hadWindow) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
  return data;
}

test("readBeamRunStats returns zeros when nothing is stored", (t) => {
  installFakeWindow(t);
  assert.deepEqual(readBeamRunStats("guest"), {
    bestScore: 0,
    totalRuns: 0,
    totalBeamPower: 0,
  });
});

test("run ends and power claims round-trip through storage", (t) => {
  installFakeWindow(t);

  const first = recordBeamRunEnd("guest", 12);
  assert.equal(first.isNewBest, true);
  assert.deepEqual(first.stats, { bestScore: 12, totalRuns: 1, totalBeamPower: 0 });

  const second = recordBeamRunEnd("guest", 5);
  assert.equal(second.isNewBest, false);
  assert.deepEqual(second.stats, { bestScore: 12, totalRuns: 2, totalBeamPower: 0 });

  const third = recordBeamRunEnd("guest", 20);
  assert.equal(third.isNewBest, true);
  assert.equal(third.stats.bestScore, 20);
  assert.equal(third.stats.totalRuns, 3);

  assert.deepEqual(recordBeamPowerClaim("guest", 3), {
    bestScore: 20,
    totalRuns: 3,
    totalBeamPower: 3,
  });
  assert.equal(recordBeamPowerClaim("guest", 30).totalBeamPower, 33);

  assert.deepEqual(readBeamRunStats("guest"), {
    bestScore: 20,
    totalRuns: 3,
    totalBeamPower: 33,
  });
});

test("a zero-score first run is never a new best", (t) => {
  installFakeWindow(t);
  const result = recordBeamRunEnd("guest", 0);
  assert.equal(result.isNewBest, false);
  assert.deepEqual(result.stats, { bestScore: 0, totalRuns: 1, totalBeamPower: 0 });
});

test("stats are isolated per userKey", (t) => {
  installFakeWindow(t);
  recordBeamRunEnd("guest", 9);
  recordBeamRunEnd("user@example.com", 30);
  recordBeamPowerClaim("user@example.com", 7);

  assert.deepEqual(readBeamRunStats("guest"), {
    bestScore: 9,
    totalRuns: 1,
    totalBeamPower: 0,
  });
  assert.deepEqual(readBeamRunStats("user@example.com"), {
    bestScore: 30,
    totalRuns: 1,
    totalBeamPower: 7,
  });
});

test("corrupt storage falls back to zeros instead of throwing", (t) => {
  const data = installFakeWindow(t);

  data.set(STORAGE_KEY, "not-json{{{");
  assert.deepEqual(readBeamRunStats("guest"), {
    bestScore: 0,
    totalRuns: 0,
    totalBeamPower: 0,
  });

  data.set(
    STORAGE_KEY,
    JSON.stringify({
      guest: { bestScore: -5, totalRuns: "many", totalBeamPower: 2.9 },
      other: "nope",
    }),
  );
  assert.deepEqual(readBeamRunStats("guest"), {
    bestScore: 0,
    totalRuns: 0,
    totalBeamPower: 2,
  });
  assert.deepEqual(readBeamRunStats("other"), {
    bestScore: 0,
    totalRuns: 0,
    totalBeamPower: 0,
  });

  // Writing on top of corrupt data repairs the entry.
  const repaired = recordBeamRunEnd("guest", 10);
  assert.equal(repaired.isNewBest, true);
  assert.deepEqual(readBeamRunStats("guest"), {
    bestScore: 10,
    totalRuns: 1,
    totalBeamPower: 2,
  });
});

test("non-finite scores and claims are sanitized to zero", (t) => {
  installFakeWindow(t);
  const result = recordBeamRunEnd("guest", Number.NaN);
  assert.equal(result.isNewBest, false);
  assert.deepEqual(result.stats, { bestScore: 0, totalRuns: 1, totalBeamPower: 0 });
  assert.equal(recordBeamPowerClaim("guest", Number.POSITIVE_INFINITY).totalBeamPower, 0);
  assert.equal(recordBeamPowerClaim("guest", -4).totalBeamPower, 0);
});

test("no window at all degrades gracefully without throwing", (t) => {
  if (typeof (globalThis as Record<string, unknown>).window !== "undefined") {
    t.skip("runtime provides a window global; nothing to verify here");
    return;
  }
  assert.deepEqual(readBeamRunStats("guest"), {
    bestScore: 0,
    totalRuns: 0,
    totalBeamPower: 0,
  });
  const result = recordBeamRunEnd("guest", 9);
  assert.equal(result.isNewBest, true);
  assert.deepEqual(result.stats, { bestScore: 9, totalRuns: 1, totalBeamPower: 0 });
  // Nothing persisted, so the next read is still zeros.
  assert.equal(readBeamRunStats("guest").totalRuns, 0);
});
