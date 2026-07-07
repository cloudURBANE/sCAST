/**
 * Beam Agent run registry — durable, cross-replica mirror (Phase 5).
 *
 * The in-memory `runs` Map in `beamAgentRoutes.ts` stays the FAST PATH: when the
 * `POST /runs` and the follow-up `GET /runs/:id/events` land on the same replica
 * (always true at `numReplicas: 1`, and the common case otherwise), the SSE attach
 * finds the local record and streams from it exactly as before — including live
 * `message_delta` tokens.
 *
 * This module is the BACKSTOP for the cross-replica / post-restart case that used
 * to 404 (`run_not_found`): the producing replica mirrors each run's structural
 * events into a Redis Stream plus a little metadata, so a consuming replica that
 * never saw the run can replay the buffer and poll-tail to completion.
 *
 * Design contract (mirrors `beamSessionStore.ts` / `redisClient.ts`):
 *   • When Redis is not configured/reachable, every function degrades to a no-op
 *     (or a permissive default) and the in-memory path behaves EXACTLY as today.
 *   • Nothing here throws — a Redis hiccup must never affect a run or its stream.
 *   • `message_delta` is deliberately NOT persisted (hundreds per run); a
 *     cross-replica viewer still gets status → tools → card → the full `completed`
 *     response, which carries the answer text regardless.
 */
import { getRedis, type RedisLike } from "../lib/redisClient.ts";
import { logger } from "../lib/logger.ts";
import type { BeamRunContext, BeamRunEvent } from "./types.ts";

/** Runs are ~1 min; the TTL only has to bound the replay window after they end. */
const RUN_TTL_MS = 30 * 60_000;
/** The active-session lock self-heals if a producer dies without releasing it. */
const ACTIVE_LOCK_TTL_MS = 5 * 60_000;
/** Cap the per-run event stream so a runaway run can't grow it without bound. */
const EVENTS_MAXLEN = 512;

const META_PREFIX = "beam:run:meta:";
const EVENTS_PREFIX = "beam:run:events:";
const DONE_PREFIX = "beam:run:done:";
const STOPPED_PREFIX = "beam:run:stopped:";
const ACTIVE_PREFIX = "beam:run:active:";
/** Single stream field holding the JSON-encoded event. */
const EVENT_FIELD = "d";

/** Injectable Redis getter so tests can supply a fake (or force the no-op path). */
type GetClient = () => Promise<RedisLike | null>;
let getClient: GetClient = getRedis;

/** Test-only seam to swap the backend. */
export function __setRunStoreRedisForTests(fn: GetClient): void {
  getClient = fn;
}

/** Persisted run metadata — immutable after creation (flags live in their own keys). */
export type BeamRunMeta = {
  ctx: BeamRunContext;
  createdAt: number;
};

/** One replayed/tailed event plus its stream id (the poll watermark). */
export type BeamRunEventEntry = { id: string; event: BeamRunEvent };

function activeKey(ctx: BeamRunContext): string {
  return `${ACTIVE_PREFIX}${ctx.tenantId}:${ctx.userId}:${ctx.sessionId}`;
}

/** Resolve the client without ever throwing; `null` ⇒ caller uses its default. */
async function client(): Promise<RedisLike | null> {
  try {
    return await getClient();
  } catch {
    return null;
  }
}

/**
 * Record run metadata so a consuming replica can authorize and bound the stream.
 * Best-effort: a failed write just means cross-replica attach falls back to 404
 * (the pre-Phase-5 behavior), never an error to the caller.
 */
export async function createRunMeta(ctx: BeamRunContext): Promise<void> {
  const redis = await client();
  if (!redis) return;
  try {
    const meta: BeamRunMeta = { ctx, createdAt: Date.now() };
    await redis.set(`${META_PREFIX}${ctx.runId}`, JSON.stringify(meta), "PX", RUN_TTL_MS);
  } catch (err) {
    logger.warn({ err }, "beam run store: createRunMeta failed (degrading to in-memory only)");
  }
}

/** Metadata for a run, or `null` when unknown/expired/Redis-down. */
export async function loadRunMeta(runId: string): Promise<BeamRunMeta | null> {
  const redis = await client();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${META_PREFIX}${runId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BeamRunMeta>;
    if (!parsed || typeof parsed !== "object" || !parsed.ctx) return null;
    const ctx = parsed.ctx;
    if (typeof ctx.runId !== "string" || typeof ctx.userId !== "string" || typeof ctx.tenantId !== "string") {
      return null;
    }
    return { ctx, createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now() };
  } catch (err) {
    logger.warn({ err }, "beam run store: loadRunMeta failed");
    return null;
  }
}

/**
 * Mirror one run event into the durable stream. Skips `message_delta` by design.
 * Fire-and-forget from the emit hot path; ioredis preserves call order on its
 * single connection, so events land in emit order even when not awaited.
 */
