import assert from "node:assert/strict";
import { test } from "node:test";

import {
  idealWarmth,
  thermalHarmony,
  seasonWeightsForClimate,
  seasonHarmony,
  planWeeklyOutlook,
  type OutlookCandidate,
  type OutlookDayInput,
  type SeasonAffinity,
} from "./weeklyOutlookPlanner.ts";

const WINTER: SeasonAffinity = [1, 0, 0, 0];
const SUMMER: SeasonAffinity = [0, 0, 1, 0];

const fresh: OutlookCandidate = { id: "fresh", warmth: 0.1, freshness: 0.9, projection: 0.4 };
const warm: OutlookCandidate = { id: "warm", warmth: 0.9, freshness: 0.1, projection: 0.7 };
const middle: OutlookCandidate = { id: "middle", warmth: 0.5, freshness: 0.5, projection: 0.5 };

test("idealWarmth rises as temperature falls", () => {
  const cold = idealWarmth({ temperature_f: 35, humidity: 50 });
  const mild = idealWarmth({ temperature_f: 70, humidity: 50 });
  const hot = idealWarmth({ temperature_f: 92, humidity: 50 });
  assert.ok(cold > mild, "cold day should want warmer scents than mild");
  assert.ok(mild > hot, "mild day should want warmer scents than hot");
  assert.ok(cold <= 1 && hot >= 0, "ideal warmth stays in range");
});

test("humidity pushes the ideal toward fresh", () => {
  const dry = idealWarmth({ temperature_f: 80, humidity: 20 });
  const muggy = idealWarmth({ temperature_f: 80, humidity: 90 });
  assert.ok(muggy < dry, "muggy air should demand fresher scents");
});

test("thermalHarmony favors warm scents in cold air and fresh scents in heat", () => {
  const cold = { temperature_f: 35, humidity: 50 };
  const hot = { temperature_f: 92, humidity: 70 };
  assert.ok(thermalHarmony(warm, cold) > thermalHarmony(fresh, cold), "warm wins the cold day");
  assert.ok(thermalHarmony(fresh, hot) > thermalHarmony(warm, hot), "fresh wins the hot day");
});

test("a week of varying weather surfaces weather-appropriate, varied picks", () => {
  const candidates = [fresh, warm, middle];
  // Equal base scores so the weather term alone drives the choice.
  const baseScores = [80, 80, 80];
  const days: OutlookDayInput[] = [
    { climate: { temperature_f: 30, humidity: 40 }, baseScores },
    { climate: { temperature_f: 88, humidity: 75 }, baseScores },
    { climate: { temperature_f: 65, humidity: 50 }, baseScores },
  ];

  const plan = planWeeklyOutlook(candidates, days);
  assert.equal(plan.length, 3);
  assert.equal(candidates[plan[0].candidateIndex].id, "warm", "freezing day → warm scent");
  assert.equal(candidates[plan[1].candidateIndex].id, "fresh", "hot humid day → fresh scent");
});

test("identical days still rotate bottles instead of repeating one", () => {
  // Five near-equal candidates and seven identical mild days. Without the
  // repeat penalty the lowest-index bottle would win all seven; with it, the
  // week should spread across distinct bottles.
  const candidates: OutlookCandidate[] = Array.from({ length: 5 }, (_, i) => ({
    id: `frag-${i}`,
    warmth: 0.5,
    freshness: 0.5,
    projection: 0.5,
  }));
  const baseScores = candidates.map(() => 80);
  const days: OutlookDayInput[] = Array.from({ length: 7 }, () => ({
    climate: { temperature_f: 68, humidity: 50 },
    baseScores,
  }));

  const plan = planWeeklyOutlook(candidates, days);
  const distinct = new Set(plan.map((p) => p.candidateIndex));
  assert.ok(distinct.size >= 4, `expected variety across the week, got ${distinct.size} distinct`);
});

test("a strongly-fitting bottle still leads despite the variety penalty", () => {
  const candidates = [warm, fresh];
  // warm has a big base-score edge AND fits a cold week.
  const days: OutlookDayInput[] = Array.from({ length: 3 }, () => ({
    climate: { temperature_f: 32, humidity: 40 },
    baseScores: [140, 70],
  }));
  const plan = planWeeklyOutlook(candidates, days);
  assert.equal(candidates[plan[0].candidateIndex].id, "warm", "best bottle leads day 1");
});

