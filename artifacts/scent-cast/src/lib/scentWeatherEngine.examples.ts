import {
  calculateScentWeatherRecommendation,
  type ScentWeatherEngineInput,
  type ScentWeatherRecommendation,
} from "./scentWeatherEngine";

type ExampleFragrance = NonNullable<ScentWeatherEngineInput["fragrance"]>;

type ScenarioCheck = {
  label: string;
  pass: boolean;
  detail: string;
};

type ValidationScenario = {
  name: string;
  input: ScentWeatherEngineInput;
  recommendation: ScentWeatherRecommendation;
  checks: ScenarioCheck[];
};

const freshFragrance: ExampleFragrance = {
  name: "Fresh Test",
  concentration: "EDT",
  scent_families: ["fresh", "citrus", "aquatic"],
  accords: ["bergamot", "marine", "clean musk"],
  sillage: "moderate",
};

const heavyFragrance: ExampleFragrance = {
  name: "Heavy Test",
  concentration: "EDP",
  scent_families: ["gourmand", "oud", "amber"],
  accords: ["vanilla", "tonka", "incense", "leather"],
  sillage: "strong",
};

const rainyDenseFragrance: ExampleFragrance = {
  name: "Rain Dense Test",
  concentration: "parfum",
  scent_families: ["smoky", "leather", "oud"],
  accords: ["smoke", "leather", "oud", "resin"],
  sillage: "heavy",
};

const warmDateFragrance: ExampleFragrance = {
  name: "Warm Date Test",
  concentration: "EDP",
  scent_families: ["woody", "amber", "spicy", "musky"],
  accords: ["cedar", "amber", "cardamom", "musk"],
  sillage: "moderate",
};

const hasEvery = <T extends string>(actual: readonly T[], expected: readonly T[]): boolean =>
  expected.every((value) => actual.includes(value));

const hasNone = <T extends string>(actual: readonly T[], blocked: readonly T[]): boolean =>
  blocked.every((value) => !actual.includes(value));

const includesRiskAtLeastHigh = (
  risk: ScentWeatherRecommendation["projection_risk"],
): boolean => risk === "high" || risk === "overpowering_risk";

const check = (label: string, pass: boolean, detail: string): ScenarioCheck => ({
  label,
  pass,
  detail,
});

const makeScenario = (
  name: string,
  input: ScentWeatherEngineInput,
  getChecks: (recommendation: ScentWeatherRecommendation) => ScenarioCheck[],
): ValidationScenario => {
  const recommendation = calculateScentWeatherRecommendation(input);

  return {
    name,
    input,
    recommendation,
    checks: getChecks(recommendation),
  };
};

