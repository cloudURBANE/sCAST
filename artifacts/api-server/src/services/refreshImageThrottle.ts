// Server-owned attempt counter for the /refresh-image route.
//
// The route used to gate its abuse caps on a CLIENT-supplied `refreshCount`,
// which any client can trivially reset (e.g. always send `refreshCount: 0`) to
// drive unbounded paid image regeneration (Serper search + Poof background
// removal + object storage). Tracking attempts server-side — keyed per client +
// fragrance — makes the caps unbypassable while preserving the exact thresholds
// and the two distinct refusal messages the route emitted before.

// Caps expressed in terms of PRIOR attempts (the client's `refreshCount` was
// the number of attempts already made, so `> N` blocked starting on attempt N+2):
//   - without an explicit solver, auto-regeneration pauses after 3 prior attempts
//   - a ceiling of 10 prior attempts without a solver
//   - a higher ceiling of 20 prior attempts WITH a solver: the clarify dropdown
//     offers 19 distinct options, and the old shared ceiling of 10 meant a user
//     methodically trying options hit a blanket 429 on attempt 12 — making every
//     remaining option indistinguishable from "broken" for the rest of the hour
//     (image selection audit S3).
export const REFRESH_AUTO_PAUSE_ATTEMPTS = 3;
export const REFRESH_MAX_ATTEMPTS = 10;
export const REFRESH_MAX_SOLVER_ATTEMPTS = 20;

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour rolling session window
const SWEEP_INTERVAL = 64;

export type RefreshThrottleDecision =
  | { allowed: true }
  | { allowed: false; reason: "needs-solver" | "exhausted" };

/**
 * Decide whether a refresh attempt is permitted, given how many attempts were
 * already made for this client+fragrance and whether the caller picked a solver.
 * Pure: identical inputs always yield the same decision.
 */
export function decideRefreshThrottle(
  priorAttempts: number,
  hasSolver: boolean,
): RefreshThrottleDecision {
  const ceiling = hasSolver ? REFRESH_MAX_SOLVER_ATTEMPTS : REFRESH_MAX_ATTEMPTS;
  if (priorAttempts > ceiling) {
    return { allowed: false, reason: "exhausted" };
  }
  if (!hasSolver && priorAttempts > REFRESH_AUTO_PAUSE_ATTEMPTS) {
    return { allowed: false, reason: "needs-solver" };
  }
  return { allowed: true };
}

/**
 * How many further attempts remain before `decideRefreshThrottle` starts
 * refusing, for surfacing in API responses so exhaustion is legible to the
 * client instead of looking like a broken solver.
 */
export function refreshAttemptsRemaining(priorAttempts: number, hasSolver: boolean): number {
  const ceiling = hasSolver ? REFRESH_MAX_SOLVER_ATTEMPTS : REFRESH_MAX_ATTEMPTS;
  return Math.max(0, ceiling - priorAttempts);
}

/** Stable per-client + per-fragrance key. */
export function refreshAttemptKey(clientId: string, brand: string, name: string): string {
  return `${clientId}|${brand.trim().toLowerCase()}|${name.trim().toLowerCase()}`;
}

/**
 * Fixed-window attempt counter. There is deliberately NO API to decrement or
 * reset a key from request input — the count only climbs within the window and
 * self-expires — so a client cannot reset it the way it could reset the old
 * `refreshCount` body field.
 */
export class RefreshAttemptCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  private sinceSweep = 0;

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** Record one attempt for `key`; returns the running count within the window. */
  record(key: string, now: number = Date.now()): number {
    if ((this.sinceSweep = (this.sinceSweep + 1) % SWEEP_INTERVAL) === 0) this.sweep(now);
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  /** Drop expired windows so the map does not grow without bound. */
  sweep(now: number = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }
}
