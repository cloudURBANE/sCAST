// Pure, dependency-free planner for the weekly Scent Forecast.
//
// Why this exists
// ---------------
// The forecast used to pick each day's bottle by scoring the vault and taking
// the single top result. Two flaws made every day identical:
//   1. The scent-weather engine only changes its best/avoid families at extreme
//      thresholds (hot+humid, cold, rain). Across an ordinary week (~55-84°F, no
//      rain) NO rule fires, so every day produced the same family set.
//   2. The candidate score was discrete, so ties broke on wardrobe array index —
//      returning the same lowest-index bottle for all seven days.
//
// This module adds the two missing pieces, kept pure so they unit-test under
// `node --test` like the rest of `src/lib/*`:
//   - `thermalHarmony` — a CONTINUOUS fit between a fragrance's warm/heavy vs
//     fresh character and the day's temperature/humidity, so the ranking shifts
//     smoothly day to day instead of only at thresholds.
//   - `planWeeklyOutlook` — assigns each forecast day its best-fit bottle while
//     spreading picks across the vault, so a 155-bottle collection shows variety
//     across the week instead of one repeated bottle.
//
// The engine itself (`scentWeatherEngine.ts`) is intentionally NOT changed here —
// it is shared with the API mission agent and unit-tested. The caller runs the
// engine per (fragrance, day) and feeds its alignment in as `baseScores`.

export interface OutlookDayClimate {
  temperature_f: number | null;
  humidity: number | null;
  wind_speed_mph?: number | null;
  is_raining?: boolean;
  condition?: string | null;
}

/**
 * Day-of-year season weights, fixed order [winter, spring, summer, fall]. Used to
 * compare a day's climate against a fragrance's community-voted season suitability.
 */
export type SeasonAffinity = [number, number, number, number];

/**
 * The weather-relevant distillation of one vault fragrance. The core axes are
 * 0..1. The caller derives these from the fragrance's real metric systems —
 * weighted main accords, performance scores, community season votes, crowd
 * consensus (see `WardrobeContext`) — keeping this module free of app data
 * shapes. Metric-backed fields are optional so the planner degrades gracefully
 * to the note-derived axes when a fragrance has not been enriched yet.
 */
export interface OutlookCandidate {
  /** Stable identity used to de-duplicate picks across the week. */
  id: string;
  /** Warm/heavy character: oud, amber, leather, tobacco, gourmand, spice → high. */
  warmth: number;
  /** Fresh/clean character: citrus, aquatic, green, clean musk → high. */
  freshness: number;
  /** Projection strength from real sillage/longevity percentages (or labels). */
  projection: number;
  /**
   * Community-voted season suitability [winter, spring, summer, fall], 0..1 each.
   * Omitted when the fragrance has no `wear_profile.primary_seasons` data, in
   * which case the season term is treated as neutral (rank-safe).
   */
  seasonAffinity?: SeasonAffinity;
  /** Crowd-consensus quality (0..1) — surfaces genuinely beloved fragrances. */
  quality?: number;
  /** 0..1 share of structured metric systems present — drives confidence. */
  confidence?: number;
}

export interface OutlookDayInput {
  climate: OutlookDayClimate;
  /**
   * Engine alignment for THIS day, one entry per candidate in the same order as
   * the `candidates` array passed to `planWeeklyOutlook`. This carries the
   * family best/avoid fit the engine already computes.
   */
  baseScores: number[];
}

export interface OutlookAssignment {
  dayIndex: number;
  /** Index into the `candidates` array, or -1 when there are no candidates. */
  candidateIndex: number;
  score: number;
}

export interface PlanWeeklyOutlookOptions {
  /**
   * Points subtracted per prior use of a candidate, so the planner spreads picks
   * across the vault. Soft by design: a strongly-fitting bottle can still recur
   * once cheaper alternatives are exhausted (tiny vaults still fill all 7 days).
   */
  repeatPenalty?: number;
  /** How much the continuous thermal-harmony term can swing a day's score. */
  weatherFitWeight?: number;
  /** How much community season suitability can swing a day's score. */
  seasonFitWeight?: number;
  /** How much crowd-consensus quality can boost a candidate. */
  qualityWeight?: number;
  /** How much metric completeness (confidence) can nudge a candidate. */
  confidenceWeight?: number;
}

interface ScoreWeights {
  weatherFitWeight: number;
  seasonFitWeight: number;
  qualityWeight: number;
  confidenceWeight: number;
}

