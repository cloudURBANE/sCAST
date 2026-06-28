import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHeroTickerPhrases,
  SIGNATURE_SHARE,
  SIGNATURE_MIN_COUNT,
  MIN_ANALYZABLE_FOR_SIGNATURE,
  VECTOR_TRAIT_THRESHOLD,
  type HeroPhrase,
  type HeroTickerItem,
} from "./heroTickerPhrases.ts";

const flat = (phrase: HeroPhrase): string => phrase.map((s) => s.text).join("");
const has = (phrases: HeroPhrase[], substr: string) =>
  phrases.some((p) => flat(p).includes(substr));

// A fully-analyzable bottle: real notes + complete source coverage.
function bottle(over: Partial<HeroTickerItem> = {}): HeroTickerItem {
  return {
    family: "Woody",
    notes: ["Cedar", "Vetiver"],
    brand: "House A",
    season: "Fall",
    source_coverage: { basenotes: true, fragrantica: true, complete: true },
    ...over,
  };
}

test("empty vault returns the neutral fallback (3 phrases, no signature claims)", () => {
  const phrases = buildHeroTickerPhrases([]);
  assert.equal(phrases.length, 3);
  assert.ok(has(phrases, "Add scents to your vault"));
  assert.ok(!has(phrases, "Recurring molecule"));
});

test("a note appearing only twice across a large vault is NOT a recurring molecule", () => {
  // 20 bottles, only 2 carry 'oud' → share 0.1, well under SIGNATURE_SHARE.
  const items: HeroTickerItem[] = [];
  for (let i = 0; i < 18; i++) items.push(bottle({ notes: ["Lemon"], brand: `B${i}` }));
  items.push(bottle({ notes: ["Oud", "Lemon"], brand: "X" }));
  items.push(bottle({ notes: ["Oud", "Lemon"], brand: "Y" }));
  const phrases = buildHeroTickerPhrases(items);
  assert.ok(!has(phrases, "Oud"), "raw count of 2 must not assert a molecule");
});

test("a note crossing the share threshold IS a recurring molecule", () => {
  // 5 bottles, 3 carry 'vanilla' → share 0.6 >= SIGNATURE_SHARE and count >= min.
  const items = [
    bottle({ notes: ["Vanilla", "Tonka"], brand: "B1" }),
    bottle({ notes: ["Vanilla"], brand: "B2" }),
    bottle({ notes: ["Vanilla"], brand: "B3" }),
    bottle({ notes: ["Lemon"], brand: "B4" }),
    bottle({ notes: ["Cedar"], brand: "B5" }),
  ];
  const phrases = buildHeroTickerPhrases(items);
  assert.ok(has(phrases, "Recurring molecule detected: vanilla"));
});

test("note tokens are normalized and de-duped per bottle (twice in one bottle counts once)", () => {
  // 3 bottles. Bottle 1 lists Musk twice; that must count as ONE bottle, so
  // share = 1/3 < SIGNATURE_SHARE and no molecule is asserted.
  const items = [
    bottle({ notes: ["Musk", "musk", " MUSK "], brand: "B1" }),
    bottle({ notes: ["Lemon"], brand: "B2" }),
    bottle({ notes: ["Cedar"], brand: "B3" }),
  ];
  const phrases = buildHeroTickerPhrases(items);
  assert.ok(!has(phrases, "musk"), "duplicate listing in one bottle must not inflate count");
});

test("bottles with incomplete source coverage are excluded from the note signal", () => {
  // 4 'rose' bottles but all have incomplete coverage → none analyzable for notes
  // → fewer than MIN_ANALYZABLE_FOR_SIGNATURE → no molecule asserted.
  const items = [
    bottle({ notes: ["Rose"], source_coverage: { basenotes: true, fragrantica: false }, brand: "B1" }),
    bottle({ notes: ["Rose"], source_coverage: { basenotes: false }, brand: "B2" }),
    bottle({ notes: ["Rose"], source_coverage: { fragrantica: true }, brand: "B3" }),
    bottle({ notes: ["Rose"], source_coverage: {}, brand: "B4" }),
  ];
  const phrases = buildHeroTickerPhrases(items);
  assert.ok(!has(phrases, "rose"), "placeholder/partial bottles must not fabricate a signature");
});

