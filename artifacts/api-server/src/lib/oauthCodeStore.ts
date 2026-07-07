import { randomBytes } from "node:crypto";

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
// Store is in-process. The production deploy is single-replica (railway.json
// numReplicas: 1) so the callback and the exchange hit the same process. A
// multi-replica rollout (deferred, H1) must move this to Redis, keyed the same.

export type OAuthHandoff = {
  token: string;
  email: string;
  pictureUrl?: string;
};

type StoredHandoff = OAuthHandoff & { expiresAt: number };

const CODE_TTL_MS = 60_000;

const store = new Map<string, StoredHandoff>();

// Drop expired entries opportunistically so an abandoned login (code minted but
// never redeemed) can't accumulate. Cheap: called on each mint/redeem.
function pruneExpired(now: number): void {
  for (const [code, entry] of store) {
    if (now >= entry.expiresAt) store.delete(code);
  }
}

/** Mint a single-use handoff code for the resolved user. Returns the URL-safe code. */
export function mintHandoffCode(handoff: OAuthHandoff, now: number = Date.now()): string {
  pruneExpired(now);
  const code = randomBytes(32).toString("base64url");
  store.set(code, { ...handoff, expiresAt: now + CODE_TTL_MS });
  return code;
}

/**
 * Redeem a handoff code. Single-use: the entry is deleted on the first lookup
 * regardless of expiry, so a replayed code never succeeds. Returns null for an
 * unknown, already-redeemed, or expired code.
 */
export function redeemHandoffCode(code: string, now: number = Date.now()): OAuthHandoff | null {
  pruneExpired(now);
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
}
