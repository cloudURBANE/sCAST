/**
 * Pure unit tests for the concierge lane selector — no network, no env.
 *   node --experimental-strip-types --test src/beam-agent/laneSelector.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectConciergeLane } from "./laneSelector.ts";

test("simple lookups stay on the cheap default lane", () => {
  assert.equal(selectConciergeLane({ message: "what is Dior Sauvage?" }), "default");
  assert.equal(selectConciergeLane({ message: "recommend something for today" }), "default");
  assert.equal(selectConciergeLane({ message: "hi" }), "default");
});

test("premium keywords escalate to the premium lane", () => {
  assert.equal(selectConciergeLane({ message: "plan a trip kit for Tokyo" }), "premium");
  assert.equal(selectConciergeLane({ message: "do a collection audit on my vault" }), "premium");
  assert.equal(selectConciergeLane({ message: "which bottles are redundant?" }), "premium");
  assert.equal(selectConciergeLane({ message: "help me with a date-night layering" }), "premium");
});

test("word boundaries avoid false positives", () => {
  // "auditorium" must not trip the \baudit\b rule.
  assert.equal(selectConciergeLane({ message: "what smells good at an auditorium?" }), "default");
});

test("a long, context-heavy message escalates", () => {
  const long = "I am rebuilding my whole rotation and need help. " + "x".repeat(600);
  assert.equal(selectConciergeLane({ message: long }), "premium");
});

test("a deep multi-turn session escalates regardless of the latest message", () => {
  assert.equal(selectConciergeLane({ message: "and the third one?", historyTurns: 10 }), "premium");
  assert.equal(selectConciergeLane({ message: "and the third one?", historyTurns: 2 }), "default");
});

test("non-string / missing input is safe and defaults", () => {
  assert.equal(selectConciergeLane({ message: undefined as unknown as string }), "default");
  assert.equal(selectConciergeLane({ message: "", historyTurns: NaN }), "default");
});
