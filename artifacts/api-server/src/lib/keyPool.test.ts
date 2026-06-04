import assert from "node:assert/strict";
import test from "node:test";
import { KeyPool, parseKeyList } from "./keyPool.ts";

test("parseKeyList splits comma/space/newline and dedupes", () => {
  assert.deepEqual(parseKeyList("a, b\nc  d", undefined, "a,e"), ["a", "b", "c", "d", "e"]);
});

test("fromEnv prefers plural value and falls back to singular", () => {
  const plural = KeyPool.fromEnv("svc", ["k1,k2", "legacy"]);
  assert.equal(plural.size, 3); // both sources merged, deduped
  const singularOnly = KeyPool.fromEnv("svc", [undefined, "legacy"]);
  assert.equal(singularOnly.size, 1);
});

test("run returns no_keys when pool is empty", async () => {
  const pool = new KeyPool("empty", []);
  const res = await pool.run(async () => ({ ok: true as const, value: 1 }));
  assert.deepEqual(res, { ok: false, reason: "no_keys" });
});

test("run sticks to the same key across calls while it succeeds", async () => {
  const pool = new KeyPool("svc", ["k1", "k2", "k3"]);
  const used: string[] = [];
  const attempt = async (key: string) => {
    used.push(key);
    return { ok: true as const, value: key };
  };
  await pool.run(attempt);
  await pool.run(attempt);
  assert.deepEqual(used, ["k1", "k1"]); // drains one key, doesn't round-robin on success
});

test("retire rotates to the next key within a single run and never returns to it", async () => {
  const pool = new KeyPool("svc", ["dead", "good"]);
  const used: string[] = [];
  const res = await pool.run(async (key) => {
    used.push(key);
    if (key === "dead") return { ok: false as const, action: "retire" as const };
    return { ok: true as const, value: key };
  });
  assert.deepEqual(res, { ok: true, value: "good" });
  assert.deepEqual(used, ["dead", "good"]);

  // The retired key is gone for good; next run starts at "good".
  const used2: string[] = [];
  await pool.run(async (key) => {
    used2.push(key);
    return { ok: true as const, value: key };
  });
  assert.deepEqual(used2, ["good"]);
  assert.equal(pool.availableCount(), 1);
});

test("cooldown makes a key temporarily unavailable, then revives after the window", async () => {
  const pool = new KeyPool("svc", ["limited"], { rateLimitCooldownMs: 50 });
  const first = await pool.run(async () => ({ ok: false as const, action: "cooldown" as const }));
  assert.deepEqual(first, { ok: false, reason: "all_exhausted" });
  assert.equal(pool.availableCount(), 0);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(pool.availableCount(), 1);
  const second = await pool.run(async () => ({ ok: true as const, value: "ok" }));
  assert.deepEqual(second, { ok: true, value: "ok" });
});

test("stop halts the loop without burning other keys", async () => {
  const pool = new KeyPool("svc", ["k1", "k2"]);
  const used: string[] = [];
  const res = await pool.run(async (key) => {
    used.push(key);
    return { ok: false as const, action: "stop" as const };
  });
  assert.deepEqual(res, { ok: false, reason: "stopped" });
  assert.deepEqual(used, ["k1"]); // k2 untouched
  assert.equal(pool.availableCount(), 2); // no key penalized
});

test("skip tries the next key without penalizing the skipped one", async () => {
  const pool = new KeyPool("svc", ["flaky", "good"]);
  const res = await pool.run(async (key) =>
    key === "flaky" ? { ok: false as const, action: "skip" as const } : { ok: true as const, value: key },
  );
  assert.deepEqual(res, { ok: true, value: "good" });
  assert.equal(pool.availableCount(), 2); // flaky not retired/cooled
});

test("addKeys appends new keys and revives retired ones", async () => {
  const pool = new KeyPool("svc", ["dead"]);
  await pool.run(async () => ({ ok: false as const, action: "retire" as const }));
  assert.equal(pool.availableCount(), 0);

  // Re-adding the same retired key revives it; a brand-new key is appended.
  const added = pool.addKeys(["dead", "fresh"]);
  assert.equal(added, 2);
  assert.equal(pool.size, 2);
  assert.equal(pool.availableCount(), 2);
});

test("snapshot reports masked keys and per-key status", async () => {
  const pool = new KeyPool("svc", ["abcd1234efgh5678"], { rateLimitCooldownMs: 1000 });
  await pool.run(async () => ({ ok: false as const, action: "cooldown" as const }));
  const snap = pool.snapshot();
  assert.equal(snap.name, "svc");
  assert.equal(snap.size, 1);
  assert.equal(snap.available, 0);
  assert.equal(snap.keys[0].status, "cooling_down");
  assert.ok(!snap.keys[0].key.includes("1234efgh"), "raw key must not leak in snapshot");
  assert.match(snap.keys[0].key, /^abcd…5678$/);
});
