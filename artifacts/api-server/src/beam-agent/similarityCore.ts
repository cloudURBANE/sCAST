/**
 * Beam Agent — pure similarity math for `beam_find_similar` ("smells like X").
 *
 * PURE + dependency-free (only a `type` import) so it unit-tests in isolation with
 * `node --experimental-strip-types --test`. The DB/catalog-coupled retrieval lives
 * in the tool body (`beamTools.ts`); this only scores two already-resolved
 * fragrances against each other.
 *
 * Two signals, combined in a simple explainable way:
 *   - 6-axis scent-vector closeness (the server-built fingerprint), and
 *   - accord/note overlap (reuses `computeOverlap` from beamToolCore at the call
 *     site; passed in here as a 0..1 scalar).
 * Either can be missing: a fragrance with no scent_vector falls back to overlap
 * alone rather than throwing or inventing a number.
 */
import type { BeamScentVector } from "./types.ts";

/** Largest possible Euclidean distance between two 6-axis vectors in [0,1]^6. */
const MAX_AXIS_DISTANCE = Math.sqrt(6);

/** The six axes, fixed order — keep in sync with BeamScentVector. */
const AXES: ReadonlyArray<keyof BeamScentVector> = [
  "freshness",
  "sweetness",
  "woodiness",
  "spice",
  "warmth",
  "musk",
];

function axis(v: BeamScentVector, key: keyof BeamScentVector): number {
  const n = v[key];
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** A vector is usable only when at least one axis carries real (>0) signal. */
export function hasVectorSignal(v: BeamScentVector | undefined): v is BeamScentVector {
  if (!v) return false;
  return AXES.some((key) => axis(v, key) > 0);
}

/**
 * 0..1 closeness of two scent vectors (1 = identical fingerprint). Euclidean
 * distance over the six axes, mapped onto 0..1 via the max possible distance.
 * Returns null when either side has no usable vector — the caller then leans on
 * accord overlap instead of treating "no data" as "completely different".
 */
export function scentVectorSimilarity(
  a: BeamScentVector | undefined,
  b: BeamScentVector | undefined,
): number | null {
  if (!hasVectorSignal(a) || !hasVectorSignal(b)) return null;
  let sumSq = 0;
  for (const key of AXES) {
    const d = axis(a, key) - axis(b, key);
    sumSq += d * d;
  }
  const distance = Math.sqrt(sumSq);
  const sim = 1 - distance / MAX_AXIS_DISTANCE;
  return round2(Math.min(1, Math.max(0, sim)));
}

export type SimilarityBand = "very similar" | "similar" | "somewhat similar" | "loosely related";

export function similarityBand(score: number): SimilarityBand {
  if (score >= 0.7) return "very similar";
  if (score >= 0.5) return "similar";
  if (score >= 0.3) return "somewhat similar";
  return "loosely related";
}

/**
 * Blend vector closeness with accord/note overlap into one 0..1 similarity score.
 * When a vector signal exists it leads (it captures the overall character a user
 * means by "smells like"), with accord overlap confirming shared building blocks.
 * With no vector on either side, overlap is the whole score — honest degradation,
 * not a fabricated vector term.
 */
export function combineSimilarity(opts: { vectorSim: number | null; overlapCombined: number }): number {
  const overlap = Number.isFinite(opts.overlapCombined) ? Math.min(1, Math.max(0, opts.overlapCombined)) : 0;
  if (opts.vectorSim === null) return round2(overlap);
  const vector = Math.min(1, Math.max(0, opts.vectorSim));
  return round2(0.6 * vector + 0.4 * overlap);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
