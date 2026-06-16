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
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  /** Mirrors `SET key value PX <ttlMs>`. */
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

/** True when a non-blank REDIS_URL is configured. */
export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL && process.env.REDIS_URL.trim());
}

let clientPromise: Promise<RedisLike | null> | null = null;
let loggedConnectError = false;

/**
 * Resolve the shared Redis client, or `null` when Redis is not configured or the
 * client could not be constructed. The promise is cached, so repeated calls on
 * the request hot path are cheap. Never rejects — callers can treat a `null`
 * (or a later command rejection) as "use the in-memory fallback".
 */
export function getRedis(): Promise<RedisLike | null> {
  if (!isRedisConfigured()) return Promise.resolve(null);
  if (!clientPromise) clientPromise = connect();
  return clientPromise;
}

async function connect(): Promise<RedisLike | null> {
  const url = process.env.REDIS_URL!.trim();
  try {
    // Dynamic import: only reached when REDIS_URL is set. `ioredis` is external
    // in build.mjs, so this resolves from node_modules at runtime.
    const mod = (await import("ioredis")) as unknown as {
      default: new (url: string, opts: Record<string, unknown>) => RedisLikeWithEvents;
    };
    const RedisCtor = mod.default;
    const client = new RedisCtor(url, {
      // Fail commands fast when not connected instead of queueing them, so a
      // Redis outage degrades to the in-memory fallback rather than hanging
      // requests. Keep reconnecting in the background so it self-heals.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
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

    return client as unknown as RedisLike;
  } catch (err) {
    // ioredis not installed / failed to load. Stay on the in-memory path.
    logger.warn({ err }, "redis: client unavailable — using in-memory state");
    return null;
  }
}

/** ioredis exposes an EventEmitter `on`; typed locally to avoid importing it. */
interface RedisLikeWithEvents extends RedisLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Test-only reset hook: drops the cached client promise so a suite can re-derive
 * `getRedis()` after mutating REDIS_URL. Not used in production code paths.
 */
export function __resetRedisForTests(): void {
  clientPromise = null;
  loggedConnectError = false;
}