export async function appendRunEvent(runId: string, event: BeamRunEvent): Promise<void> {
  if (event.type === "message_delta") return;
  const redis = await client();
  if (!redis) return;
  const streamKey = `${EVENTS_PREFIX}${runId}`;
  try {
    await redis.xadd(streamKey, "MAXLEN", "~", EVENTS_MAXLEN, "*", EVENT_FIELD, JSON.stringify(event));
    await redis.pexpire(streamKey, RUN_TTL_MS);
  } catch (err) {
    logger.warn({ err }, "beam run store: appendRunEvent failed");
  }
}

/**
 * Replay/tail events recorded after `afterId`. Pass `"0"` (or `"-"`) for the full
 * buffer from the start; pass the last seen stream id to tail only new events.
 */
export async function readRunEventsAfter(runId: string, afterId: string): Promise<BeamRunEventEntry[]> {
  const redis = await client();
  if (!redis) return [];
  // XRANGE is inclusive; use an exclusive "(" start to tail strictly after a
  // watermark, and "-" for the very first read.
  const start = afterId === "0" || afterId === "-" || afterId === "" ? "-" : `(${afterId}`;
  try {
    const rows = await redis.xrange(key(EVENTS_PREFIX, runId), start, "+");
    const out: BeamRunEventEntry[] = [];
    for (const [id, fields] of rows) {
      const event = decodeEvent(fields);
      if (event) out.push({ id, event });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "beam run store: readRunEventsAfter failed");
    return [];
  }
}

function key(prefix: string, runId: string): string {
  return `${prefix}${runId}`;
}

/** Pull the JSON event out of an XRANGE `[field, value, …]` array. */
function decodeEvent(fields: string[]): BeamRunEvent | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === EVENT_FIELD) {
      try {
        return JSON.parse(fields[i + 1]) as BeamRunEvent;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Mark a run terminal so a tailing consumer can stop polling once drained. */
export async function markRunDone(runId: string): Promise<void> {
  await setFlag(DONE_PREFIX, runId);
}

/** True once the run has emitted its terminal event (cross-replica visible). */
export async function isRunDone(runId: string): Promise<boolean> {
  return getFlag(DONE_PREFIX, runId);
}

/** Record a cooperative stop, possibly issued on a different replica. */
export async function markRunStopped(runId: string): Promise<void> {
  await setFlag(STOPPED_PREFIX, runId);
}

/** True when a stop was requested on any replica — polled by the producer. */
export async function isRunStopped(runId: string): Promise<boolean> {
  return getFlag(STOPPED_PREFIX, runId);
}

async function setFlag(prefix: string, runId: string): Promise<void> {
  const redis = await client();
  if (!redis) return;
  try {
    await redis.set(key(prefix, runId), "1", "PX", RUN_TTL_MS);
  } catch (err) {
    logger.warn({ err, prefix }, "beam run store: setFlag failed");
  }
}

async function getFlag(prefix: string, runId: string): Promise<boolean> {
  const redis = await client();
  if (!redis) return false;
  try {
    return (await redis.get(key(prefix, runId))) === "1";
  } catch (err) {
    logger.warn({ err, prefix }, "beam run store: getFlag failed");
    return false;
  }
}

/**
 * Acquire the cross-replica "one active Beam run per session" lock. Returns
 * `true` when the lock is taken (proceed) and `false` when another run already
 * holds it (the route returns 409). Permissive on the no-Redis / error path
 * (`true`) so the in-memory guard remains the sole gate, exactly as today.
 */
export async function tryAcquireActiveSession(ctx: BeamRunContext): Promise<boolean> {
  const redis = await client();
  if (!redis) return true;
  try {
    // `SET key runId PX <ttl> NX` as one atomic round trip via eval (the RedisLike
    // `set` signature doesn't carry the NX flag). Returns "OK" when acquired, nil
    // (→ null) when another run already holds the per-session lock.
    const res = await redis.eval(
      "return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')",
      1,
      activeKey(ctx),
      ctx.runId,
      ACTIVE_LOCK_TTL_MS,
    );
    return res === "OK";
  } catch (err) {
    logger.warn({ err }, "beam run store: tryAcquireActiveSession failed (allowing run)");
    return true;
  }
}

/**
 * Release the active-session lock on a terminal event. Best-effort. Deletes the
 * key ONLY when this run still owns it (compare-and-delete): a producer that
 * outlived the lock TTL would otherwise release the lock a NEWER run of the same
 * session had since acquired, letting a third run start concurrently — the exact
 * duplicate-turn interleaving the lock exists to prevent.
 */
export async function clearActiveSession(ctx: BeamRunContext): Promise<void> {
  const redis = await client();
  if (!redis) return;
  try {
    await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      activeKey(ctx),
      ctx.runId,
    );
  } catch (err) {
    logger.warn({ err }, "beam run store: clearActiveSession failed");
  }
}