const DEFAULT_REPEAT_PENALTY = 18;
const DEFAULT_WEATHER_FIT_WEIGHT = 30;
// Community season votes are a direct, data-backed signal, weighted alongside
// the note-derived thermal term so the two reinforce each other.
const DEFAULT_SEASON_FIT_WEIGHT = 24;
// Crowd-consensus quality is a moderate bonus: it picks the BEST-smelling option
// among weather-appropriate bottles without letting a beloved summer scent win a
// freezing day (the season + thermal swing is far larger).
const DEFAULT_QUALITY_WEIGHT = 14;
// A gentle nudge toward well-documented bottles, so the forecast leans on
// fragrances it understands — confidence over guessing — without burying a good
// pick that simply has not been enriched yet.
const DEFAULT_CONFIDENCE_WEIGHT = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The ideal "warmth" of a fragrance for a given day, on a 0..1 scale.
 *
 * Cold, dry, still air carries and flatters warm/heavy scents (oud, amber,
 * leather) — so cold days want HIGH warmth. Hot, humid air amplifies and bloats
 * those same scents while rewarding fresh/clean ones — so hot days want LOW
 * warmth. This is continuous, which is the whole point: a 58°F day and a 78°F
 * day produce a different ideal and therefore reorder the vault, where the
 * engine's threshold rules alone would have treated both days the same.
 */
export function idealWarmth(climate: OutlookDayClimate): number {
  const temperature = clamp(finiteOr(climate.temperature_f, 70), 30, 95);
  const humidity = clamp(finiteOr(climate.humidity, 50), 0, 100);

  // 1.0 at 30°F → 0.0 at 95°F. Temperature is the dominant driver.
  let ideal = (95 - temperature) / 65;
  // Humidity nudges toward fresh (lower warmth): muggy air makes heavy scents
  // cloying. Scaled modestly so it refines rather than overrides temperature.
  ideal -= ((humidity - 50) / 100) * 0.25;
  // Rain favors clean/green over dense smoky-warm profiles.
  if (climate.is_raining) ideal -= 0.08;

  return clamp(ideal, 0, 1);
}

/**
 * Continuous 0..1 fit between a candidate and the day's climate. Combines how
 * well the fragrance's warmth matches the day's ideal warmth with how well its
 * freshness matches the day's freshness demand (the inverse of ideal warmth).
 */
export function thermalHarmony(candidate: OutlookCandidate, climate: OutlookDayClimate): number {
  const ideal = idealWarmth(climate);
  const warmthFit = 1 - Math.abs(clamp(candidate.warmth, 0, 1) - ideal);
  const freshnessDemand = 1 - ideal;
  const freshnessFit = 1 - Math.abs(clamp(candidate.freshness, 0, 1) - freshnessDemand);

  // Warmth is the primary axis; freshness reinforces it.
  let harmony = warmthFit * 0.6 + freshnessFit * 0.4;

  // Loud projection is a liability in hot/humid air and an asset in cold wind.
  const temperature = finiteOr(climate.temperature_f, 70);
  const humidity = finiteOr(climate.humidity, 50);
  const wind = finiteOr(climate.wind_speed_mph, 0);
  const projection = clamp(candidate.projection, 0, 1);
  if (temperature >= 82 && humidity >= 60) harmony -= projection * 0.12;
  else if (temperature < 50 && wind >= 10) harmony += projection * 0.08;

  return clamp(harmony, 0, 1);
}

/**
 * Translate a day's temperature into community-season weights
 * [winter, spring, summer, fall], so a fragrance's voted seasons can be matched
 * against the actual conditions. Adjacent seasons overlap deliberately — a 50°F
 * day flatters both late-fall and winter scents — so the signal stays smooth.
 */
export function seasonWeightsForClimate(climate: OutlookDayClimate): SeasonAffinity {
  const temperature = finiteOr(climate.temperature_f, 70);
  // [winter, spring, summer, fall]
  if (temperature < 40) return [1.0, 0.15, 0.0, 0.5];
  if (temperature < 52) return [0.8, 0.4, 0.05, 0.8];
  if (temperature < 64) return [0.35, 0.85, 0.25, 0.7];
  if (temperature < 74) return [0.1, 0.85, 0.6, 0.45];
  if (temperature < 84) return [0.0, 0.5, 0.9, 0.2];
  return [0.0, 0.2, 1.0, 0.05];
}

/**
 * 0..1 overlap between a fragrance's community-voted season suitability and the
 * day's season weights. Neutral (0.5) when the fragrance has no season votes, so
 * an un-enriched bottle is treated as a question mark rather than wrong.
 */
