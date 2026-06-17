/**
 * Optional shared-state backend (Redis), behind a tiny structural interface.
 *
 * Design contract — the whole reason this module is safe to ship before any
 * Redis instance exists:
 *
 *   • When REDIS_URL is unset/blank, `getRedis()` resolves to `null` and the
 *     callers fall back to their existing process-local in-memory behavior.
 *     The app behaves EXACTLY as it does today. No new runtime dependency is
 *     touched (ioredis is only ever loaded via a dynamic import that runs only
 *     when REDIS_URL is present), so typecheck/build/tests do not require it.
 *
 *   • When REDIS_URL is set but Redis is unreachable, commands reject fast
 *     (offline queue disabled) and every caller is written to degrade to its
 *     in-memory fallback — a Redis outage must never take the API down.
 *
 *   • Only when REDIS_URL is set AND the instance is reachable do callers use
 *     the shared store. This is the path that lets the API scale horizontally
 *     later (see docs / the Redis migration plan). Lighting it up is a pure
 *     ops action: provision Redis, set REDIS_URL. No code change.
 *
 * `ioredis` is marked `external` in build.mjs so esbuild does not bundle it (and
 * does not need it resolvable at build time); at runtime Node resolves it from
 * node_modules only on the connect path.
 */
import { logger } from "./logger.ts";

/**
 * The narrow slice of an ioredis client this codebase actually uses. Declaring
 * it structurally (rather than importing ioredis' types) keeps typecheck and the
 * unit tests independent of the package being installed, and makes the Redis-
 * backed stores trivially fakeable in tests.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /** Mirrors `SET key value PX <ttlMs>`. */
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<number>;
  /**
   * Mirrors ioredis `eval(script, numKeys, ...keysAndArgs)`. Used by the rate
   * limiter to run its fixed-window increment as a single atomic round trip
   * (INCR + conditional PEXPIRE/PTTL) instead of 2–3 sequential commands — the
   * latency that matters most against a managed/remote Redis.
   */
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
}

/** True when a non-blank REDIS_URL is configured. */
export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL && process.env.REDIS_URL.trim());
}

/**
 * Bound the initial connect. With `enableOfflineQueue: false` a command issued
 * before the socket is ready rejects immediately ("Stream isn't writeable"), so
 * `getRedis()` waits for the connection before handing the client out — otherwise
 * the first requests after every cold start race the (TLS) handshake and silently
 * fall back to in-memory, defeating cross-replica sharing exactly when it matters.
 */
const CONNECT_TIMEOUT_MS = 4000;
/** After a failed connect, serve the in-memory fallback for this long before retrying, so a down/misconfigured Redis can't thrash the connect path on every request. */
const RETRY_COOLDOWN_MS = 30_000;

let clientPromise: Promise<RedisLike | null> | null = null;
let loggedConnectError = false;
let cooldownUntil = 0;

/**
 * Resolve the shared Redis client, or `null` when Redis is not configured or the
 * connection could not be established. The first call awaits the connection
 * (bounded by CONNECT_TIMEOUT_MS); the result is cached, so subsequent calls on
 * the request hot path are cheap. Never rejects and never hangs longer than the
 * connect timeout — callers treat `null` (or a later per-command rejection) as
 * "use the in-memory fallback".
 */
export function getRedis(): Promise<RedisLike | null> {
  if (!isRedisConfigured()) return Promise.resolve(null);
  if (clientPromise) return clientPromise;
  // Within the post-failure cooldown, don't even try — go straight to fallback.
  if (Date.now() < cooldownUntil) return Promise.resolve(null);
  clientPromise = connect();
  return clientPromise;
}

async function connect(): Promise<RedisLike | null> {
  const url = process.env.REDIS_URL!.trim();
  let client: RedisLikeWithEvents | null = null;
  try {
    // Dynamic import: only reached when REDIS_URL is set. `ioredis` is external
    // in build.mjs, so this resolves from node_modules at runtime.
    const mod = (await import("ioredis")) as unknown as {
      default: new (url: string, opts: Record<string, unknown>) => RedisLikeWithEvents;
    };
    const RedisCtor = mod.default;
    client = new RedisCtor(url, {
      // Fail commands fast when not connected instead of queueing them, so a
      // mid-life Redis blip degrades to the in-memory fallback rather than
      // hanging requests. Keep reconnecting in the background so it self-heals.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: CONNECT_TIMEOUT_MS,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });

    client.on("error", (err: unknown) => {
      // ioredis re-emits on every failed reconnect; log the first occurrence at
      // warn and stay quiet afterward so a sustained outage doesn't flood logs.
      if (!loggedConnectError) {
        loggedConnectError = true;
        logger.warn({ err }, "redis: connection error — falling back to in-memory state");
      }
    });
    client.on("ready", () => {
      loggedConnectError = false;
      logger.info("redis: connected — shared state backend active");
    });

    await waitForReady(client, CONNECT_TIMEOUT_MS + 500);
    return client as unknown as RedisLike;
  } catch (err) {
    // Couldn't connect in time (or ioredis failed to load). Tear down the
    // half-open client so it stops reconnecting in the background, arm the
    // cooldown, and drop the cached promise so a later call can retry.
    if (!loggedConnectError) {
      loggedConnectError = true;
      logger.warn({ err }, "redis: initial connect failed — using in-memory state (will retry)");
    }
    try {
      client?.disconnect?.();
    } catch {
      /* ignore */
    }
    cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
    clientPromise = null;
    return null;
  }
}

/** Resolve once the client reaches `ready`; reject on timeout or a closed connection. */
function waitForReady(client: RedisLikeWithEvents, timeoutMs: number): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off?.("ready", onReady);
      client.off?.("end", onEnd);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("redis connection closed before ready"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("redis connect timeout"));
    }, timeoutMs);
    client.once("ready", onReady);
    client.once("end", onEnd);
  });
}

/** ioredis exposes an EventEmitter API + a `status` string; typed locally to avoid importing it. */
interface RedisLikeWithEvents extends RedisLike {
  status?: string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  disconnect?(): void;
}

/**
 * Test-only reset hook: drops the cached client promise and cooldown so a suite
 * can re-derive `getRedis()` after mutating REDIS_URL. Not used in production.
 */
export function __resetRedisForTests(): void {
  clientPromise = null;
  loggedConnectError = false;
  cooldownUntil = 0;
}
