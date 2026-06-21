/**
 * Beam Agent conversation memory: clean user/assistant text turns plus
 * deterministic session state extracted from user text. Failed model turns may
 * skip transcript append, but their extracted slots/mission state are persisted
 * before the run starts.
 */
import { getRedis, type RedisLike } from "../lib/redisClient.ts";
import { logger } from "../lib/logger.ts";
import type {
  BeamRunContext,
  BeamSessionRecord as BeamSessionSnapshot,
  BeamSessionState,
  ClaudeMessage,
} from "./types.ts";
import { cloneBeamSessionState, emptyBeamSessionState, sanitizeBeamSessionState } from "./missionState.ts";

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

function snapshot(turns: ClaudeMessage[], state: BeamSessionState): BeamSessionSnapshot {
  return { turns: turns.slice(), state: cloneBeamSessionState(state) };
}

/* ------------------------------------------------------------------ */
/* In-memory backend (default / fallback)                             */
/* ------------------------------------------------------------------ */

type SessionRecord = { turns: ClaudeMessage[]; state: BeamSessionState; updatedAt: number };
const sessions = new Map<string, SessionRecord>();

// Hard cap so the in-memory fallback (used when Redis is down) can't grow
// unbounded: pruneSessions only runs on reads, so write-only/abandoned sessions
// that are never re-read would otherwise accumulate forever. Evicts in a batch
// down to 90% so the sort doesn't run on every write at steady state.
const MAX_MEMORY_SESSIONS = 5000;

function pruneSessions(now: number): void {
  for (const [key, record] of sessions) {
    if (now - record.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

function enforceSessionCap(): void {
  if (sessions.size <= MAX_MEMORY_SESSIONS) return;
  const target = Math.floor(MAX_MEMORY_SESSIONS * 0.9);
  const oldestFirst = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of oldestFirst) {
    if (sessions.size <= target) break;
    sessions.delete(key);
  }
}

function memoryLoad(ctx: BeamRunContext): BeamSessionSnapshot {
  pruneSessions(Date.now());
  const record = sessions.get(sessionKey(ctx));
  return snapshot(record?.turns ?? [], record?.state ?? emptyBeamSessionState());
}

function memorySaveState(ctx: BeamRunContext, state: BeamSessionState): void {
  const key = sessionKey(ctx);
  const record = sessions.get(key) ?? { turns: [], state: emptyBeamSessionState(), updatedAt: Date.now() };
  record.state = cloneBeamSessionState(state);
  record.updatedAt = Date.now();
  sessions.set(key, record);
  enforceSessionCap();
}

function memoryAppend(ctx: BeamRunContext, userMessage: string, assistantText: string, state?: BeamSessionState): void {
  const key = sessionKey(ctx);
  const record = sessions.get(key) ?? { turns: [], state: emptyBeamSessionState(), updatedAt: Date.now() };
  record.turns.push({ role: "user", content: userMessage });
  record.turns.push({ role: "assistant", content: assistantText });
  record.turns = capTurns(record.turns);
  if (state) record.state = cloneBeamSessionState(state);
  record.updatedAt = Date.now();
  sessions.set(key, record);
  enforceSessionCap();
}

/* ------------------------------------------------------------------ */
/* Redis backend                                                      */
/* ------------------------------------------------------------------ */

function redisKey(ctx: BeamRunContext): string {
  return REDIS_KEY_PREFIX + sessionKey(ctx);
}

function normalizeStoredSession(raw: unknown): BeamSessionSnapshot {
  if (Array.isArray(raw)) {
    return snapshot(capTurns(raw as ClaudeMessage[]), emptyBeamSessionState());
  }
  if (!raw || typeof raw !== "object") return snapshot([], emptyBeamSessionState());
  const record = raw as Record<string, unknown>;
  const turns = Array.isArray(record.turns) ? capTurns(record.turns as ClaudeMessage[]) : [];
  return snapshot(turns, sanitizeBeamSessionState(record.state));
}

async function redisLoad(client: RedisLike, ctx: BeamRunContext): Promise<BeamSessionSnapshot> {
  const raw = await client.get(redisKey(ctx));
  if (!raw) return snapshot([], emptyBeamSessionState());
  try {
    return normalizeStoredSession(JSON.parse(raw) as unknown);
  } catch {
    return snapshot([], emptyBeamSessionState());
  }
}

async function redisSave(client: RedisLike, ctx: BeamRunContext, data: BeamSessionSnapshot): Promise<void> {
  await client.set(
    redisKey(ctx),
    JSON.stringify({ turns: capTurns(data.turns), state: sanitizeBeamSessionState(data.state) }),
    "PX",
    SESSION_TTL_MS,
  );
}

async function redisSaveState(client: RedisLike, ctx: BeamRunContext, state: BeamSessionState): Promise<void> {
  const existing = await redisLoad(client, ctx);
  await redisSave(client, ctx, { turns: existing.turns, state });
}

async function redisAppend(
  client: RedisLike,
  ctx: BeamRunContext,
  userMessage: string,
  assistantText: string,
  state?: BeamSessionState,
): Promise<void> {
  const existing = await redisLoad(client, ctx);
  existing.turns.push({ role: "user", content: userMessage });
  existing.turns.push({ role: "assistant", content: assistantText });
  await redisSave(client, ctx, {
    turns: existing.turns,
    state: state ? cloneBeamSessionState(state) : existing.state,
  });
}

/* ------------------------------------------------------------------ */
/* Public async interface                                             */
/* ------------------------------------------------------------------ */

/** Prior turns and structured state for this session, or empty values for a new session. */
export async function loadSession(ctx: BeamRunContext): Promise<BeamSessionSnapshot> {
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
    logger.warn({ err }, "beam session: redis load failed - using in-memory session");
    return memoryLoad(ctx);
  }
}

/** Prior turns for this session (most recent last), or `[]` for a new session. */
export async function loadSessionHistory(ctx: BeamRunContext): Promise<ClaudeMessage[]> {
  return (await loadSession(ctx)).turns;
}

/** Structured slots/mission state for this session, or an empty state for a new session. */
export async function loadSessionState(ctx: BeamRunContext): Promise<BeamSessionState> {
  return (await loadSession(ctx)).state;
}

/** Persist slots/mission state without appending a transcript turn. */
export async function saveSessionState(ctx: BeamRunContext, state: BeamSessionState): Promise<void> {
  let client: RedisLike | null = null;
  try {
    client = await getClient();
  } catch {
    client = null;
  }
  if (!client) {
    memorySaveState(ctx, state);
    return;
  }
  try {
    await redisSaveState(client, ctx, state);
  } catch (err) {
    logger.warn({ err }, "beam session: redis state save failed - writing to in-memory session");
    memorySaveState(ctx, state);
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
  state?: BeamSessionState,
): Promise<void> {
  let client: RedisLike | null = null;
  try {
    client = await getClient();
  } catch {
    client = null;
  }
  if (!client) {
    memoryAppend(ctx, userMessage, assistantText, state);
    return;
  }
  try {
    await redisAppend(client, ctx, userMessage, assistantText, state);
  } catch (err) {
    logger.warn({ err }, "beam session: redis append failed - writing to in-memory history");
    memoryAppend(ctx, userMessage, assistantText, state);
  }
}
