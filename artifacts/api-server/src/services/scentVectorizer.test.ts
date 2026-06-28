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
  // WS-7: citrus weight 2.0 * positionWeight 1.0; one matched note → denom
  // sqrt(1)=1; * VECTOR_GAIN 2.4 = 4.8 → round 5. No additive floor.
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

  // WS-7: one matched note → denom sqrt(1)=1, gain 2.4. No additive floor, so the
  // top/heart/base position weighting is now visible across the full range.
  // top:  2.0 * 0.7 * 2.4 = 3.36 → round 3
  assert.equal(inTop.freshness, 3);
  // heart: 2.0 * 1.0 * 2.4 = 4.8 → round 5
  assert.equal(inHeart.freshness, 5);
  // base: 2.0 * 1.4 * 2.4 = 6.72 → round 7
  assert.equal(inBase.freshness, 7);
});

test("vectorize: description is scored at 0.5x only when there are no notes/pyramid", () => {
  // WS-7: with no notes and no pyramid the description IS the only signal source.
  // "bergamot" → freshness rule weight 2.0 * 0.5 = 1.0; matchedNoteCount is 0 so
  // denom is sqrt(1)=1; 1.0 * 2.4 = 2.4 → round 2. No additive floor.
  const v = vectorize(makeParsed({ description: "bergamot" }));
  assert.equal(v.freshness, 2);
});

test("vectorize: description-only musk note builds without the floor", () => {
  // WS-7: "white musk" matches the musk rule once per axis (max weight 2.5) → * 0.5
  // = 1.25; denom 1; 1.25 * 2.4 = 3.0 → round 3.
  const v = vectorize(makeParsed({ description: "white musk" }));
  assert.equal(v.musk, 3);
});

test("vectorize: pyramid presence disables the flat-notes branch even when pyramid has matches in only one layer", () => {
  // notes is non-empty AND pyramid has values → hasPyramid=true → flat notes IGNORED.
  // Only the pyramid contributions count.
  const v = vectorize(makeParsed({
    notes: ["vanilla", "amber", "oud"], // would dominate sweetness/warmth/woodiness IF used
    pyramidNotes: { top: ["bergamot"], heart: [], base: [] },
  }));
  // WS-7: freshness top contribution only: 2.0 * 0.7 * 2.4 = 3.36 → round 3
  assert.equal(v.freshness, 3);
  // sweetness, warmth, woodiness must NOT pick up the flat notes
  assert.equal(v.sweetness, 0);
  assert.equal(v.warmth, 0);
  assert.equal(v.woodiness, 0);
});