test("season weights track temperature: cold → winter, hot → summer", () => {
  const cold = seasonWeightsForClimate({ temperature_f: 30, humidity: 40 });
  const hot = seasonWeightsForClimate({ temperature_f: 90, humidity: 60 });
  // [winter, spring, summer, fall]
  assert.ok(cold[0] > cold[2], "cold day weights winter over summer");
  assert.ok(hot[2] > hot[0], "hot day weights summer over winter");
});

test("seasonHarmony rewards a fragrance voted for the day's season", () => {
  const coldDay = { temperature_f: 32, humidity: 40 };
  const winterFrag: OutlookCandidate = { id: "w", warmth: 0.5, freshness: 0.5, projection: 0.5, seasonAffinity: WINTER };
  const summerFrag: OutlookCandidate = { id: "s", warmth: 0.5, freshness: 0.5, projection: 0.5, seasonAffinity: SUMMER };
  assert.ok(seasonHarmony(winterFrag, coldDay) > seasonHarmony(summerFrag, coldDay));
  // No season data → neutral, never a hard penalty.
  const unknown: OutlookCandidate = { id: "u", warmth: 0.5, freshness: 0.5, projection: 0.5 };
  assert.equal(seasonHarmony(unknown, coldDay), 0.5);
});

test("community season votes steer the pick on equal base/thermal", () => {
  // Both fragrances are thermally neutral; only their voted seasons differ.
  const candidates: OutlookCandidate[] = [
    { id: "winter", warmth: 0.5, freshness: 0.5, projection: 0.5, seasonAffinity: WINTER },
    { id: "summer", warmth: 0.5, freshness: 0.5, projection: 0.5, seasonAffinity: SUMMER },
  ];
  const baseScores = [80, 80];
  const plan = planWeeklyOutlook(candidates, [
    { climate: { temperature_f: 30, humidity: 40 }, baseScores },
    { climate: { temperature_f: 90, humidity: 60 }, baseScores },
  ]);
  assert.equal(candidates[plan[0].candidateIndex].id, "winter", "freezing day → winter-voted scent");
  assert.equal(candidates[plan[1].candidateIndex].id, "summer", "hot day → summer-voted scent");
});

test("crowd-consensus quality breaks ties toward the beloved bottle", () => {
  const candidates: OutlookCandidate[] = [
    { id: "ok", warmth: 0.5, freshness: 0.5, projection: 0.5, quality: 0.3 },
    { id: "loved", warmth: 0.5, freshness: 0.5, projection: 0.5, quality: 0.95 },
  ];
  const plan = planWeeklyOutlook(candidates, [
    { climate: { temperature_f: 68, humidity: 50 }, baseScores: [80, 80] },
  ]);
  assert.equal(candidates[plan[0].candidateIndex].id, "loved", "quality wins an otherwise-equal day");
});

test("quality does NOT override clear weather fit", () => {
  // A beloved summer scent should still lose a freezing day to a fitting winter one.
  const candidates: OutlookCandidate[] = [
    { id: "winter-good", warmth: 0.9, freshness: 0.1, projection: 0.5, seasonAffinity: WINTER, quality: 0.5 },
    { id: "summer-loved", warmth: 0.1, freshness: 0.9, projection: 0.5, seasonAffinity: SUMMER, quality: 0.99 },
  ];
  const plan = planWeeklyOutlook(candidates, [
    { climate: { temperature_f: 28, humidity: 40 }, baseScores: [80, 80] },
  ]);
  assert.equal(candidates[plan[0].candidateIndex].id, "winter-good", "weather beats popularity");
});

test("empty vault yields empty assignments, never throws", () => {
  const days: OutlookDayInput[] = [
    { climate: { temperature_f: 70, humidity: 50 }, baseScores: [] },
  ];
  const plan = planWeeklyOutlook([], days);
  assert.equal(plan[0].candidateIndex, -1);
});