test("legacy rows without a coverage object still count if they carry real notes", () => {
  const items = [
    bottle({ notes: ["Iris"], source_coverage: undefined, brand: "B1" }),
    bottle({ notes: ["Iris"], source_coverage: undefined, brand: "B2" }),
    bottle({ notes: ["Iris"], source_coverage: undefined, brand: "B3" }),
  ];
  const phrases = buildHeroTickerPhrases(items);
  assert.ok(has(phrases, "Recurring molecule detected: iris"));
});

test("too few analyzable bottles asserts no molecule (absence reported as such)", () => {
  // Only 2 analyzable bottles — under MIN_ANALYZABLE_FOR_SIGNATURE.
  const items = [
    bottle({ notes: ["Amber"], brand: "B1" }),
    bottle({ notes: ["Amber"], brand: "B2" }),
  ];
  const phrases = buildHeroTickerPhrases(items);
  assert.ok(!has(phrases, "Recurring molecule"));
});

test("vector axis at the WS-7 present-trait threshold (>=3) is described; below is not", () => {
  const present = buildHeroTickerPhrases([
    bottle({ scent_vector: { freshness: 0, sweetness: 0, woodiness: VECTOR_TRAIT_THRESHOLD, spice: 0, warmth: 0, musk: 0 } }),
  ]);
  assert.ok(has(present, "Your vault reads woody and grounded"));

  const below = buildHeroTickerPhrases([
    bottle({ scent_vector: { freshness: 2.9, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0 } }),
  ]);
  assert.ok(!has(below, "Your vault reads"), "an axis under 3/10 is not a present trait");
});

test("dominant season uses a share threshold, not raw 'appears twice'", () => {
  // 10 bottles, only 2 'Winter' → share 0.2 < SIGNATURE_SHARE → not calibrated.
  const items: HeroTickerItem[] = [];
  for (let i = 0; i < 8; i++) items.push(bottle({ season: "Summer", brand: `B${i}` }));
  items.push(bottle({ season: "Winter", brand: "X" }));
  items.push(bottle({ season: "Winter", brand: "Y" }));
  const phrases = buildHeroTickerPhrases(items);
  assert.ok(!has(phrases, "Calibrated for winter"));
  assert.ok(has(phrases, "Calibrated for summer"));
});

test("distinct-house count is reported when more than one house is present", () => {
  const items = [
    bottle({ brand: "House A" }),
    bottle({ brand: "House B" }),
    bottle({ brand: "House C" }),
  ];
  const phrases = buildHeroTickerPhrases(items);
  assert.ok(has(phrases, "3 houses"));
});

test("returned phrases keep the segment shape with exactly one key per signal phrase", () => {
  const phrases = buildHeroTickerPhrases([
    bottle({ notes: ["Vanilla"], brand: "B1" }),
    bottle({ notes: ["Vanilla"], brand: "B2" }),
    bottle({ notes: ["Vanilla"], brand: "B3" }),
  ]);
  for (const phrase of phrases) {
    assert.ok(Array.isArray(phrase));
    const keyCount = phrase.filter((s) => s.key).length;
    // Plain filler/neutral phrases have 0 keys; signal phrases have exactly 1.
    assert.ok(keyCount === 0 || keyCount === 1);
    for (const seg of phrase) assert.equal(typeof seg.text, "string");
  }
});

test("a degenerate single bottle pads with the two filler phrases (original behavior)", () => {
  // Matches the legacy `getHeroTickerPhrases`: a non-empty vault with no usable
  // signals yields 0 signal phrases + the 2 filler phrases (it pushes exactly two
  // fillers, it does not guarantee a 3rd line — unchanged here).
  const phrases = buildHeroTickerPhrases([bottle({ notes: [], family: "", season: "", brand: "", source_coverage: null })]);
  assert.equal(phrases.length, 2);
  assert.ok(has(phrases, "Olfactory intelligence active"));
  assert.ok(has(phrases, "Atmospheric pairing in progress"));
});

// Sanity: the constants mirror the engine's discipline.
test("thresholds mirror collectionAnalysis.ts discipline", () => {
  assert.equal(SIGNATURE_SHARE, 0.4);
  assert.equal(SIGNATURE_MIN_COUNT, 2);
  assert.equal(MIN_ANALYZABLE_FOR_SIGNATURE, 3);
  assert.equal(VECTOR_TRAIT_THRESHOLD, 3);
});
