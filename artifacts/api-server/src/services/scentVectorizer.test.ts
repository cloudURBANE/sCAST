import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateContext,
  calculatePerformance,
  vectorize,
  assessVectorCoverage,
  deriveVectorConfidence,
  type ScentVector,
} from "./scentVectorizer.ts";
import type { ParsedFragrance } from "./scentParser.ts";

function makeParsed(overrides: Partial<ParsedFragrance> = {}): ParsedFragrance {
  return {
    notes: [],
    pyramidNotes: { top: [], heart: [], base: [] },
    family: "",
    description: "",
    perfumer: "",
    concentration: "Unknown",
    accords: [],
    ...overrides,
  };
}

// --- vectorize ---------------------------------------------------------------

test("vectorize: empty parsed fragrance yields a zero vector with no +2.5 floor", () => {
  assert.deepEqual(vectorize(makeParsed()), {
    freshness: 0,
    sweetness: 0,
    woodiness: 0,
    spice: 0,
    warmth: 0,
    musk: 0,
  });
});

test("vectorize: a single citrus note in the flat list scores freshness only", () => {
  // citrus rule weight 2.0 → 2.0 * 1.0 (flat) = 2.0 → +2.5 floor → 4.5 → round 5
  assert.deepEqual(vectorize(makeParsed({ notes: ["bergamot"] })), {
    freshness: 5,
    sweetness: 0,
    woodiness: 0,
    spice: 0,
    warmth: 0,
    musk: 0,
  });
});

test("vectorize: pyramid layer weights are top=0.7, heart=1.0, base=1.4", () => {
  const inTop = vectorize(makeParsed({
    pyramidNotes: { top: ["bergamot"], heart: [], base: [] },
  }));
  const inHeart = vectorize(makeParsed({
    pyramidNotes: { top: [], heart: ["bergamot"], base: [] },
  }));
  const inBase = vectorize(makeParsed({
    pyramidNotes: { top: [], heart: [], base: ["bergamot"] },
  }));

  // 2.0 * 0.7 = 1.4 → +2.5 → 3.9 → round 4
  assert.equal(inTop.freshness, 4);
  // 2.0 * 1.0 = 2.0 → +2.5 → 4.5 → round 5
  assert.equal(inHeart.freshness, 5);
  // 2.0 * 1.4 = 2.8 → +2.5 → 5.3 → round 5
  assert.equal(inBase.freshness, 5);
});

test("vectorize: description contributes at 0.5x and triggers the +2.5 floor when positive", () => {
  // No notes, no pyramid → hasPyramid is false, parsed.notes is [] → flat layer contributes 0.
  // Description "bergamot" → freshness scoreText = 2.0 → * 0.5 = 1.0
  // 1.0 > 0 → +2.5 → 3.5 → round 4
  const v = vectorize(makeParsed({ description: "bergamot" }));
  assert.equal(v.freshness, 4);
});

test("vectorize: description-only musk note builds via the +2.5 floor", () => {
  // description "white musk" → musk rule matches "musk" and "white musk" → +2.5 + +2.5 = +5.0
  //   times 0.5 = 2.5 → +2.5 floor = 5.0 → round 5
  const v = vectorize(makeParsed({ description: "white musk" }));
  assert.equal(v.musk, 5);
});

test("vectorize: pyramid presence disables the flat-notes branch even when pyramid has matches in only one layer", () => {
  // notes is non-empty AND pyramid has values → hasPyramid=true → flat notes IGNORED.
  // Only the pyramid contributions count.
  const v = vectorize(makeParsed({
    notes: ["vanilla", "amber", "oud"], // would dominate sweetness/warmth/woodiness IF used
    pyramidNotes: { top: ["bergamot"], heart: [], base: [] },
  }));
  // freshness top contribution only: 2.0 * 0.7 = 1.4 → +2.5 → 3.9 → round 4
  assert.equal(v.freshness, 4);
  // sweetness, warmth, woodiness must NOT pick up the flat notes
  assert.equal(v.sweetness, 0);
  assert.equal(v.warmth, 0);
  assert.equal(v.woodiness, 0);
});

