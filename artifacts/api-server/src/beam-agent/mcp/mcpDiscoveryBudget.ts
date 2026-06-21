/**
 * Beam Agent — process-global Decodo `/details` budget for the MCP discovery
 * surface (H1).
 *
 * The in-process route bounds external `/details` (Decodo-egress) fetches per RUN
 * via a closure captured in `buildDeps`. The MCP server has no agent loop, no turn
 * cap, and builds its tool deps ONCE at startup with no per-run context, so a
 * delegated client (Hermes) could otherwise issue `3 × N` detail fetches with no
 * server-side ceiling (N chosen by the model).
 *
 * Since there is no run/session identity in the stateless deps closure, we bound
 * the SUSTAINED rate process-wide with a refilling token bucket. Capacity tracks
 * the per-run cap (`BEAM_EXTERNAL_DETAIL_RUN_CAP`, default 6) and refills one full
 * capacity per window (`BEAM_MCP_DETAIL_REFILL_MS`, default 60s). The engine-side
 * `DECODO_DAILY_REQUEST_CAP` remains the daily backstop; this is the per-process
 * spend bound the MCP surface previously lacked entirely.
 *
 * Reserve/refund mirrors the route: callers reserve a grant synchronously BEFORE
 * the await, then refund the unspent portion after, so the budget stays correct
 * even under concurrent `tools/call` dispatch.
 */
import { externalDetailRunCap } from "../discoveryConfig.ts";

/** Refill window in ms — one full capacity is replenished per window. */
function refillWindowMs(): number {
  const raw = Number(process.env.BEAM_MCP_DETAIL_REFILL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

export interface DetailTokenBucket {
  /** Reserve up to `want` tokens; returns the granted amount (0..want). */
  reserve(want: number): number;
  /** Return `amount` unspent tokens (clamped to capacity). */
  refund(amount: number): void;
}

/**
 * Build an independent token bucket. Capacity + refill window are snapshotted at
 * construction (env reads), matching how the route snapshots `externalDetailRunCap`
 * per run. Exposed for tests; production uses the shared singleton below.
 */
export function createDetailTokenBucket(now: () => number = Date.now): DetailTokenBucket {
  const capacity = externalDetailRunCap();
  const windowMs = refillWindowMs();
  let tokens = capacity;
  let lastRefill = now();

  const topUp = (): void => {
    const t = now();
    const elapsed = t - lastRefill;
    if (elapsed <= 0) return;
    const refilled = (elapsed / windowMs) * capacity;
    if (refilled <= 0) return;
    tokens = Math.min(capacity, tokens + refilled);
    lastRefill = t;
  };

  return {
    reserve(want: number): number {
      if (!Number.isFinite(want) || want <= 0) return 0;
      topUp();
      const grant = Math.min(Math.floor(want), Math.floor(tokens));
      if (grant <= 0) return 0;
      tokens -= grant;
      return grant;
    },
    refund(amount: number): void {
      if (!Number.isFinite(amount) || amount <= 0) return;
      tokens = Math.min(capacity, tokens + Math.floor(amount));
    },
  };
}

/** Shared per-process bucket for the MCP discovery surface. */
export const mcpDetailBudget: DetailTokenBucket = createDetailTokenBucket();
