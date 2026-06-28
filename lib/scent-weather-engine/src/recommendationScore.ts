import {
  traitsMatchScentFamily,
  type ScentWeatherRecommendation,
} from "./scentWeatherEngine.ts";

/**
 * Single source of truth for turning an engine recommendation into a comparable
 * 0..100 display score, and for the family-alignment score every consumer ranks
 * the vault with.
 *
 * Before this module the same numbers lived in three places with drifting
 * weights: the mission ranker (`scentMission.ts`), the home hero, and the
 * forecast planner (both in `WardrobeContext.tsx`). The chat agent could
 * therefore recommend a different bottle than the forecast for identical
 * weather. Everything routes through here now so they cannot diverge.
 */

const CONFIDENCE_BASE_SCORE: Record<ScentWeatherRecommendation["confidence"], number> = {
  high: 92,
  medium: 78,
  low: 62,
};

const PROJECTION_PENALTY: Record<ScentWeatherRecommendation["projection_risk"], number> = {
  low: 0,
  medium: 4,
  high: 10,
  overpowering_risk: 18,
};

const WEAR_WINDOW_PENALTY: Record<ScentWeatherRecommendation["wear_window"], number> = {
  best_now: 0,
  daytime_safe: 2,
  better_later: 8,
  nighttime_better: 10,
  avoid_today: 28,
};

/** Family-alignment weights, single-sourced so no consumer can drift them. */
export const FAMILY_ALIGNMENT_WEIGHTS = {
  bestHit: 8,
  avoidHit: 14,
  intentBonus: 4,
  energyBonus: 3,
} as const;

/**
 * 0..100 display score for a recommendation: a confidence base, penalized by
 * projection risk and how poorly the wear-window fits "now".
 */
export function recommendationDisplayScore(recommendation: ScentWeatherRecommendation): number {
  return Math.max(
    0,
    Math.min(
      100,
      CONFIDENCE_BASE_SCORE[recommendation.confidence] -
        PROJECTION_PENALTY[recommendation.projection_risk] -
        WEAR_WINDOW_PENALTY[recommendation.wear_window],
    ),
  );
}

export interface FamilyAlignmentInput {
  recommendation: ScentWeatherRecommendation;
  /** Lowercased family/accord/trait texts for the fragrance. */
  traits: readonly string[];
  /** True when the fragrance is tagged for the active destination/intent. */
  intentMatch?: boolean;
  /** True when the fragrance is tagged for the active energy. */
  energyMatch?: boolean;
}

/**
 * The family-alignment base score shared by the home hero, the forecast planner,
 * and the mission ranker: the display score plus the engine's best-family hits,
 * minus avoid-family hits, plus optional intent/energy tag bonuses. This is the
 * `baseScore` the weekly planner's `dayCandidateScore` layers the weather terms
 * on top of.
 */
export function familyAlignmentScore(input: FamilyAlignmentInput): number {
  const { recommendation, traits } = input;
  const bestHits = recommendation.best_scent_families.filter((family) =>
    traitsMatchScentFamily(traits, family),
  ).length;
  const avoidHits = recommendation.avoid_scent_families.filter((family) =>
    traitsMatchScentFamily(traits, family),
  ).length;

  return (
    recommendationDisplayScore(recommendation) +
    bestHits * FAMILY_ALIGNMENT_WEIGHTS.bestHit -
    avoidHits * FAMILY_ALIGNMENT_WEIGHTS.avoidHit +
    (input.intentMatch ? FAMILY_ALIGNMENT_WEIGHTS.intentBonus : 0) +
    (input.energyMatch ? FAMILY_ALIGNMENT_WEIGHTS.energyBonus : 0)
  );
}