export const scentWeatherEngineV1Examples: ValidationScenario[] = [
  makeScenario(
    "Hot + humid + work",
    {
      weather: {
        temperature_f: 92,
        humidity_percent: 70,
        wind_speed_mph: 5,
        is_raining: false,
      },
      setting: { type: "work" },
      fragrance: heavyFragrance,
    },
    (recommendation) => [
      check(
        "boosts hot-humid safe families",
        hasEvery(recommendation.best_scent_families, [
          "fresh",
          "citrus",
          "aquatic",
          "green",
          "musky",
        ]),
        recommendation.best_scent_families.join(", "),
      ),
      check(
        "avoids heavy workday families",
        hasEvery(recommendation.avoid_scent_families, [
          "gourmand",
          "oud",
          "smoky",
          "leather",
          "tobacco",
        ]),
        recommendation.avoid_scent_families.join(", "),
      ),
      check(
        "caps sprays at two or fewer",
        recommendation.spray_count.max <= 2,
        `${recommendation.spray_count.min}-${recommendation.spray_count.max}`,
      ),
      check(
        "flags high projection risk for heavy scent in heat",
        includesRiskAtLeastHigh(recommendation.projection_risk),
        recommendation.projection_risk,
      ),
      check(
        "triggers hot humid and work rules",
        hasEvery(recommendation.debug?.rules_triggered ?? [], ["hot_humid_rule", "work_rule"]),
        recommendation.debug?.rules_triggered.join(", ") ?? "",
      ),
    ],
  ),
  makeScenario(
    "Cool night/date",
    {
      weather: {
        temperature_f: 45,
        humidity_percent: 45,
        wind_speed_mph: 4,
        is_raining: false,
      },
      setting: { type: "date" },
      fragrance: warmDateFragrance,
    },
    (recommendation) => [
      check(
        "boosts cool night/date families",
        hasEvery(recommendation.best_scent_families, ["woody", "amber", "spicy", "musky"]),
        recommendation.best_scent_families.join(", "),
      ),
      check(
        "triggers cold weather and night/date rules",
        hasEvery(recommendation.debug?.rules_triggered ?? [], [
          "cold_weather_rule",
          "night_date_rule",
        ]),
        recommendation.debug?.rules_triggered.join(", ") ?? "",
      ),
      check(
        "keeps the wear window valid for a date context",
        ["best_now", "better_later", "nighttime_better"].includes(recommendation.wear_window),
        recommendation.wear_window,
      ),
    ],
  ),
  makeScenario(
    "Rainy + mild + mixed",
    {
      weather: {
        temperature_f: 64,
        humidity_percent: 68,
        wind_speed_mph: 7,
        is_raining: true,
        condition: "rain",
      },
      setting: { type: "mixed" },
      fragrance: rainyDenseFragrance,
    },
    (recommendation) => [
      check(
        "boosts rain-safe families",
        hasEvery(recommendation.best_scent_families, ["green", "aquatic", "musky", "fresh"]),
        recommendation.best_scent_families.join(", "),
      ),
      check(
        "avoids dense smoky, leather, and oud profiles",
        hasEvery(recommendation.avoid_scent_families, ["smoky", "leather", "oud"]),
        recommendation.avoid_scent_families.join(", "),
      ),
      check(
        "triggers rain rule",
        hasEvery(recommendation.debug?.rules_triggered ?? [], ["rain_rule"]),
        recommendation.debug?.rules_triggered.join(", ") ?? "",
      ),
    ],
  ),
  makeScenario(
    "Gym + hot",
    {
      weather: {
        temperature_f: 90,
        humidity_percent: 45,
        wind_speed_mph: 5,
        is_raining: false,
      },
      setting: { type: "gym" },
      fragrance: heavyFragrance,
    },
    (recommendation) => [
      check(
        "caps gym sprays at one or fewer",
        recommendation.spray_count.max <= 1,
        `${recommendation.spray_count.min}-${recommendation.spray_count.max}`,
      ),
      check(
        "only recommends clean hot-gym families",
        hasNone(recommendation.best_scent_families, [
          "gourmand",
          "oud",
          "smoky",
          "leather",
          "tobacco",
          "amber",
        ]),
        recommendation.best_scent_families.join(", "),
      ),
      check(
        "avoids heavy, sweet, and warm gym families",
        hasEvery(recommendation.avoid_scent_families, [
          "sweet",
          "gourmand",
          "oud",
          "smoky",
          "leather",
          "tobacco",
          "amber",
        ]),
        recommendation.avoid_scent_families.join(", "),
      ),
      check(
        "triggers gym rule",
        hasEvery(recommendation.debug?.rules_triggered ?? [], ["gym_rule"]),
        recommendation.debug?.rules_triggered.join(", ") ?? "",
      ),
    ],
  ),
  makeScenario(
    "Windy + outdoor",
    {
      weather: {
        temperature_f: 68,
        humidity_percent: 45,
        wind_speed_mph: 16,
        is_raining: false,
      },
      setting: { type: "outdoor" },
      fragrance: freshFragrance,
    },
    (recommendation) => [
      check(
        "triggers wind rule",
        hasEvery(recommendation.debug?.rules_triggered ?? [], ["wind_rule"]),
        recommendation.debug?.rules_triggered.join(", ") ?? "",
      ),
      check(
        "reduces outdoor wind confidence",
        recommendation.confidence !== "high",
        recommendation.confidence,
      ),
      check(
        "permits the outdoor wind spray increase",
        recommendation.spray_count.recommended >= 4,
        `${recommendation.spray_count.recommended} recommended`,
      ),
      check(
        "records wind uncertainty in atmosphere scoring",
        recommendation.debug?.atmosphere_scores.projection_boost_score === 70,
        String(recommendation.debug?.atmosphere_scores.projection_boost_score),
      ),
    ],
  ),
];

export const scentWeatherV1Examples = scentWeatherEngineV1Examples;

export type ScentWeatherV1ValidationResult = {
  scenario: string;
  passed: boolean;
  recommendation: ScentWeatherRecommendation;
  failures: string[];
};

export function validateScentWeatherV1Examples(): ScentWeatherV1ValidationResult[] {
  return scentWeatherV1Examples.map((scenario) => {
    const failures = scenario.checks
      .filter((scenarioCheck) => !scenarioCheck.pass)
      .map((scenarioCheck) => `${scenarioCheck.label}: ${scenarioCheck.detail}`);

    return {
      scenario: scenario.name,
      passed: failures.length === 0,
      recommendation: scenario.recommendation,
      failures,
    };
  });
}

export const scentWeatherEngineV1ExamplesPassed = validateScentWeatherV1Examples().every(
  (scenario) => scenario.passed,
);