test("vectorize: Sauvage-like profile (bergamot/pepper/ambroxan) — snapshot", () => {
  // This locks the math for a canonical fresh-spicy fragrance shape.
  // See per-axis trace in the test for any future revisions to RULES.
  const v = vectorize(makeParsed({
    pyramidNotes: {
      top: ["bergamot"],
      heart: ["pepper"],
      base: ["ambroxan"],
    },
    description: "fresh spicy fragrance",
  }));

  // freshness: top "bergamot" citrus +2.0 * 0.7 = 1.4; description "fresh" +2.0 * 0.5 = 1.0 → 2.4 → +2.5 = 4.9 → 5
  // sweetness: nothing matches → 0
  // woodiness: base "ambroxan" iso-e-super rule +1.0 * 1.4 = 1.4 → +2.5 = 3.9 → 4
  // spice: heart "pepper" rule +2.5 * 1.0 = 2.5; description "spicy"+"spice" (substring) +1.2+1.2 = 2.4 * 0.5 = 1.2 → 3.7 → +2.5 = 6.2 → 6
  // warmth: base "ambroxan" ambroxan-rule +2.0 * 1.4 = 2.8 → +2.5 = 5.3 → 5
  // musk: base "ambroxan" ambroxan-rule +1.8 * 1.4 = 2.52 → +2.5 = 5.02 → 5
  assert.deepEqual(v, {
    freshness: 5,
    sweetness: 0,
    woodiness: 4,
    spice: 6,
    warmth: 5,
    musk: 5,
  });
});

test("vectorize: dense base-layer woodiness clamps at 10", () => {
  // Pile several high-weight woodiness rules into the base layer (weight 1.4).
  // Raw sums easily exceed 10 even before the floor; expect clamp.
  const v = vectorize(makeParsed({
    pyramidNotes: {
      top: [],
      heart: [],
      base: ["cedar", "sandalwood", "vetiver", "patchouli", "oud", "guaiac", "oakmoss"],
    },
  }));
  assert.equal(v.woodiness, 10);
});

test("vectorize: a single occurrence of a rule word adds the weight once, not per-occurrence", () => {
  // scoreText uses `text.includes(word)` → either 0 or weight, regardless of frequency.
  // notes "bergamot bergamot bergamot" contributes the same as "bergamot".
  const single = vectorize(makeParsed({ notes: ["bergamot"] }));
  const triple = vectorize(makeParsed({ notes: ["bergamot", "bergamot", "bergamot"] }));
  assert.equal(single.freshness, triple.freshness);
});

// --- A2-GAP2: whole-token matching -------------------------------------------

test("vectorize: whole-token matching no longer leaks across note boundaries", () => {
  // "lukewarm" must NOT trigger the warmth "warm" rule; "seasonal" must NOT
  // trigger the freshness "sea" rule (the old substring scan did both).
  const v = vectorize(makeParsed({ notes: ["lukewarm", "seasonal"] }));
  assert.equal(v.warmth, 0);
  assert.equal(v.freshness, 0);
});

test("vectorize: expanded dictionary recognizes lavender/coconut/tea", () => {
  // GAP1: these mapped to nothing before. Each is a single flat note → weight →
  // +2.5 floor → a non-zero axis.
  assert.ok(vectorize(makeParsed({ notes: ["lavender"] })).freshness > 0);
  assert.ok(vectorize(makeParsed({ notes: ["coconut"] })).sweetness > 0);
  assert.ok(vectorize(makeParsed({ notes: ["green tea"] })).freshness > 0);
});

// --- A2-GAP4: accord pass ----------------------------------------------------

test("vectorize: parsed accords nudge their axes at a low weight", () => {
  // No notes/pyramid/description — only accords. "gourmand"→sweetness,
  // "leathery"→warmth, "chypre"→woodiness+freshness. Each adds 0.8 → +2.5 floor.
  const v = vectorize(makeParsed({ accords: ["gourmand", "leathery", "chypre"] }));
  assert.ok(v.sweetness > 0, "gourmand → sweetness");
  assert.ok(v.warmth > 0, "leathery → warmth");
  assert.ok(v.woodiness > 0, "chypre → woodiness");
  assert.ok(v.freshness > 0, "chypre → freshness");
  // An unmapped axis stays zero.
  assert.equal(v.musk, 0);
});

test("vectorize: empty accords list leaves the vector untouched (back-compat)", () => {
  assert.deepEqual(vectorize(makeParsed({ notes: ["bergamot"], accords: [] })), {
    freshness: 5,
    sweetness: 0,
    woodiness: 0,
    spice: 0,
    warmth: 0,
    musk: 0,
  });
});

// --- A2-GAP1/3: coverage + confidence ----------------------------------------

test("assessVectorCoverage: ratio of recognized notes to total notes", () => {
  // 2 recognized (bergamot, vanilla) of 3 notes; "zorblax" is unknown.
  const cov = assessVectorCoverage(makeParsed({ notes: ["bergamot", "vanilla", "zorblax"] }));
  assert.equal(cov.total_notes, 3);
  assert.equal(cov.matched_notes, 2);
  assert.ok(Math.abs(cov.match_ratio - 2 / 3) < 1e-9);
});

