import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSessionTurn,
  loadSession,
  loadSessionHistory,
  loadSessionState,
  saveSessionState,
  __setSessionRedisForTests,
} from "./beamSessionStore.ts";
import type { RedisLike } from "../lib/redisClient.ts";
import type { BeamRunContext } from "./types.ts";

let seq = 0;
function ctx(): BeamRunContext {
  // Unique session per test so the module-global in-memory Map can't leak state
  // between tests.
  seq += 1;
  return { runId: `run_${seq}`, sessionId: `s_${seq}`, tenantId: "t1", userId: "u1" };
}

/** Minimal RedisLike fake backed by a Map (only get/set/del are exercised here). */
class FakeRedis implements RedisLike {
  private store = new Map<string, string>();
  async eval(): Promise<unknown> {
    throw new Error("unused");
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  // Stream methods are unused by the session store; present to satisfy RedisLike.
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

test("in-memory: empty history, then round-trips appended turns", async () => {
  __setSessionRedisForTests(async () => null);
  const c = ctx();
  assert.deepEqual(await loadSessionHistory(c), []);

  await appendSessionTurn(c, "hi", "hello");
  const history = await loadSessionHistory(c);
  assert.deepEqual(history, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
});

test("in-memory: saves structured state without appending a transcript turn", async () => {
  __setSessionRedisForTests(async () => null);
  const c = ctx();
  await saveSessionState(c, {
    slots: { destination: "Tokyo", month: "August" },
    mission: { intent: "travel_kit", ownedCount: 2, newCount: 2, destination: "Tokyo", month: "August" },
  });

  assert.deepEqual(await loadSessionHistory(c), []);
  const state = await loadSessionState(c);
  assert.equal(state.slots.destination, "Tokyo");
  assert.equal(state.mission?.ownedCount, 2);

  await appendSessionTurn(c, "August and artsy", "Done", state);
  const session = await loadSession(c);
  assert.equal(session.turns.length, 2);
  assert.equal(session.state.slots.month, "August");
});

test("in-memory: caps history at the most recent 16 turns", async () => {
  __setSessionRedisForTests(async () => null);
  const c = ctx();
  for (let i = 0; i < 20; i += 1) {
    await appendSessionTurn(c, `u${i}`, `a${i}`);
  }
  const history = await loadSessionHistory(c);
  assert.equal(history.length, 16);
  // Oldest dropped; newest kept.
  assert.deepEqual(history[history.length - 2], { role: "user", content: "u19" });
  assert.deepEqual(history[history.length - 1], { role: "assistant", content: "a19" });
});

test("in-memory: sessions are isolated by key", async () => {
  __setSessionRedisForTests(async () => null);
  const a = ctx();
  const b = ctx();
  await appendSessionTurn(a, "for-a", "reply-a");
  assert.deepEqual(await loadSessionHistory(b), []);
});

test("redis: round-trips through the shared store", async () => {
  const client = new FakeRedis();
  __setSessionRedisForTests(async () => client);
  const c = ctx();
  assert.deepEqual(await loadSessionHistory(c), []);

  await appendSessionTurn(c, "q1", "r1");
  await appendSessionTurn(c, "q2", "r2");
  const history = await loadSessionHistory(c);
  assert.deepEqual(history, [
    { role: "user", content: "q1" },
    { role: "assistant", content: "r1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "r2" },
  ]);
});

test("redis: preserves state and reads old array-only records", async () => {
  const client = new FakeRedis();
  __setSessionRedisForTests(async () => client);
  const c = ctx();
  await client.set(
    "beam:session:t1:u1:" + c.sessionId,
    JSON.stringify([{ role: "user", content: "old" }]),
    "PX",
    1000,
  );
  assert.deepEqual(await loadSessionHistory(c), [{ role: "user", content: "old" }]);
  assert.deepEqual(await loadSessionState(c), { slots: {} });

  await saveSessionState(c, { slots: { month: "August" } });
  await appendSessionTurn(c, "q1", "r1");
  const session = await loadSession(c);
  assert.equal(session.state.slots.month, "August");
  assert.equal(session.turns.length, 3);
});

test("redis: corrupt entry is treated as empty, not thrown", async () => {
  const client = new FakeRedis();
  __setSessionRedisForTests(async () => client);
  const c = ctx();
  await client.set("beam:session:t1:u1:" + c.sessionId, "{not json", "PX", 1000);
  assert.deepEqual(await loadSessionHistory(c), []);
});

test("redis: a store error degrades to in-memory (no throw)", async () => {
  const throwing: RedisLike = {
    eval: async () => 0,
    get: async () => {
      throw new Error("redis down");
    },
    set: async () => {
      throw new Error("redis down");
    },
    del: async () => 0,
    xadd: async () => null,
    xrange: async () => [],
    pexpire: async () => 1,
  };
  __setSessionRedisForTests(async () => throwing);
  const c = ctx();
  // Append falls back to memory; load also fails over to memory and finds it.
  await appendSessionTurn(c, "hi", "there");
  const history = await loadSessionHistory(c);
  assert.deepEqual(history, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "there" },
  ]);
});

/**
 * RedisLike fake that yields the event loop on every get/set, so a naive
 * read-modify-write would interleave: two concurrent appends would both read the
 * same prior turns before either writes, and the second write would clobber the
 * first. The per-session mutex must prevent that.
 */
class SlowFakeRedis implements RedisLike {
  private store = new Map<string, string>();
  async eval(): Promise<unknown> {
    throw new Error("unused");
  }
  async get(key: string): Promise<string | null> {
    await Promise.resolve(); // yield, exposing any unserialized interleave
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    await Promise.resolve(); // yield
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
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

test("redis: concurrent appends to one session are serialized (no lost/reordered turns)", async () => {
  const client = new SlowFakeRedis();
  __setSessionRedisForTests(async () => client);
  const c = ctx();
  // Fire both without awaiting between them; the per-key lock must order them.
  await Promise.all([appendSessionTurn(c, "q1", "r1"), appendSessionTurn(c, "q2", "r2")]);

  const history = await loadSessionHistory(c);
  // Both exchanges present, in order, with no loss or duplication.
  assert.deepEqual(history, [
    { role: "user", content: "q1" },
    { role: "assistant", content: "r1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "r2" },
  ]);
});

test("in-memory: concurrent appends to one session are serialized", async () => {
  __setSessionRedisForTests(async () => null);
  const c = ctx();
  await Promise.all([appendSessionTurn(c, "q1", "r1"), appendSessionTurn(c, "q2", "r2")]);

  const history = await loadSessionHistory(c);
  assert.equal(history.length, 4);
  assert.deepEqual(history, [
    { role: "user", content: "q1" },
    { role: "assistant", content: "r1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "r2" },
  ]);
});

test("concurrent saveSessionState + appendSessionTurn for one session don't clobber", async () => {
  const client = new SlowFakeRedis();
  __setSessionRedisForTests(async () => client);
  const c = ctx();
  await appendSessionTurn(c, "q1", "r1");
  // A state save racing an append: both touch the same record; the lock must let
  // the append's turn survive and the state save's slots survive.
  await Promise.all([
    saveSessionState(c, { slots: { month: "August" } }),
    appendSessionTurn(c, "q2", "r2"),
  ]);

  const session = await loadSession(c);
  assert.equal(session.turns.length, 4); // both appends survived
  assert.equal(session.state.slots.month, "August"); // state save survived
});

test("different session keys are NOT serialized against each other (both persist)", async () => {
  const client = new SlowFakeRedis();
  __setSessionRedisForTests(async () => client);
  const a = ctx();
  const b = ctx();
  await Promise.all([appendSessionTurn(a, "for-a", "reply-a"), appendSessionTurn(b, "for-b", "reply-b")]);

  assert.deepEqual(await loadSessionHistory(a), [
    { role: "user", content: "for-a" },
    { role: "assistant", content: "reply-a" },
  ]);
  assert.deepEqual(await loadSessionHistory(b), [
    { role: "user", content: "for-b" },
    { role: "assistant", content: "reply-b" },
  ]);
});

// Restore the default backend for any later-loaded suites in the same process.
test("teardown: restore default redis getter", () => {
  __setSessionRedisForTests(async () => null);
});
