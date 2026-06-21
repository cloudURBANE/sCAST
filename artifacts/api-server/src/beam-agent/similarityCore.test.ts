/**
 * Unit tests for the pure similarity math behind `beam_find_similar`. Run with:
 *   node --experimental-strip-types --test src/beam-agent/similarityCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combineSimilarity,
  hasVectorSignal,
  scentVectorSimilarity,
  similarityBand,
} from "./similarityCore.ts";
import type { BeamScentVector } from "./types.ts";

const vec = (over: Partial<BeamScentVector> = {}): BeamScentVector => ({
  freshness: 0,
  sweetness: 0,
  woodiness: 0,
  spice: 0,
  warmth: 0,
  musk: 0,
  ...over,
});

test("scentVectorSimilarity is 1 for identical vectors and lower for different ones", () => {
  const a = vec({ freshness: 0.8, woodiness: 0.6, warmth: 0.4 });
  assert.equal(scentVectorSimilarity(a, a), 1);

  const b = vec({ sweetness: 0.9, musk: 0.7 });
  const sim = scentVectorSimilarity(a, b);
  assert.ok(sim !== null && sim > 0 && sim < 1, `expected 0<sim<1, got ${sim}`);

  // A near neighbor must score higher than a far one.
  const near = vec({ freshness: 0.7, woodiness: 0.6, warmth: 0.4 });
  const nearSim = scentVectorSimilarity(a, near)!;
  assert.ok(nearSim > sim!, `near (${nearSim}) should beat far (${sim})`);
});

test("scentVectorSimilarity degrades to null when either vector has no signal", () => {
  const a = vec({ freshness: 0.8 });
  assert.equal(scentVectorSimilarity(a, undefined), null);
  assert.equal(scentVectorSimilarity(undefined, a), null);
  // An all-zero vector carries no signal → treated as absent, not "max distance".
  assert.equal(scentVectorSimilarity(a, vec()), null);
});

test("hasVectorSignal requires at least one positive axis", () => {
  assert.equal(hasVectorSignal(undefined), false);
  assert.equal(hasVectorSignal(vec()), false);
  assert.equal(hasVectorSignal(vec({ spice: 0.1 })), true);
});

test("combineSimilarity blends vector + overlap, and falls back to overlap when no vector", () => {
  // No vector signal → similarity is exactly the overlap term (honest degradation).
  assert.equal(combineSimilarity({ vectorSim: null, overlapCombined: 0.42 }), 0.42);
  // With a vector, the blend is 0.6*vector + 0.4*overlap.
  assert.equal(combineSimilarity({ vectorSim: 1, overlapCombined: 0 }), 0.6);
  assert.equal(combineSimilarity({ vectorSim: 0, overlapCombined: 1 }), 0.4);
  assert.equal(combineSimilarity({ vectorSim: 0.5, overlapCombined: 0.5 }), 0.5);
});

test("similarityBand maps scores to readable bands", () => {
  assert.equal(similarityBand(0.85), "very similar");
  assert.equal(similarityBand(0.55), "similar");
  assert.equal(similarityBand(0.35), "somewhat similar");
  assert.equal(similarityBand(0.1), "loosely related");
});
