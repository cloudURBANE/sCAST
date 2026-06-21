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

test("scentVectorSimilarity (cosine) is 1 for identical, 0 for orthogonal, and ranks neighbors", () => {
  const a = vec({ freshness: 0.8, woodiness: 0.6, warmth: 0.4 });
  assert.equal(scentVectorSimilarity(a, a), 1);

  // Orthogonal character (no shared axis direction) → cosine 0: maximally
  // different. The old √6-normalized euclidean form scored nearly every pair into
  // the top bands; cosine (M1) restores discrimination.
  const orthogonal = vec({ sweetness: 0.9, musk: 0.7 });
  assert.equal(scentVectorSimilarity(a, orthogonal), 0);

  // A partially-overlapping but clearly DIFFERENT vector lands strictly between
  // 0 and 1 and must NOT sit in the top "very similar" band (>= 0.7).
  const different = vec({ freshness: 0.2, sweetness: 0.8, musk: 0.6 });
  const diffSim = scentVectorSimilarity(a, different)!;
  assert.ok(diffSim > 0 && diffSim < 0.7, `expected 0<sim<0.7, got ${diffSim}`);

  // A near neighbor must score higher than the different one.
  const near = vec({ freshness: 0.7, woodiness: 0.6, warmth: 0.4 });
  const nearSim = scentVectorSimilarity(a, near)!;
  assert.ok(nearSim > diffSim, `near (${nearSim}) should beat different (${diffSim})`);
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
