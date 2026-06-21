/**
 * Unit tests for the MCP discovery /details budget (H1). Pins the per-process
 * spend ceiling the stateless MCP surface previously lacked, plus the reserve/
 * refund discipline (H2) shared with the in-process route. Run with:
 *   node --experimental-strip-types --test src/beam-agent/mcp/mcpDiscoveryBudget.test.ts
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createDetailTokenBucket } from "./mcpDiscoveryBudget.ts";

const prevCap = process.env.BEAM_EXTERNAL_DETAIL_RUN_CAP;
const prevWindow = process.env.BEAM_MCP_DETAIL_REFILL_MS;

beforeEach(() => {
  process.env.BEAM_EXTERNAL_DETAIL_RUN_CAP = "6";
  process.env.BEAM_MCP_DETAIL_REFILL_MS = "1000";
});
afterEach(() => {
  if (prevCap === undefined) delete process.env.BEAM_EXTERNAL_DETAIL_RUN_CAP;
  else process.env.BEAM_EXTERNAL_DETAIL_RUN_CAP = prevCap;
  if (prevWindow === undefined) delete process.env.BEAM_MCP_DETAIL_REFILL_MS;
  else process.env.BEAM_MCP_DETAIL_REFILL_MS = prevWindow;
});

test("repeated reserves cannot exceed capacity within one refill window", () => {
  let now = 0;
  const bucket = createDetailTokenBucket(() => now);
  // Capacity 6: two full grants of 3, then exhausted.
  assert.equal(bucket.reserve(3), 3);
  assert.equal(bucket.reserve(3), 3);
  assert.equal(bucket.reserve(3), 0, "third call is starved — total stays at the cap");
  assert.equal(bucket.reserve(1), 0);
});

test("refund returns unspent grant so a thin /details body doesn't burn budget", () => {
  let now = 0;
  const bucket = createDetailTokenBucket(() => now);
  const grant = bucket.reserve(3);
  assert.equal(grant, 3);
  // Only 1 of the 3 reserved fetches actually happened: refund the other 2.
  bucket.refund(grant - 1);
  // 6 - 3 + 2 = 5 left, so a follow-up 3-fetch call is granted in full.
  assert.equal(bucket.reserve(3), 3);
  assert.equal(bucket.reserve(3), 2, "only the remaining 2 tokens are left");
});

test("budget replenishes one full capacity per refill window", () => {
  let now = 0;
  const bucket = createDetailTokenBucket(() => now);
  assert.equal(bucket.reserve(6), 6);
  assert.equal(bucket.reserve(1), 0, "exhausted");
  now += 1000; // one full window elapses
  assert.equal(bucket.reserve(6), 6, "refilled back to capacity");
});

test("reserve ignores non-positive / non-finite requests", () => {
  let now = 0;
  const bucket = createDetailTokenBucket(() => now);
  assert.equal(bucket.reserve(0), 0);
  assert.equal(bucket.reserve(-3), 0);
  assert.equal(bucket.reserve(Number.NaN), 0);
  assert.equal(bucket.reserve(3), 3, "budget untouched by the rejected requests");
});
