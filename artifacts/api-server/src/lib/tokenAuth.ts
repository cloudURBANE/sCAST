import { createHash } from "node:crypto";

// Bearer-token hardening (production-readiness C1/C2). The bearer credential is
// the opaque per-user `users.token` UUID. Two problems this module addresses:
//
//  C1 — at rest: storing the token in plaintext means a DB read (backup leak,
//       SQL injection, a curious operator) hands out live credentials. We store
//       a SHA-256 hash alongside it and authenticate by hash. SHA-256 (not a
//       slow KDF) is correct here: the token is a 122-bit random UUID, not a
//       low-entropy human password, so there is nothing to brute-force and the
//       per-request lookup must stay index-fast.
//
//  C2 — over time: the token never expired. We stamp `token_issued_at` and
//       `token_last_used_at` and reject a token past an absolute age or an idle
//       window, so a leaked-and-forgotten credential stops working.
//
// All logic here is pure and unit-tested; auth.ts / oauth.ts wire it to the DB.

/** SHA-256 hex digest of a bearer token. Deterministic; safe to index. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type TokenTtl = { absoluteMs: number; idleMs: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ABSOLUTE_TTL_DAYS = 90;
const DEFAULT_IDLE_TTL_DAYS = 30;

function parsePositiveDays(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve token lifetimes from env. Absolute TTL caps a token's total lifetime
 * from issue; idle TTL caps the gap since last use. Both default generously
 * (90d / 30d) and only shorten via TOKEN_ABSOLUTE_TTL_DAYS / TOKEN_IDLE_TTL_DAYS.
 */
export function resolveTokenTtl(env: {
  TOKEN_ABSOLUTE_TTL_DAYS?: string | undefined;
  TOKEN_IDLE_TTL_DAYS?: string | undefined;
}): TokenTtl {
  return {
    absoluteMs: parsePositiveDays(env.TOKEN_ABSOLUTE_TTL_DAYS, DEFAULT_ABSOLUTE_TTL_DAYS) * DAY_MS,
    idleMs: parsePositiveDays(env.TOKEN_IDLE_TTL_DAYS, DEFAULT_IDLE_TTL_DAYS) * DAY_MS,
  };
}

export type TokenExpiryInput = {
  issuedAt: Date | null | undefined;
  lastUsedAt: Date | null | undefined;
  now: number;
  ttl: TokenTtl;
};

export type TokenExpiryVerdict = { expired: boolean; reason?: "absolute" | "idle" };

/**
 * Decide whether a token is expired. A NULL timestamp means "unknown" and never
 * expires on that axis: legacy rows minted before this column existed get their
 * timestamps backfilled on next login (oauth.ts stampTokenSecurity), so a deploy
 * doesn't sign out every existing session at once.
 */
export function evaluateTokenExpiry(input: TokenExpiryInput): TokenExpiryVerdict {
  const { issuedAt, lastUsedAt, now, ttl } = input;
  if (issuedAt && now - issuedAt.getTime() >= ttl.absoluteMs) {
    return { expired: true, reason: "absolute" };
  }
  if (lastUsedAt && now - lastUsedAt.getTime() >= ttl.idleMs) {
    return { expired: true, reason: "idle" };
  }
  return { expired: false };
}

// Touching `token_last_used_at` on every authenticated request would add a write
// to every hit. Throttle it: only refresh when the stored value is older than an
// hour (or absent). Idle-TTL granularity is days, so hourly precision is ample.
const LAST_USED_WRITE_THROTTLE_MS = 60 * 60 * 1000;

export function shouldRefreshLastUsed(lastUsedAt: Date | null | undefined, now: number): boolean {
  if (!lastUsedAt) return true;
  return now - lastUsedAt.getTime() >= LAST_USED_WRITE_THROTTLE_MS;
}