test("assessVectorCoverage: no notes yields zero coverage", () => {
  assert.deepEqual(assessVectorCoverage(makeParsed()), {
    matched_notes: 0,
    total_notes: 0,
    match_ratio: 0,
  });
});

test("assessVectorCoverage: prefers pyramid notes when present", () => {
  const cov = assessVectorCoverage(makeParsed({
    notes: ["ignored-flat"],
    pyramidNotes: { top: ["bergamot"], heart: ["jasmine"], base: ["oud"] },
  }));
  assert.equal(cov.total_notes, 3);
  assert.equal(cov.matched_notes, 3);
});

test("deriveVectorConfidence: none/low/ok bands", () => {
  assert.equal(deriveVectorConfidence({ matched_notes: 0, total_notes: 4, match_ratio: 0 }), "none");
  assert.equal(deriveVectorConfidence({ matched_notes: 2, total_notes: 8, match_ratio: 0.25 }), "low");
  assert.equal(deriveVectorConfidence({ matched_notes: 5, total_notes: 6, match_ratio: 0.83 }), "ok");
});

// --- calculatePerformance ----------------------------------------------------

test("calculatePerformance: note-less vector is de-rated when coverage proves no match", () => {
  const zero: ScentVector = { freshness: 0, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0 };
  // Without coverage: the legacy { sillage: 3, longevity: 4 } baseline.
  assert.deepEqual(
    calculatePerformance(zero, "Fresh", "Eau de Toilette"),
    { sillage: 3, longevity: 4 },
  );
  // With zero-match coverage: de-rated one band so an empty profile cannot
  // present confident performance.
  assert.deepEqual(
    calculatePerformance(zero, "Fresh", "Eau de Toilette", { matched_notes: 0, total_notes: 0, match_ratio: 0 }),
    { sillage: 2, longevity: 3 },
  );
});



const SAUVAGE_LIKE_VECTOR: ScentVector = {
  freshness: 5,
  sweetness: 0,
  woodiness: 4,
  spice: 6,
  warmth: 5,
  musk: 5,
};

test("calculatePerformance: baseline EDP — locks longevity/sillage math for the Sauvage-like vector", () => {
  // heaviness = (4*1.3 + 5*1.2 + 5*1.0 + 6*0.5) / 4 = 19.2 / 4 = 4.8
  // longevity_raw = round(4 + 4.8*0.7 - 5*0.15) = round(6.61) = 7
  // sillage_raw = round(3 + (6*0.7 + 0*0.5 + 4*0.4 + 5*0.4 + 5*0.3) / 3) = round(3 + 9.3/3) = round(6.1) = 6
  // family "Fresh Spicy" has no "parfum"/"intense" → no family boost
  // EDP concentration boost: longevity +1, sillage +1
  // → longevity 8, sillage 7
  assert.deepEqual(
    calculatePerformance(SAUVAGE_LIKE_VECTOR, "Fresh Spicy", "Eau de Parfum"),
    { sillage: 7, longevity: 8 },
  );
});

test("calculatePerformance: family containing 'parfum' or 'intense' stacks with concentration boost", () => {
  // raw 7/6 → family boost +1/+1 → 8/7 → EDP concentration boost +1/+1 → 9/8
  assert.deepEqual(
    calculatePerformance(SAUVAGE_LIKE_VECTOR, "Oriental Parfum", "Eau de Parfum"),
    { sillage: 8, longevity: 9 },
  );
  assert.deepEqual(
    calculatePerformance(SAUVAGE_LIKE_VECTOR, "Woody Intense", "Eau de Parfum"),
    { sillage: 8, longevity: 9 },
  );
});

test("calculatePerformance: Extrait concentration boost is +3 longevity / +2 sillage", () => {
  // raw 7/6 → no family boost → Extrait +3/+2 → 10/8
  assert.deepEqual(
    calculatePerformance(SAUVAGE_LIKE_VECTOR, "Fresh Spicy", "Extrait"),
    { sillage: 8, longevity: 10 },
  );
});

test("calculatePerformance: Body Spray and EDC concentrations apply negative boosts", () => {
  const zero: ScentVector = { freshness: 0, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0 };
  // raw longevity = round(4 + 0 - 0) = 4; raw sillage = round(3) = 3
  // Body Spray: longevity -2, sillage -1 → 2/2
  assert.deepEqual(
    calculatePerformance(zero, "Fresh", "Body Spray"),
    { sillage: 2, longevity: 2 },
  );
  // EDC: longevity -1, sillage -1 → 3/2
  assert.deepEqual(
    calculatePerformance(zero, "Fresh", "Eau de Cologne"),
    { sillage: 2, longevity: 3 },
  );
});

