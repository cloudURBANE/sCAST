/**
 * Tests for dislike-aware candidate exclusion.
 *
 *   node --experimental-strip-types --test src/beam-agent/avoidFilter.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateMatchesAvoid, excludeAvoidedHits, parseAvoidTerms } from "./avoidFilter.ts";

test("expands an avoided family into its close synonyms", () => {
  assert.deepEqual(parseAvoidTerms("sweet"), ["sweet", "gourmand", "sugary", "candy"]);
  assert.deepEqual(parseAvoidTerms(undefined), []);
  // Multiple families dedupe their expansions.
  const terms = parseAvoidTerms("oud, woody");
  assert.ok(terms.includes("oud") && terms.includes("agarwood"));
  assert.ok(terms.includes("woody") && terms.includes("sandalwood"));
});

test("matches an avoided note inside a flattened profile, with word boundaries", () => {
  const oudHit = { accords: ["oud", "amber"], name: "Oud Satin" };
  const cleanHit = { accords: ["citrus", "aquatic"], name: "Blue Water" };
  assert.equal(candidateMatchesAvoid(oudHit, parseAvoidTerms("oud")), true);
  assert.equal(candidateMatchesAvoid(cleanHit, parseAvoidTerms("oud")), false);
  // "musk" must not match the substring inside "muskmelon-free" style noise only
  // as a whole word — a profile that genuinely lists musk does match.
  assert.equal(candidateMatchesAvoid({ accords: ["white musk"] }, parseAvoidTerms("musk")), true);
});

test("synonym expansion lets the gate flag a profile that never names the avoided word", () => {
  // The matchedAvoid backstop relies on this: avoiding "sweet" must catch a
  // gourmand-only profile that never literally says "sweet".
  const gourmandHit = { accords: ["gourmand", "vanilla"], name: "Dessert Bomb" };
  assert.equal(candidateMatchesAvoid(gourmandHit, parseAvoidTerms("sweet")), true);
  // A profile with neither the avoided word nor any synonym stays clear.
  assert.equal(candidateMatchesAvoid({ accords: ["citrus", "marine"] }, parseAvoidTerms("sweet")), false);
});

test("drops avoided candidates but never returns an empty pool", () => {
  const hits = [
    { id: "a", flat: { name: "Sweet Gourmand", accords: ["gourmand", "vanilla"] } },
    { id: "b", flat: { name: "Fresh Citrus", accords: ["citrus", "aromatic"] } },
    { id: "c", flat: { name: "Oud Wood", accords: ["oud", "woody"] } },
  ];
  const kept = excludeAvoidedHits(hits, "sweet, oud");
  assert.deepEqual(kept.map((h) => h.id), ["b"]);

  // If every candidate is avoided, fall back to the unfiltered pool (thin pool
  // beats no pool; the prompt's hard-exclusion is the backstop).
  const allAvoided = excludeAvoidedHits(hits, "sweet, oud, citrus");
  assert.equal(allAvoided.length, 3);

  // No avoid slot is a no-op.
  assert.equal(excludeAvoidedHits(hits, undefined).length, 3);
});

test("scent-vector JSON keys never defeat the avoid filter (musk/spice key collision)", () => {
  // Every vector-bearing profile carries the KEYS "musk" and "spice"; matching
  // them made avoid=musk flag the whole pool, and the never-return-empty
  // backstop then disabled the exclusion entirely.
  const vector = { freshness: 0.9, sweetness: 0.1, woodiness: 0.2, spice: 0.1, warmth: 0.1, musk: 0.05 };
  const citrus = { flat: { name: "Light Citrus", brand: "X", accords: ["citrus", "green"], scent_vector: vector } };
  const muskBomb = { flat: { name: "Musk Bomb", brand: "Y", accords: ["musk", "amber"], scent_vector: vector } };

  assert.equal(candidateMatchesAvoid(citrus.flat, parseAvoidTerms("musk")), false);
  assert.equal(candidateMatchesAvoid(muskBomb.flat, parseAvoidTerms("musk")), true);
  assert.equal(candidateMatchesAvoid(citrus.flat, parseAvoidTerms("spicy")), false);

  const kept = excludeAvoidedHits([citrus, muskBomb], "musk");
  assert.deepEqual(kept.map((h) => h.flat.name), ["Light Citrus"]);
});

test("the raw source blob does not trigger avoid matches (review-text false positive)", () => {
  const flat = {
    name: "Clean Cologne",
    accords: ["citrus"],
    raw: { review: "surprisingly not musky at all, zero oud here" },
  };
  assert.equal(candidateMatchesAvoid(flat, parseAvoidTerms("musk")), false);
  assert.equal(candidateMatchesAvoid(flat, parseAvoidTerms("oud")), false);
});