test("vectorize: Sauvage-like profile (bergamot/pepper/ambroxan) — snapshot", () => {
  // This locks the math for a canonical fresh-spicy fragrance shape.
  // WS-7: the description is NOT scored here because notes/pyramid exist; ambroxan
  // is pinned to its primary axis (warmth) so it no longer leaks into woodiness
  // (was 4) or musk (was 5). Three matched notes → denom sqrt(3) ≈ 1.732, gain 2.4.
  const v = vectorize(makeParsed({
    pyramidNotes: {
      top: ["bergamot"],
      heart: ["pepper"],
      base: ["ambroxan"],
    },
    description: "fresh spicy fragrance",
  }));

  // freshness: "bergamot" citrus 2.0 * top 0.7 = 1.4 → /1.732 * 2.4 = 1.94 → round 2
  // sweetness: nothing → 0
  // woodiness: ambroxan leak suppressed (primary is warmth) → 0
  // spice:     "pepper" 2.5 * heart 1.0 = 2.5 → /1.732 * 2.4 = 3.46 → round 3
  // warmth:    "ambroxan" 2.0 * base 1.4 = 2.8 → /1.732 * 2.4 = 3.88 → round 4
  // musk:      ambroxan leak suppressed (primary is warmth) → 0
  assert.deepEqual(v, {
    freshness: 2,
    sweetness: 0,
    woodiness: 0,
    spice: 3,
    warmth: 4,
    musk: 0,
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
  // WS-7: scoring is per DISTINCT note, so repeated identical notes collapse to one.
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
  // GAP1: these mapped to nothing before. Each is a single flat note → weight ×
  // gain → a non-zero axis (WS-7: no additive floor).
  assert.ok(vectorize(makeParsed({ notes: ["lavender"] })).freshness > 0);
  assert.ok(vectorize(makeParsed({ notes: ["coconut"] })).sweetness > 0);
  assert.ok(vectorize(makeParsed({ notes: ["green tea"] })).freshness > 0);
});

// --- A2-GAP4: accord pass ----------------------------------------------------

test("vectorize: parsed accords nudge their axes at a low weight", () => {
  // No notes/pyramid/description — only accords. "gourmand"→sweetness,
  // "leathery"→warmth, "chypre"→woodiness+freshness. Each adds 0.8 × gain (WS-7:
  // no additive floor) → a non-zero axis.
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

// --- WS-7: golden reference vectors (dominant axis + no cross-axis leakage) ---
//
// These lock the post-WS-7 behavior for a reference set spanning the major scent
// shapes. They are the reviewable before→after of the recommendation-shifting
// change. Recorded BASELINE (old per-layer scan + unconditional +2.5 floor +
// always-scored description), for review of the shift:
//   pure_oud             {"freshness":0,"sweetness":3,"woodiness":10,"spice":7,"warmth":0,"musk":0}
//   aquatic_marine       {"freshness":10,"sweetness":0,"woodiness":4,"spice":0,"warmth":5,"musk":9}
//   gourmand             {"freshness":4,"sweetness":10,"woodiness":0,"spice":0,"warmth":0,"musk":0}
//   citrus               {"freshness":10,"sweetness":0,"woodiness":0,"spice":0,"warmth":0,"musk":10}
//   mixed_woody_aromatic {"freshness":5,"sweetness":0,"woodiness":10,"spice":9,"warmth":5,"musk":5}
//   mixed_spicy_amber    {"freshness":0,"sweetness":6,"woodiness":0,"spice":10,"warmth":10,"musk":0}
//
// In every old vector a clean scent picked up 2-3 inflated axes (oud→spice 7,
// ambroxan→musk 9 / warmth 5, white musk→musk 10). The new vectors below keep the
// correct dominant axis and hold leaked axes to <=3 (≤30% of the 0-10 range).

const MAX_LEAK = 3;

type GoldenRef = {
  id: string;
  parsed: ParsedFragrance;
  expected: ScentVector;
  dominant: keyof ScentVector;
  mustStayLow: Array<keyof ScentVector>;
};

const GOLDEN: GoldenRef[] = [
  {
    id: "pure_oud",
    parsed: makeParsed({
      pyramidNotes: { top: ["saffron"], heart: ["rose", "oud"], base: ["oud", "agarwood", "sandalwood"] },
    }),
    expected: { freshness: 0, sweetness: 1, woodiness: 10, spice: 2, warmth: 0, musk: 0 },
    dominant: "woodiness",
    mustStayLow: ["spice", "warmth", "musk", "freshness"], // oud no longer leaks to spice (was 7)
  },
  {
    id: "aquatic_marine",
    parsed: makeParsed({
      pyramidNotes: { top: ["bergamot", "sea salt"], heart: ["marine", "ozone"], base: ["ambroxan", "musk"] },
    }),
    expected: { freshness: 7, sweetness: 0, woodiness: 0, spice: 0, warmth: 3, musk: 3 },
    dominant: "freshness",
    mustStayLow: ["woodiness", "spice", "sweetness"], // ambroxan no longer inflates musk (was 9)/warmth (was 5)
  },
  {
    id: "gourmand",
    parsed: makeParsed({
      pyramidNotes: { top: ["bergamot"], heart: ["caramel", "praline"], base: ["vanilla", "tonka bean"] },
    }),
    expected: { freshness: 2, sweetness: 10, woodiness: 0, spice: 0, warmth: 0, musk: 0 },
    dominant: "sweetness",
    mustStayLow: ["woodiness", "spice", "warmth", "musk"],
  },
  {
    id: "citrus",
    parsed: makeParsed({
      pyramidNotes: { top: ["lemon", "bergamot", "grapefruit"], heart: ["neroli", "petitgrain"], base: ["white musk"] },
    }),
    expected: { freshness: 8, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 3 },
    dominant: "freshness",
    mustStayLow: ["woodiness", "spice", "warmth", "sweetness"], // white musk no longer ties the dominant (was 10)
  },
  {
    id: "mixed_woody_aromatic",
    parsed: makeParsed({
      pyramidNotes: { top: ["bergamot", "pepper"], heart: ["lavender", "sichuan pepper", "geranium"], base: ["ambroxan", "cedar", "vetiver"] },
    }),
    expected: { freshness: 2, sweetness: 0, woodiness: 5, spice: 4, warmth: 3, musk: 0 },
    dominant: "woodiness",
    mustStayLow: ["musk", "sweetness", "freshness"], // ambroxan no longer inflates musk (was 5)
  },
  {
    id: "mixed_spicy_amber",
    parsed: makeParsed({
      pyramidNotes: { top: ["cardamom", "pink pepper"], heart: ["cinnamon", "clove"], base: ["amber", "labdanum", "vanilla"] },
    }),
    expected: { freshness: 0, sweetness: 3, woodiness: 0, spice: 6, warmth: 6, musk: 0 },
    dominant: "spice", // genuinely spice+amber; both are real, no fabricated axes
    mustStayLow: ["woodiness", "musk", "freshness"],
  },
];

function dominantAxis(v: ScentVector): keyof ScentVector {
  let best: keyof ScentVector = "freshness";
  for (const key of Object.keys(v) as Array<keyof ScentVector>) {
    if (v[key] > v[best]) best = key;
  }
  return best;
}

for (const ref of GOLDEN) {
  test(`WS-7 golden vector — ${ref.id}`, () => {
    const v = vectorize(ref.parsed);
    assert.deepEqual(v, ref.expected, `vector for ${ref.id}`);
    assert.equal(dominantAxis(v), ref.dominant, `dominant axis for ${ref.id}`);
    assert.ok(v[ref.dominant] >= 5, `dominant axis ${ref.dominant} should be strong (got ${v[ref.dominant]})`);
    for (const axis of ref.mustStayLow) {
      assert.ok(v[axis] <= MAX_LEAK, `${ref.id}: ${axis} inflated to ${v[axis]} (expected <= ${MAX_LEAK})`);
      assert.ok(v[axis] < v[ref.dominant], `${ref.id}: ${axis} (${v[axis]}) should be below dominant ${ref.dominant} (${v[ref.dominant]})`);
    }
  });
}

test("WS-7: shared ingredient oud does not leak into spice without a real spice note", () => {
  const v = vectorize(makeParsed({ notes: ["oud", "agarwood"] }));
  assert.equal(dominantAxis(v), "woodiness");
  assert.equal(v.spice, 0, "oud must not contribute to spice");
});

test("WS-7: a genuine spice note alongside oud still scores spice", () => {
  const v = vectorize(makeParsed({ notes: ["oud", "black pepper", "saffron"] }));
  assert.ok(v.woodiness > 0, "oud feeds woodiness");
  assert.ok(v.spice > 0, "real spice notes still feed spice");
});

test("WS-7: description does not contaminate a note-backed vector", () => {
  const v = vectorize(makeParsed({
    notes: ["cedar"],
    description: "vanilla caramel honey sweet gourmand chocolate",
  }));
  assert.equal(v.sweetness, 0, "description sweetness must not leak into a note-backed vector");
  assert.ok(v.woodiness > 0);
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