test("calculatePerformance: unknown concentration string falls back to the Unknown boost (zero)", () => {
  const zero: ScentVector = { freshness: 0, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0 };
  assert.deepEqual(
    calculatePerformance(zero, "Fresh", "Made Up Concentration"),
    { sillage: 3, longevity: 4 },
  );
});

test("calculatePerformance: clamps to [1, 10]", () => {
  const max: ScentVector = { freshness: 0, sweetness: 10, woodiness: 10, spice: 10, warmth: 10, musk: 10 };
  const res = calculatePerformance(max, "Oriental Parfum", "Extrait");
  assert.ok(res.longevity <= 10 && res.longevity >= 1);
  assert.ok(res.sillage <= 10 && res.sillage >= 1);
  assert.equal(res.longevity, 10);
  assert.equal(res.sillage, 10);

  // A vector + concentration designed to drive longevity below 1 should clamp to 1.
  const ultraFreshBodySpray: ScentVector = { freshness: 10, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0 };
  const low = calculatePerformance(ultraFreshBodySpray, "Fresh", "Body Spray");
  assert.ok(low.longevity >= 1);
  assert.ok(low.sillage >= 1);
});

// --- calculateContext --------------------------------------------------------

test("calculateContext: zero vector returns Universal weather and Daily Wear occasion", () => {
  const zero: ScentVector = { freshness: 0, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0 };
  assert.deepEqual(calculateContext(zero), {
    weather: ["Universal"],
    occasion: ["Daily Wear"],
  });
});

test("calculateContext: Sauvage-like vector surfaces warm+mild AND cool+cold (deduped, in trigger order)", () => {
  // fresh>=5 → Warm,Mild; Casual,Daytime
  // warmth>=5 OR spice>=5 → Cool,Cold; Evening,Formal
  // musk>=5 → Professional,Social (weather not empty, no Universal push)
  // fresh>=5 && wood>=5? wood=4 → no
  // sweet>=6? no
  // fresh>=7 && warmth<4? freshness=5 → no
  const ctx = calculateContext(SAUVAGE_LIKE_VECTOR);
  assert.deepEqual(ctx.weather, ["Warm", "Mild", "Cool", "Cold"]);
  assert.deepEqual(ctx.occasion, [
    "Casual",
    "Daytime",
    "Evening",
    "Formal",
    "Professional",
    "Social",
  ]);
});

test("calculateContext: sport profile (high freshness, low warmth) adds Sport/Outdoor without doubling Warm", () => {
  const v: ScentVector = { freshness: 8, sweetness: 0, woodiness: 0, spice: 0, warmth: 2, musk: 0 };
  const ctx = calculateContext(v);
  assert.deepEqual(ctx.weather, ["Warm", "Mild"]); // "Warm" only once after dedup
  assert.deepEqual(ctx.occasion, ["Casual", "Daytime", "Sport", "Outdoor"]);
});

test("calculateContext: date-night sweetness (sweet>=6) adds Cool weather and intimate occasions", () => {
  const v: ScentVector = { freshness: 0, sweetness: 7, woodiness: 0, spice: 0, warmth: 0, musk: 0 };
  const ctx = calculateContext(v);
  assert.deepEqual(ctx.weather, ["Cool"]);
  assert.deepEqual(ctx.occasion, ["Date Night", "Intimate"]);
});

test("calculateContext: executive profile (fresh>=5 && wood>=5) adds Executive/Social Dominance and Universal weather", () => {
  const v: ScentVector = { freshness: 6, sweetness: 0, woodiness: 6, spice: 0, warmth: 0, musk: 0 };
  const ctx = calculateContext(v);
  assert.deepEqual(ctx.weather, ["Warm", "Mild", "Universal"]);
  assert.deepEqual(ctx.occasion, [
    "Casual",
    "Daytime",
    "Professional",
    "Social",
    "Executive",
    "Social Dominance",
  ]);
});

test("calculateContext: woodiness/musk alone push Universal when no weather has been set yet", () => {
  const v: ScentVector = { freshness: 0, sweetness: 0, woodiness: 6, spice: 0, warmth: 0, musk: 0 };
  const ctx = calculateContext(v);
  assert.deepEqual(ctx.weather, ["Universal"]);
  assert.deepEqual(ctx.occasion, ["Professional", "Social"]);
});
