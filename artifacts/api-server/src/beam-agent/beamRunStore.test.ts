import test from "node:test";
import assert from "node:assert/strict";
import type { RedisLike } from "../lib/redisClient.ts";
import type { BeamRunContext, BeamRunEvent } from "./types.ts";
import {
  __setRunStoreRedisForTests,
  appendRunEvent,
  clearActiveSession,
  createRunMeta,
  isRunDone,
  isRunStopped,
  loadRunMeta,
  markRunDone,
  markRunStopped,
  readRunEventsAfter,
  tryAcquireActiveSession,
} from "./beamRunStore.ts";

function ctx(overrides: Partial<BeamRunContext> = {}): BeamRunContext {
  return { runId: "run_1", sessionId: "sess_1", tenantId: "t1", userId: "u1", ...overrides };
}

/**
 * In-process RedisLike fake backed by Maps, with just enough stream support
 * (XADD/XRANGE) and the SET-NX-PX `eval` the run store uses. Stream entry ids are
 * a monotonic `<seq>-0`, so an exclusive `(<id>` start tails strictly after it.
 */
class FakeRedis implements RedisLike {
  private kv = new Map<string, string>();
  private streams = new Map<string, Array<{ id: string; seq: number; fields: string[] }>>();
  private seq = 0;

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.kv.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }
  // Implements the two scripts the run store ships: `SET key val PX ttl NX`
  // (acquire) and the GET-compare-DEL (owner-checked release).
  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = String(args[0]);
    const value = String(args[1]);
    if (script.includes("'DEL'")) {
      if (this.kv.get(key) === value) {
        this.kv.delete(key);
        return 1;
      }
      return 0;
    }
    if (this.kv.has(key)) return null;
    this.kv.set(key, value);
    return "OK";
  }
  async xadd(...args: (string | number)[]): Promise<string | null> {
    const key = String(args[0]);
    // Last two args are the single field/value pair ("d", json).
    const fields = [String(args[args.length - 2]), String(args[args.length - 1])];
    const id = `${++this.seq}-0`;
    const list = this.streams.get(key) ?? [];
    list.push({ id, seq: this.seq, fields });
    this.streams.set(key, list);
    return id;
  }
  async xrange(key: string, start: string): Promise<Array<[string, string[]]>> {
    const list = this.streams.get(key) ?? [];
    const afterSeq = start === "-" ? -Infinity : Number(start.replace(/^\(/, "").split("-")[0]);
    return list.filter((e) => e.seq > afterSeq).map((e) => [e.id, e.fields] as [string, string[]]);
  }
  async pexpire(): Promise<number> {
    return 1;
  }
}

/** RedisLike whose every command rejects — exercises the degrade-without-throw path. */
const throwing: RedisLike = {
  get: async () => {
    throw new Error("redis down");
  },
  set: async () => {
    throw new Error("redis down");
  },
  del: async () => {
    throw new Error("redis down");
  },
  eval: async () => {
    throw new Error("redis down");
  },
  xadd: async () => {
    throw new Error("redis down");
  },
  xrange: async () => {
    throw new Error("redis down");
  },
  pexpire: async () => {
    throw new Error("redis down");
  },
};

test("createRunMeta → loadRunMeta round-trips the run context", async () => {
  const redis = new FakeRedis();
  __setRunStoreRedisForTests(async () => redis);
  const c = ctx();
  await createRunMeta(c);
  const meta = await loadRunMeta(c.runId);
  assert.ok(meta);
  assert.deepEqual(meta?.ctx, c);
  assert.equal(typeof meta?.createdAt, "number");
});

test("appendRunEvent persists structural events in order and tails after a watermark", async () => {
  const redis = new FakeRedis();
  __setRunStoreRedisForTests(async () => redis);
  const c = ctx({ runId: "run_order" });
  const events: BeamRunEvent[] = [
    { type: "status", label: "thinking" },
    { type: "tool_started", tool: "beam_search_catalog" },
    { type: "completed", response: "here you go" },
  ];
  for (const e of events) await appendRunEvent(c.runId, e);

  const all = await readRunEventsAfter(c.runId, "0");
  assert.deepEqual(all.map((e) => e.event), events);

  // Tailing strictly after the first id returns only the later events.
  const tail = await readRunEventsAfter(c.runId, all[0].id);
  assert.deepEqual(tail.map((e) => e.event), events.slice(1));
});

