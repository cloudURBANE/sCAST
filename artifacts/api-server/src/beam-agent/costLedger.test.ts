/**
 * Pure unit tests for the Beam cost ledger — no network, no env.
 *   node --experimental-strip-types --test src/beam-agent/costLedger.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCallCostUsd, estimateRunCostUsd } from "./costLedger.ts";

test("prices a known slug from the §15 table", () => {
  // MiniMax M2.5: $0.15/M in, $0.90/M out.
  const cost = estimateCallCostUsd("minimax/minimax-m2.5", 1_000_000, 1_000_000);
  assert.ok(Math.abs(cost - (0.15 + 0.9)) < 1e-9, `expected ~1.05, got ${cost}`);
});

test("matches by case-insensitive longest prefix for version suffixes", () => {
  const base = estimateCallCostUsd("minimax/minimax-m3", 1_000_000, 0);
  const suffixed = estimateCallCostUsd("MiniMax/MiniMax-M3:extended", 1_000_000, 0);
  assert.equal(suffixed, base);
});

test("unknown slug uses the conservative default rate, never zero", () => {
  const cost = estimateCallCostUsd("some/brand-new-model", 1_000_000, 1_000_000);
  assert.ok(cost > 0, "unknown model should not look free");
});

test("negative / non-finite token counts are clamped to zero", () => {
  assert.equal(estimateCallCostUsd("minimax/minimax-m2.5", -5, Number.NaN), 0);
});

test("estimateRunCostUsd sums per-model usage", () => {
  const total = estimateRunCostUsd([
    { model: "minimax/minimax-m2.5", inputTokens: 1_000_000, outputTokens: 0 }, // 0.15
    { model: "minimax/minimax-m3", inputTokens: 0, outputTokens: 1_000_000 }, // 1.20
  ]);
  assert.ok(Math.abs(total - 1.35) < 1e-6, `expected ~1.35, got ${total}`);
});

test("empty usage is zero", () => {
  assert.equal(estimateRunCostUsd([]), 0);
});
