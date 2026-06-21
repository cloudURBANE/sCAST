/**
 * Unit tests for honest price/budget gating. Pure — no DB/network. Run with:
 *   node --experimental-strip-types --test src/beam-agent/budgetGate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateBudget, parseBudgetCeiling, priceStatusFor } from "./budgetGate.ts";

test("parseBudgetCeiling reads numeric ceilings and ranges, ignores qualitative", () => {
  assert.equal(parseBudgetCeiling("$80"), 80);
  assert.equal(parseBudgetCeiling("under 150"), 150);
  assert.equal(parseBudgetCeiling("100"), 100);
  // Range -> the high end is the ceiling.
  assert.equal(parseBudgetCeiling("$50-100"), 100);
  assert.equal(parseBudgetCeiling("between 60 and 40"), 60);
  // Qualitative / empty -> no honest number to enforce (never fabricate one).
  assert.equal(parseBudgetCeiling("Budget-friendly"), null);
  assert.equal(parseBudgetCeiling("Premium"), null);
  assert.equal(parseBudgetCeiling(undefined), null);
  assert.equal(parseBudgetCeiling(""), null);
});

test("priceStatusFor enforces only when BOTH price and ceiling are known", () => {
  // No ceiling -> never gated, even with a known price.
  assert.equal(priceStatusFor(200, null), "unknown");
  // Known ceiling, unknown price -> unknown (never a false 'within').
  assert.equal(priceStatusFor(undefined, 100), "unknown");
  assert.equal(priceStatusFor(0, 100), "unknown");
  // Both known.
  assert.equal(priceStatusFor(80, 100), "within_budget");
  assert.equal(priceStatusFor(100, 100), "within_budget");
  assert.equal(priceStatusFor(120, 100), "over_budget");
});

test("annotateBudget downranks over-budget without dropping, stable within groups", () => {
  const items = [
    { name: "A", price: 150 }, // over
    { name: "B", price: 60 }, // within
    { name: "C" }, // unknown price
    { name: "D", price: 90 }, // within
  ] as Array<{ name: string; price?: number }>;
  const out = annotateBudget(items, 100);
  // within (stable B,D) -> unknown (C) -> over (A)
  assert.deepEqual(out.map((i) => i.name), ["B", "D", "C", "A"]);
  assert.deepEqual(out.map((i) => i.priceStatus), [
    "within_budget",
    "within_budget",
    "unknown",
    "over_budget",
  ]);
  // Nothing dropped.
  assert.equal(out.length, items.length);
});

test("annotateBudget with no ceiling is an identity pass marked unknown", () => {
  const items = [{ name: "A", price: 150 }, { name: "B", price: 60 }];
  const out = annotateBudget(items, null);
  assert.deepEqual(out.map((i) => i.name), ["A", "B"]);
  assert.ok(out.every((i) => i.priceStatus === "unknown"));
});