test("appendRunEvent skips message_delta (not mirrored cross-replica)", async () => {
  const redis = new FakeRedis();
  __setRunStoreRedisForTests(async () => redis);
  const c = ctx({ runId: "run_delta" });
  await appendRunEvent(c.runId, { type: "status", label: "go" });
  await appendRunEvent(c.runId, { type: "message_delta", text: "tok" });
  await appendRunEvent(c.runId, { type: "completed", response: "done" });

  const all = await readRunEventsAfter(c.runId, "0");
  assert.deepEqual(
    all.map((e) => e.event.type),
    ["status", "completed"],
  );
});

test("done / stopped flags are independently set and read", async () => {
  const redis = new FakeRedis();
  __setRunStoreRedisForTests(async () => redis);
  const c = ctx({ runId: "run_flags" });
  assert.equal(await isRunDone(c.runId), false);
  assert.equal(await isRunStopped(c.runId), false);

  await markRunStopped(c.runId);
  assert.equal(await isRunStopped(c.runId), true);
  assert.equal(await isRunDone(c.runId), false, "stop must not imply done");

  await markRunDone(c.runId);
  assert.equal(await isRunDone(c.runId), true);
});

test("tryAcquireActiveSession enforces one active run per session, released on clear", async () => {
  const redis = new FakeRedis();
  __setRunStoreRedisForTests(async () => redis);
  const c = ctx({ runId: "run_a" });
  assert.equal(await tryAcquireActiveSession(c), true, "first acquire wins");
  assert.equal(
    await tryAcquireActiveSession(ctx({ runId: "run_b" })),
    false,
    "second run on the same session is blocked",
  );

  await clearActiveSession(c);
  assert.equal(await tryAcquireActiveSession(ctx({ runId: "run_c" })), true, "lock released");
});

test("a stale producer cannot release the lock a newer run of the same session holds", async () => {
  // A producer that outlived the lock TTL used to DEL unconditionally on its
  // terminal event, releasing the lock the NEWER run had since acquired — which
  // let a third run start concurrently on the same session.
  const redis = new FakeRedis();
  __setRunStoreRedisForTests(async () => redis);
  const stale = ctx({ runId: "run_stale" });
  const newer = ctx({ runId: "run_newer" });
  assert.equal(await tryAcquireActiveSession(newer), true, "newer run holds the lock");

  await clearActiveSession(stale); // stale terminal event — must be a no-op
  assert.equal(
    await tryAcquireActiveSession(ctx({ runId: "run_third" })),
    false,
    "the newer run's lock must survive a stale release",
  );

  await clearActiveSession(newer); // the owner releases normally
  assert.equal(await tryAcquireActiveSession(ctx({ runId: "run_third" })), true);
});

test("no-Redis: every function degrades to a safe no-op / default", async () => {
  __setRunStoreRedisForTests(async () => null);
  const c = ctx({ runId: "run_noredis" });
  await createRunMeta(c); // no throw
  assert.equal(await loadRunMeta(c.runId), null);
  await appendRunEvent(c.runId, { type: "status", label: "x" }); // no throw
  assert.deepEqual(await readRunEventsAfter(c.runId, "0"), []);
  assert.equal(await isRunDone(c.runId), false);
  assert.equal(await isRunStopped(c.runId), false);
  // Permissive so the in-memory guard remains the sole gate.
  assert.equal(await tryAcquireActiveSession(c), true);
  await clearActiveSession(c); // no throw
});

test("Redis errors degrade without throwing", async () => {
  __setRunStoreRedisForTests(async () => throwing);
  const c = ctx({ runId: "run_err" });
  await createRunMeta(c);
  assert.equal(await loadRunMeta(c.runId), null);
  await appendRunEvent(c.runId, { type: "status", label: "x" });
  assert.deepEqual(await readRunEventsAfter(c.runId, "0"), []);
  assert.equal(await isRunDone(c.runId), false);
  assert.equal(await isRunStopped(c.runId), false);
  await markRunDone(c.runId);
  await markRunStopped(c.runId);
  // tryAcquireActiveSession is permissive on error so a Redis outage never locks users out.
  assert.equal(await tryAcquireActiveSession(c), true);
  await clearActiveSession(c);
});
