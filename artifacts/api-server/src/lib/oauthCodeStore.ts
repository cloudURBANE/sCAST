import { randomBytes } from "node:crypto";
import { getRedis } from "./redisClient.ts";
import { logger } from "./logger.ts";

// One-time OAuth handoff codes (production-readiness C3). The OAuth callback used
// to redirect with the long-lived bearer token AND the email in the query string
// (`/?oauth_token=…&oauth_email=…`), so the live credential landed in browser
// history, the Referer header, and any logging/analytics on the SPA origin.
//
// Instead the callback now mints a short-lived, single-use code and redirects
// with only `/?oauth_code=…`; the SPA immediately POSTs it to /api/auth/exchange
// (over the request body, not the URL) to receive the token once. A leaked URL is
// then worthless: the code is single-use and expires in 60s.
//
// Storage (multi-replica readiness, closes H1): when REDIS_URL is configured the
// code lives in Redis with a PX TTL, so the callback and the exchange can land on
// DIFFERENT replicas and the handoff still resolves. Without Redis (or during a
// Redis outage) it falls back to the process-local map — correct for the current
// single-replica deploy, exactly the previous behavior. A code is written to
// exactly ONE store, never both: mirroring it in process memory would let a
// replayed code succeed on the minting replica after another replica already
// redeemed it, silently breaking the single-use guarantee.

export type OAuthHandoff = {
  token: string;
  email: string;
  pictureUrl?: string;
};

type StoredHandoff = OAuthHandoff & { expiresAt: number };

const CODE_TTL_MS = 60_000;
const REDIS_KEY_PREFIX = "oauth:handoff:";

const store = new Map<string, StoredHandoff>();

let loggedRedisError = false;
function logRedisErrorOnce(err: unknown, op: string): void {
  if (loggedRedisError) return;
  loggedRedisError = true;
  logger.warn({ err, op }, "oauth handoff store: redis error — falling back to in-memory store");
}

// Atomic GET + DEL in one server-side round trip, so two concurrent redeems of
// the same code can never both receive the token. (GETDEL the command needs
// Redis >= 6.2; the script form works everywhere eval does.)
const GETDEL_LUA = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

// Drop expired entries opportunistically so an abandoned login (code minted but
// never redeemed) can't accumulate. Cheap: called on each mint/redeem. Redis
// entries expire themselves via PX.
function pruneExpired(now: number): void {
  for (const [code, entry] of store) {
    if (now >= entry.expiresAt) store.delete(code);
  }
}

function parseStoredHandoff(raw: unknown): OAuthHandoff | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthHandoff>;
    if (typeof parsed.token !== "string" || typeof parsed.email !== "string") return null;
    return {
      token: parsed.token,
      email: parsed.email,
      ...(typeof parsed.pictureUrl === "string" ? { pictureUrl: parsed.pictureUrl } : {}),
    };
  } catch {
    return null;
  }
}

/** Mint a single-use handoff code for the resolved user. Returns the URL-safe code. */
export async function mintHandoffCode(handoff: OAuthHandoff, now: number = Date.now()): Promise<string> {
  pruneExpired(now);
  const code = randomBytes(32).toString("base64url");

  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(REDIS_KEY_PREFIX + code, JSON.stringify(handoff), "PX", CODE_TTL_MS);
      return code;
    } catch (err) {
      logRedisErrorOnce(err, "mint");
    }
  }

  store.set(code, { ...handoff, expiresAt: now + CODE_TTL_MS });
  return code;
}

/**
 * Redeem a handoff code. Single-use: the entry is deleted on the first lookup
 * regardless of expiry, so a replayed code never succeeds. Returns null for an
 * unknown, already-redeemed, or expired code. Checks Redis first (the shared
 * store), then the in-memory map (codes minted while Redis was down).
 */
export async function redeemHandoffCode(code: string, now: number = Date.now()): Promise<OAuthHandoff | null> {
  pruneExpired(now);

  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.eval(GETDEL_LUA, 1, REDIS_KEY_PREFIX + code);
      const handoff = parseStoredHandoff(raw);
      if (handoff) return handoff;
    } catch (err) {
      logRedisErrorOnce(err, "redeem");
    }
  }

  const entry = store.get(code);
  if (!entry) return null;
  store.delete(code);
  if (now >= entry.expiresAt) return null;
  const { expiresAt: _expiresAt, ...handoff } = entry;
  return handoff;
}

/** Test-only: clear all pending handoffs. */
export function _resetHandoffStore(): void {
  store.clear();
  loggedRedisError = false;
}
