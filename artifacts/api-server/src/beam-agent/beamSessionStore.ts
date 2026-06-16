/**
 * Beam Agent conversation memory — the clean user/assistant TEXT turns that let
 * a follow-up in a session keep context (never the intermediate tool plumbing).
 *
 * Two interchangeable backends behind one async interface:
 *
 *   • In-memory (default): a process-local Map with a 1-hour sliding TTL, exactly
 *     the behavior this used to have inline in beamAgentRoutes. Used whenever
 *     Redis is not configured.
 *
 *   • Redis (when REDIS_URL is set): a per-session JSON string key with a TTL, so
 *     session context survives a redeploy and is shared across replicas. Any
 *     Redis error degrades to the in-memory Map — a cache hiccup never breaks a
 *     run, it just loses cross-replica continuity for that turn.
 *
 * Both paths cap history at MAX_SESSION_TURNS and key by tenant+user+session.
 */
import { getRedis, type RedisLike } from "../lib/redisClient.ts";
import { logger } from "../lib/logger.ts";
import type { BeamRunContext, ClaudeMessage } from "./types.ts";

const SESSION_TTL_MS = 60 * 60_000;
const MAX_SESSION_TURNS = 16;
const REDIS_KEY_PREFIX = "beam:session:";

/** Injectable Redis getter so tests can supply a fake (or force the memory path). */
type GetClient = () => Promise<RedisLike | null>;
let getClient: GetClient = getRedis;

/** Test-only seam to swap the backend. */
export function __setSessionRedisForTests(fn: GetClient): void {
  getClient = fn;
}

function sessionKey(ctx: BeamRunContext): string {
  return `${ctx.tenantId}:${ctx.userId}:${ctx.sessionId}`;
}

function capTurns(turns: ClaudeMessage[]): ClaudeMessage[] {
  return turns.length > MAX_SESSION_TURNS ? turns.slice(-MAX_SESSION_TURNS) : turns;
}

/* ------------------------------------------------------------------ */
/* In-memory backend (default / fallback)                             */
/* ------------------------------------------------------------------ */

type SessionRecord = { turns: ClaudeMessage[]; updatedAt: number };
const sessions = new Map<string, SessionRecord>();

function pruneSessions(now: number): void {
  for (const [key, record] of sessions) {
    if (now - record.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

function memoryLoad(ctx: BeamRunContext): ClaudeMessage[] {
  pruneSessions(Date.now());
  return sessions.get(sessionKey(ctx))?.turns.slice() ?? [];
}

function memoryAppend(ctx: BeamRunContext, userMessage: string, assistantText: string): void {
  const key = sessionKey(ctx);
  const record = sessions.get(key) ?? { turns: [], updatedAt: Date.now() };
  record.turns.push({ role: "user", content: userMessage });
  record.turns.push({ role: "assistant", content: assistantText });
  record.turns = capTurns(record.turns);
  record.updatedAt = Date.now();
  sessions.set(key, record);
}

/* ------------------------------------------------------------------ */
/* Redis backend                                                      */
/* ------------------------------------------------------------------ */

function redisKey(ctx: BeamRunContext): string {
  return REDIS_KEY_PREFIX + sessionKey(ctx);
}

async function redisLoad(client: RedisLike, ctx: BeamRunContext): Promise<ClaudeMessage[]> {
  const raw = await client.get(redisKey(ctx));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ClaudeMessage[]) : [];
  } catch {
    // Corrupt entry — treat as empty rather than throwing into the hot path.
    return [];
  }
}

async function redisAppend(
  client: RedisLike,
  ctx: BeamRunContext,
  userMessage: string,
  assistantText: string,
): Promise<void> {
  const existing = await redisLoad(client, ctx);
  existing.push({ role: "user", content: userMessage });
  existing.push({ role: "assistant", content: assistantText });
  await client.set(redisKey(ctx), JSON.stringify(capTurns(existing)), "PX", SESSION_TTL_MS);
}

/* ------------------------------------------------------------------ */
/* Public async interface                                             */
/* ------------------------------------------------------------------ */

/** Prior turns for this session (most recent last), or `[]` for a new session. */
export async function loadSessionHistory(ctx: BeamRunContext): Promise<ClaudeMessage[]> {
  let client: RedisLike | null = null;
  try {
    client = await getClient();
  } catch {
    client = null;
  }
  if (!client) return memoryLoad(ctx);
  try {
    return await redisLoad(client, ctx);
  } catch (err) {
    logger.warn({ err }, "beam session: redis load failed — using in-memory history");
    return memoryLoad(ctx);
  }
}

/**
 * Append one user/assistant exchange. Best-effort by design (mirrors the usage
 * ledger): callers fire-and-forget this, so a failed write must never throw.
 */
export async function appendSessionTurn(
  ctx: BeamRunContext,
  userMessage: string,
  assistantText: string,
): Promise<void> {
  let client: RedisLike | null = null;
  try {
    client = await getClient();
  } catch {
    client = null;
  }
  if (!client) {
    memoryAppend(ctx, userMessage, assistantText);
    return;
  }
  try {
    await redisAppend(client, ctx, userMessage, assistantText);
  } catch (err) {
    logger.warn({ err }, "beam session: redis append failed — writing to in-memory history");
    memoryAppend(ctx, userMessage, assistantText);
  }
}
