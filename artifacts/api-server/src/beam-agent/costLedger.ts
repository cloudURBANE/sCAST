/**
 * Beam Agent — LLM cost ledger (brief §09.1 token budgets, §11.3 telemetry,
 * §15 source snapshot).
 *
 * A small, deterministic price table so every Beam run can carry an estimated
 * USD cost in its telemetry summary without a second model pass or a remote
 * lookup. Rates are hard-coded for auditability (mirrors services/apiUsageLedger.ts)
 * and are USD per 1M tokens, taken from the brief's §15 OpenRouter snapshot
 * (checked 2026-06-15). Provider pricing drifts — re-verify before relying on the
 * absolute numbers for billing; the value here is a relative cost signal for
 * routing/telemetry, not an invoice.
 */

/** Rate name kept stable for the telemetry comment. */
export const COST_TABLE_LAST_CHECKED = "2026-06-15";

type Rate = { inputPerM: number; outputPerM: number };

/**
 * USD per 1M tokens, keyed by OpenRouter slug. Slugs are matched case-insensitively
 * and by longest known prefix so minor version suffixes still price (e.g.
 * `minimax/minimax-m3:extended` → `minimax/minimax-m3`).
 */
const PRICE_TABLE: Record<string, Rate> = {
  // Cheap router / flash tiers (brief §15).
  "qwen/qwen3.5-flash": { inputPerM: 0.05, outputPerM: 0.2 },
  "qwen/qwen3.7-plus": { inputPerM: 0.32, outputPerM: 1.28 },
  "stepfun/step-3.7-flash": { inputPerM: 0.2, outputPerM: 1.15 },
  // Concierge lanes (brief §15).
  "minimax/minimax-m2.5": { inputPerM: 0.15, outputPerM: 0.9 },
  "minimax/minimax-m3": { inputPerM: 0.3, outputPerM: 1.2 },
  // Deep strategy (brief §15).
  "moonshotai/kimi-k2-thinking": { inputPerM: 0.6, outputPerM: 2.5 },
  "moonshotai/kimi-k2.6": { inputPerM: 0.6, outputPerM: 2.5 },
  "moonshotai/kimi-k2.7-code": { inputPerM: 0.6, outputPerM: 2.5 },
  // Anthropic-direct fallback lane (approximate published rates; used only when
  // the deploy runs the Anthropic provider instead of OpenRouter).
  "anthropic/claude-haiku-4.5": { inputPerM: 1.0, outputPerM: 5.0 },
  "claude-haiku-4-5-20251001": { inputPerM: 1.0, outputPerM: 5.0 },
  "anthropic/claude-sonnet-4.6": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0 },
};

/**
 * Conservative default when a slug is unknown (new/un-pinned model). Picked at the
 * higher end of the stack so an un-priced model never silently looks free in
 * telemetry. Roughly the MiniMax M3 lane.
 */
const DEFAULT_RATE: Rate = { inputPerM: 0.3, outputPerM: 1.2 };

/** OpenRouter `:free` variants bill nothing — pricing them at the conservative
 * default made every free-lane run accrue PHANTOM spend in the usage ledger,
 * which counts toward the per-user daily USD cap (BEAM_USER_DAILY_SPEND_USD)
 * and could 429-block users whose real model cost was $0. */
const FREE_RATE: Rate = { inputPerM: 0, outputPerM: 0 };

function rateFor(model: string): Rate {
  const slug = (model || "").trim().toLowerCase();
  if (!slug) return DEFAULT_RATE;
  if (slug.endsWith(":free")) return FREE_RATE;
  if (PRICE_TABLE[slug]) return PRICE_TABLE[slug];
  // Longest-prefix match so version/variant suffixes (":free", ":extended", a
  // date stamp) still price against the base slug.
  let best: Rate | null = null;
  let bestLen = 0;
  for (const key of Object.keys(PRICE_TABLE)) {
    if (slug.startsWith(key) && key.length > bestLen) {
      best = PRICE_TABLE[key];
      bestLen = key.length;
    }
  }
  return best ?? DEFAULT_RATE;
}

/** Per-model token usage tallied across a run. */
export type ModelUsage = { model: string; inputTokens: number; outputTokens: number };

/** Estimated USD for a single (model, tokens) pairing. Never negative. */
export function estimateCallCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = rateFor(model);
  const inTok = Math.max(0, Number.isFinite(inputTokens) ? inputTokens : 0);
  const outTok = Math.max(0, Number.isFinite(outputTokens) ? outputTokens : 0);
  return (inTok * rate.inputPerM + outTok * rate.outputPerM) / 1e6;
}

/** Estimated USD for a whole run, summed over its per-model token tallies. */
export function estimateRunCostUsd(usage: Iterable<ModelUsage>): number {
  let total = 0;
  for (const u of usage) total += estimateCallCostUsd(u.model, u.inputTokens, u.outputTokens);
  // Round to a sane cent-fraction so telemetry isn't noisy floating point.
  return Math.round(total * 1e6) / 1e6;
}
