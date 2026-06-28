/**
 * Unit tests for the deterministic collection-intelligence engine. Run with:
 *   node --experimental-strip-types --test src/beam-agent/collectionAnalysis.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCollection, type CollectionItem } from "./collectionAnalysis.ts";

const item = (over: Partial<CollectionItem> & { id: string; name: string }): CollectionItem => ({
  families: [],
  accords: [],
  notes: [],
  sourceConfidence: 0.95,
  ...over,
});

test("empty vault → empty, reliable=false, no fabricated gaps", () => {
  const a = analyzeCollection([]);
  assert.equal(a.vaultSize, 0);
  assert.equal(a.analyzableCount, 0);
  assert.equal(a.reliable, false);
  assert.deepEqual(a.gaps, []);
  assert.match(a.summary, /empty/i);
});

test("non-array input is handled safely", () => {
  // @ts-expect-error — defending the runtime boundary
  const a = analyzeCollection(null);
  assert.equal(a.vaultSize, 0);
  assert.equal(a.reliable, false);
});

test("sparse/placeholder bottles are gated out and never assert gaps", () => {
  const a = analyzeCollection([
    item({ id: "1", name: "Real One", accords: ["citrus", "fresh"], sourceConfidence: 0.95 }),
    // Below MIN_SOURCE_CONFIDENCE → excluded from analysis.
    item({ id: "2", name: "Placeholder A", accords: ["amber"], sourceConfidence: 0.2 }),
    // No descriptive tokens at all → excluded even at high confidence.
    item({ id: "3", name: "Placeholder B", sourceConfidence: 0.99 }),
  ]);
  assert.equal(a.vaultSize, 3);
  assert.equal(a.analyzableCount, 1);
  assert.equal(a.reliable, false); // 1 < MIN_ANALYZABLE_FOR_GAPS and 33% < 50%
  assert.deepEqual(a.gaps, []);
  assert.match(a.dataQualityNote, /1 of 3/);
});

test("diversity: a single-family vault is narrow; a spread is broader", () => {
  const narrow = analyzeCollection([
    item({ id: "1", name: "W1", families: ["woody"], accords: ["woody"] }),
    item({ id: "2", name: "W2", families: ["woody"], accords: ["woody"] }),
    item({ id: "3", name: "W3", families: ["woody"], accords: ["woody"] }),
  ]);
  assert.equal(narrow.families.dominant, "woody");
  assert.equal(narrow.families.diversityGrade, "narrow");

  const spread = analyzeCollection([
    item({ id: "1", name: "A", families: ["woody"], accords: ["woody"] }),
    item({ id: "2", name: "B", families: ["floral"], accords: ["floral"] }),
    item({ id: "3", name: "C", families: ["citrus"], accords: ["citrus"] }),
    item({ id: "4", name: "D", families: ["gourmand"], accords: ["gourmand"] }),
  ]);
  assert.ok(spread.families.diversityScore > narrow.families.diversityScore);
});

test("signature signals are share-thresholded, not raw counts", () => {
  // 'citrus' in 3/4 (75%) → signature. 'rose' in 1/4 (25%) → not.
  const a = analyzeCollection([
    item({ id: "1", name: "A", accords: ["citrus", "fresh"] }),
    item({ id: "2", name: "B", accords: ["citrus", "green"] }),
    item({ id: "3", name: "C", accords: ["citrus", "aquatic"] }),
    item({ id: "4", name: "D", accords: ["rose"], families: ["floral"] }),
  ]);
  const labels = a.signatureSignals.map((s) => s.label);
  assert.ok(labels.includes("citrus"));
  assert.ok(!labels.includes("rose"));
  const citrus = a.signatureSignals.find((s) => s.label === "citrus")!;
  assert.equal(citrus.count, 3);
  assert.equal(citrus.share, 0.75);
});

test("coverage gaps are detected for uncovered occasion/season slots", () => {
  // An all-fresh-citrus vault: covers fresh-daytime, misses warm/evening/etc.
  const a = analyzeCollection([
    item({ id: "1", name: "A", families: ["citrus"], accords: ["citrus", "fresh"] }),
    item({ id: "2", name: "B", families: ["citrus"], accords: ["aquatic", "marine"] }),
    item({ id: "3", name: "C", families: ["green"], accords: ["green", "fresh"] }),
  ]);
  assert.equal(a.reliable, true);
  const coveredSlots = a.coverage.covered.map((s) => s.slot);
  const gapSlots = a.coverage.gaps.map((s) => s.slot);
  assert.ok(coveredSlots.includes("fresh_daytime"));
  assert.ok(gapSlots.includes("warm_cold_weather"));
  assert.ok(gapSlots.includes("evening_statement"));
  // A high-severity warm-weather/evening gap should surface first.
  assert.ok(a.gaps.length > 0);
  assert.equal(a.gaps[0].severity, "high");
  assert.match(a.gaps[0].evidence, /0 of 3 analyzable/);
});

test("requireStrong gate: a soft incense wisp does not cover evening-statement", () => {
  const a = analyzeCollection([
    item({ id: "1", name: "Skin Incense", accords: ["incense", "woody"], longevity: 2, sillage: "intimate" }),
    item({ id: "2", name: "Fresh", accords: ["citrus", "fresh"] }),
    item({ id: "3", name: "Green", accords: ["green"] }),
  ]);
  const gapSlots = a.coverage.gaps.map((s) => s.slot);
  // Strength 2/10 < 0.5 → the incense bottle is gated out of evening_statement.
  assert.ok(gapSlots.includes("evening_statement"));
});

test("redundancy clustering groups near-duplicate bottles", () => {
  const a = analyzeCollection([
    item({ id: "1", name: "Aventus", accords: ["fruity", "smoky"], notes: ["pineapple", "birch", "musk", "oakmoss"] }),
    item({ id: "2", name: "Aventus Clone", accords: ["fruity", "smoky"], notes: ["pineapple", "birch", "musk", "oakmoss"] }),
    item({ id: "3", name: "Citrus", accords: ["citrus", "fresh"], notes: ["lemon", "bergamot"] }),
  ]);
  assert.equal(a.redundancy.clusters.length, 1);
  const cluster = a.redundancy.clusters[0];
  assert.equal(cluster.members.length, 2);
  assert.equal(cluster.band, "near-duplicate");
  assert.ok(cluster.sharedTraits.includes("smoky"));
  assert.match(a.redundancy.note ?? "", /cluster/);
});

test("a well-rounded, reliable vault yields a confident evidence-grounded summary", () => {
  const a = analyzeCollection([
    item({ id: "1", name: "Fresh", families: ["citrus"], accords: ["citrus", "fresh", "aquatic"], longevity: 5 }),
    item({ id: "2", name: "Woody", families: ["woody"], accords: ["woody", "earthy"], longevity: 7 }),
    item({ id: "3", name: "Evening", families: ["oriental"], accords: ["amber", "spicy"], longevity: 9, sillage: "strong" }),
    item({ id: "4", name: "Floral", families: ["floral"], accords: ["floral", "powdery"] }),
    item({ id: "5", name: "Sweet", families: ["gourmand"], accords: ["gourmand", "vanilla"] }),
  ]);
  assert.equal(a.reliable, true);
  assert.equal(a.analysisConfidence, 1);
  assert.equal(a.analysisConfidenceLabel, "high");
  assert.match(a.summary, /analyzable bottles/);
  // Each gap (if any) must carry real evidence — never an empty assertion.
  for (const g of a.gaps) assert.ok(g.evidence.length > 0 && g.confidence > 0);
});