export function seasonHarmony(candidate: OutlookCandidate, climate: OutlookDayClimate): number {
  const affinity = candidate.seasonAffinity;
  if (!affinity) return 0.5;
  const dayWeights = seasonWeightsForClimate(climate);

  let dot = 0;
  let dayNorm = 0;
  let fragNorm = 0;
  for (let i = 0; i < 4; i += 1) {
    const day = dayWeights[i];
    const frag = clamp(affinity[i], 0, 1);
    dot += day * frag;
    dayNorm += day * day;
    fragNorm += frag * frag;
  }
  if (dayNorm === 0 || fragNorm === 0) return 0.5;
  // Cosine similarity keeps the term scale-free w.r.t. how many seasons a
  // fragrance was voted into.
  return clamp(dot / Math.sqrt(dayNorm * fragNorm), 0, 1);
}

/**
 * Final per-(day, candidate) score: the engine's family alignment plus the
 * data-backed weather terms — continuous thermal harmony, community season
 * suitability, crowd-consensus quality, and a confidence nudge. Exposed for
 * reuse by callers that score a single fragrance for a single day (e.g. the home
 * recommendation).
 */
export function dayCandidateScore(
  baseScore: number,
  candidate: OutlookCandidate,
  climate: OutlookDayClimate,
  weights: Partial<ScoreWeights> = {},
): number {
  const w: ScoreWeights = {
    weatherFitWeight: weights.weatherFitWeight ?? DEFAULT_WEATHER_FIT_WEIGHT,
    seasonFitWeight: weights.seasonFitWeight ?? DEFAULT_SEASON_FIT_WEIGHT,
    qualityWeight: weights.qualityWeight ?? DEFAULT_QUALITY_WEIGHT,
    confidenceWeight: weights.confidenceWeight ?? DEFAULT_CONFIDENCE_WEIGHT,
  };

  let score = baseScore;
  score += thermalHarmony(candidate, climate) * w.weatherFitWeight;
  score += seasonHarmony(candidate, climate) * w.seasonFitWeight;
  if (typeof candidate.quality === "number" && Number.isFinite(candidate.quality)) {
    score += clamp(candidate.quality, 0, 1) * w.qualityWeight;
  }
  if (typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence)) {
    score += clamp(candidate.confidence, 0, 1) * w.confidenceWeight;
  }
  return score;
}

/**
 * Assign one fragrance to each forecast day.
 *
 * Greedy, chronological, and deterministic: for each day we pick the candidate
 * with the highest day score minus a penalty for how many times it has already
 * been used earlier in the week. The penalty is what turns "same bottle every
 * day" into a varied week that still respects the weather — every pick is the
 * best-fitting bottle that hasn't already been spent, and ties break on the
 * stable candidate index so the output is reproducible.
 */
export function planWeeklyOutlook(
  candidates: OutlookCandidate[],
  days: OutlookDayInput[],
  options: PlanWeeklyOutlookOptions = {},
): OutlookAssignment[] {
  const repeatPenalty = options.repeatPenalty ?? DEFAULT_REPEAT_PENALTY;
  const weights: ScoreWeights = {
    weatherFitWeight: options.weatherFitWeight ?? DEFAULT_WEATHER_FIT_WEIGHT,
    seasonFitWeight: options.seasonFitWeight ?? DEFAULT_SEASON_FIT_WEIGHT,
    qualityWeight: options.qualityWeight ?? DEFAULT_QUALITY_WEIGHT,
    confidenceWeight: options.confidenceWeight ?? DEFAULT_CONFIDENCE_WEIGHT,
  };
  const usageCount = new Array(candidates.length).fill(0);

  return days.map((day, dayIndex): OutlookAssignment => {
    if (candidates.length === 0) {
      return { dayIndex, candidateIndex: -1, score: 0 };
    }

    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i += 1) {
      const base = day.baseScores[i] ?? 0;
      const score =
        dayCandidateScore(base, candidates[i], day.climate, weights) -
        usageCount[i] * repeatPenalty;
      // Strict `>` keeps the lowest stable index on ties for reproducibility.
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    usageCount[bestIndex] += 1;
    // Report the score WITHOUT the variety penalty so the surfaced number
    // reflects the pick's actual weather fit, not its position in the week.
    const reportedScore = dayCandidateScore(
      day.baseScores[bestIndex] ?? 0,
      candidates[bestIndex],
      day.climate,
      weights,
    );
    return { dayIndex, candidateIndex: bestIndex, score: reportedScore };
  });
}
