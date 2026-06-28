export type ScentFamily =
  | "fresh"
  | "citrus"
  | "aquatic"
  | "green"
  | "musky"
  | "woody"
  | "amber"
  | "sweet"
  | "gourmand"
  | "oud"
  | "smoky"
  | "leather"
  | "tobacco"
  | "spicy"
  | "powdery";

export type ScentWeatherEngineInput = {
  weather: {
    temperature_f: number;
    humidity_percent: number;
    wind_speed_mph: number;
    is_raining: boolean;
    season?: "spring" | "summer" | "fall" | "winter";
    /** Live UV index (0–11+). Strong sun nudges toward fresh, daytime scents. */
    uv_index?: number | null;
    /** Local part of day, used to refine the wear window against the real clock. */
    time_of_day?: "morning" | "afternoon" | "evening" | "night";
    condition?: string;
    /**
     * Explicit signal that the weather above is real (live API data) rather
     * than caller-supplied neutral defaults. When `false`, confidence is
     * demoted even though the numeric fields are finite — callers that fill
     * missing data with defaults (e.g. 72°F/50%) MUST set this so the engine
     * does not report a confident pick built on fabricated conditions.
     */
    data_complete?: boolean;
  };

  setting: {
    type:
      | "indoor"
      | "outdoor"
      | "mixed"
      | "close_contact"
      | "work"
      | "date"
      | "gym"
      | "night";
    indoor_percent?: number;
    outdoor_percent?: number;
    /**
     * Explicit signal that `type` was resolved from a recognized destination
     * rather than a neutral fallback. When `false`, confidence is demoted.
     */
    recognized?: boolean;
  };

  fragrance?: {
    name?: string;
    brand?: string;
    concentration?: string;
    scent_families?: string[];
    accords?: string[];
    profile_vector?: Record<string, number>;
    longevity?: string | number;
    sillage?: string;
  };

  userPreference?: {
    scentLastsOnMe?: "short" | "normal" | "long";
    projectionPreference?: "subtle" | "noticeable";
  };

  /**
   * Caller-supplied 0–1 measure of how complete/trustworthy the fragrance data
   * is (e.g. source-coverage completeness + structured-metric coverage). When
   * provided it caps `confidence` so a thin or partial profile cannot report
   * high/medium confidence purely because weather + setting are known. Omitted
   * by callers/tests that have no quality signal — behaviour is unchanged then.
   */
  dataConfidence?: number;
};

export type AtmosphereScores = {
  heat_amplification_score: number;
  humidity_weight_score: number;
  freshness_demand_score: number;
  sweetness_risk_score: number;
  projection_boost_score: number;
  scent_fatigue_risk_score: number;
  heaviness_risk_score: number;
};

export type ScentWeatherRecommendation = {
  best_scent_families: ScentFamily[];
  avoid_scent_families: ScentFamily[];
  spray_count: {
    recommended: number;
    min: number;
    max: number;
  };
  projection_risk: "low" | "medium" | "high" | "overpowering_risk";
  wear_window:
    | "best_now"
    | "better_later"
    | "daytime_safe"
    | "nighttime_better"
    | "avoid_today";
  confidence: "high" | "medium" | "low";
  explanation: string;
  debug?: {
    atmosphere_scores: AtmosphereScores;
    rules_triggered: string[];
  };
};

type SettingType = ScentWeatherEngineInput["setting"]["type"];
type ProjectionRisk = ScentWeatherRecommendation["projection_risk"];
type WearWindow = ScentWeatherRecommendation["wear_window"];
type Confidence = ScentWeatherRecommendation["confidence"];

export const SCENT_FAMILIES: readonly ScentFamily[] = [
  "fresh",
  "citrus",
  "aquatic",
  "green",
  "musky",
  "woody",
  "amber",
  "sweet",
  "gourmand",
  "oud",
  "smoky",
  "leather",
  "tobacco",
  "spicy",
  "powdery",
];

const SETTING_TYPES: readonly SettingType[] = [
  "indoor",
  "outdoor",
  "mixed",
  "close_contact",
  "work",
  "date",
  "gym",
  "night",
];

const HEAVY_SIGNALS = [
  "oud",
  "smoke",
  "smoky",
  "leather",
  "tobacco",
  "amber",
  "resin",
  "incense",
  "vanilla",
  "tonka",
  "caramel",
  "honey",
  "boozy",
  "gourmand",
];

const FRESH_SIGNALS = [
  "fresh",
  "citrus",
  "bergamot",
  "lemon",
  "lime",
  "aquatic",
  "marine",
  "green",
  "mint",
  "clean",
  "musk",
  "musky",
];

const SWEET_SIGNALS = [
  "sweet",
  "sweetness",
  "gourmand",
  "vanilla",
  "tonka",
  "caramel",
  "honey",
];

const HEAVY_AMBER_MODIFIER_SIGNALS = [
  "oud",
  "smoke",
  "smoky",
  "leather",
  "tobacco",
  "resin",
  "incense",
  "vanilla",
  "tonka",
  "caramel",
  "honey",
  "boozy",
  "gourmand",
  "dense",
  "heavy",
  "sweet",
];

const FAMILY_SIGNALS: Record<ScentFamily, readonly string[]> = {
  fresh: ["fresh", "freshness", "clean", "laundry", "soap", "mint"],
  citrus: ["citrus", "bergamot", "lemon", "lime", "orange", "grapefruit", "mandarin"],
  aquatic: ["aquatic", "marine", "ocean", "sea", "water", "watery"],
  green: ["green", "grass", "leaf", "leafy", "herbal", "vetiver", "galbanum"],
  musky: ["musk", "musky", "clean"],
  woody: ["wood", "woody", "cedar", "sandalwood", "oak", "vetiver", "patchouli"],
  amber: ["amber", "resin", "resinous", "labdanum", "warmth"],
  sweet: ["sweet", "sweetness", "vanilla", "tonka", "caramel", "honey"],
  gourmand: ["gourmand", "edible", "dessert", "chocolate", "coffee", "praline", "caramel"],
  oud: ["oud", "agarwood"],
  smoky: ["smoke", "smoky", "smokiness", "incense", "charcoal"],
  leather: ["leather", "leathery", "suede"],
  tobacco: ["tobacco", "cigar"],
  spicy: ["spicy", "spice", "pepper", "cardamom", "cinnamon", "clove", "saffron"],
  powdery: ["powder", "powdery", "iris", "orris", "violet", "makeup"],
};

const RAIN_CONDITION_SIGNALS = ["rain", "drizzle", "storm"];
const RESTRICTIVE_SETTINGS: readonly SettingType[] = ["indoor", "work", "close_contact", "gym"];
const INDOOR_RULE_SETTINGS: readonly SettingType[] = ["indoor", "work", "close_contact"];

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasAnyTextSignal(texts: readonly string[], signals: readonly string[]): boolean {
  return texts.some((text) => signals.some((signal) => text.includes(signal)));
}

function getTraitTexts(fragrance: ScentWeatherEngineInput["fragrance"]): string[] {
  if (!fragrance) return [];

  const values: string[] = [];
  for (const family of fragrance.scent_families ?? []) values.push(family);
  for (const accord of fragrance.accords ?? []) values.push(accord);

  if (fragrance.profile_vector) {
    for (const [key, value] of Object.entries(fragrance.profile_vector)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        values.push(key);
      }
    }
  }

  return values.map(normalizeText).filter(Boolean);
}

function hasFamilySignal(traits: readonly string[], family: ScentFamily): boolean {
  return hasAnyTextSignal(traits, FAMILY_SIGNALS[family]);
}

/**
 * Public form of the internal family-signal check, used by mission scoring to
 * count best/avoid family hits against a fragrance's trait texts.
 */
export function traitsMatchScentFamily(traits: readonly string[], family: ScentFamily): boolean {
  return hasFamilySignal(traits.map(normalizeText).filter(Boolean), family);
}

function hasAnyFamilySignal(traits: readonly string[], families: readonly ScentFamily[]): boolean {
  return families.some((family) => hasFamilySignal(traits, family));
}

function isStrongSillage(fragrance: ScentWeatherEngineInput["fragrance"]): boolean {
  const sillage = normalizeText(fragrance?.sillage);
  return ["strong", "heavy", "enormous", "beast", "loud"].some((signal) => sillage.includes(signal));
}

function isWeakSillage(fragrance: ScentWeatherEngineInput["fragrance"]): boolean {
  const sillage = normalizeText(fragrance?.sillage);
  return ["weak", "soft", "light", "subtle", "skin"].some((signal) => sillage.includes(signal));
}

function isRaining(input: ScentWeatherEngineInput): boolean {
  const condition = normalizeText(input.weather.condition);
  return input.weather.is_raining === true || RAIN_CONDITION_SIGNALS.some((signal) => condition.includes(signal));
}

function hasCompleteWeather(input: ScentWeatherEngineInput): boolean {
  // A caller that fills missing fields with neutral defaults must flag the gap
  // via data_complete:false — otherwise the finite-number checks below always
  // pass and confidence is computed as if the weather were real.
  if (input.weather.data_complete === false) return false;
  return (
    typeof input.weather.temperature_f === "number" &&
    Number.isFinite(input.weather.temperature_f) &&
    typeof input.weather.humidity_percent === "number" &&
    Number.isFinite(input.weather.humidity_percent) &&
    typeof input.weather.wind_speed_mph === "number" &&
    Number.isFinite(input.weather.wind_speed_mph) &&
    typeof input.weather.is_raining === "boolean"
  );
}

function isKnownSetting(input: ScentWeatherEngineInput): boolean {
  // recognized:false means `type` is a neutral fallback for an unrecognized
  // destination, not a real occasion — don't credit it toward confidence.
  if (input.setting.recognized === false) return false;
  return SETTING_TYPES.includes(input.setting.type);
}

function getBaseSprayCount(concentration: string | undefined): number {
  const value = normalizeText(concentration);
  if (!value) return 2;
  if (value.includes("edc") || value.includes("eau de cologne") || value === "cologne") return 4;
  if (value.includes("edt") || value.includes("eau de toilette")) return 3;
  if (value.includes("edp") || value.includes("eau de parfum")) return 2;
  if (value.includes("parfum") || value.includes("extrait")) return 1;
  return 2;
}

function reduceConfidence(confidence: Confidence): Confidence {
  if (confidence === "high") return "medium";
  if (confidence === "medium") return "low";
  return "low";
}

export function calculateAtmosphereScores(
  input: ScentWeatherEngineInput,
  traitTexts?: readonly string[],
): AtmosphereScores {
  const temperature = finiteNumber(input.weather.temperature_f, 70);
  const humidity = finiteNumber(input.weather.humidity_percent, 50);
  const windSpeed = finiteNumber(input.weather.wind_speed_mph, 0);
  const settingType = input.setting.type;
  // Trait texts are computed once per recommendation and threaded in; fall back
  // to deriving them when called standalone (public API / tests).
  const traits = traitTexts ?? getTraitTexts(input.fragrance);
  const rainy = isRaining(input);

  let heatAmplificationScore = 15;
  if (temperature >= 95) heatAmplificationScore = 95;
  else if (temperature >= 85) heatAmplificationScore = 82;
  else if (temperature >= 75) heatAmplificationScore = 65;
  else if (temperature >= 60) heatAmplificationScore = 45;
  else if (temperature >= 45) heatAmplificationScore = 30;

  let humidityWeightScore = 20;
  if (humidity >= 75) humidityWeightScore = 90;
  else if (humidity >= 65) humidityWeightScore = 75;
  else if (humidity >= 50) humidityWeightScore = 55;
  else if (humidity >= 35) humidityWeightScore = 35;

  const freshnessDemandScore = clampScore(
    Math.max(
      heatAmplificationScore * 0.8,
      humidityWeightScore * 0.7,
      rainy ? 70 : 0,
      settingType === "gym" ? 95 : 0,
      settingType === "work" ? 65 : 0,
      settingType === "close_contact" ? 70 : 0,
    ),
  );

  let sweetnessRiskScore = 25;
  if (temperature >= 80) sweetnessRiskScore += 20;
  if (temperature >= 90) sweetnessRiskScore += 15;
  if (humidity >= 60) sweetnessRiskScore += 20;
  if (humidity >= 75) sweetnessRiskScore += 10;
  if (["work", "close_contact", "gym"].includes(settingType)) sweetnessRiskScore += 15;
  if (hasAnyTextSignal(traits, SWEET_SIGNALS)) sweetnessRiskScore += 15;
  if (temperature >= 85 && humidity >= 65) {
    sweetnessRiskScore = Math.max(sweetnessRiskScore, 85);
  }

  let projectionBoostScore = 40;
  if (temperature < 55) projectionBoostScore += 15;
  if (windSpeed >= 12) projectionBoostScore += 15;
  if (settingType === "outdoor") projectionBoostScore += 15;
  if (settingType === "mixed") projectionBoostScore += 5;
  if (["indoor", "work", "close_contact", "gym"].includes(settingType)) projectionBoostScore -= 20;
  if (humidity >= 75) projectionBoostScore -= 10;

  let scentFatigueRiskScore = 25;
  if (temperature >= 85) scentFatigueRiskScore += 20;
  if (humidity >= 65) scentFatigueRiskScore += 20;
  if (["indoor", "work", "close_contact"].includes(settingType)) scentFatigueRiskScore += 20;
  if (settingType === "gym") scentFatigueRiskScore += 30;
  if (isStrongSillage(input.fragrance)) scentFatigueRiskScore += 20;
  if (hasAnyFamilySignal(traits, ["oud", "smoky", "leather", "tobacco", "gourmand"])) {
    scentFatigueRiskScore += 15;
  }

  let heavinessRiskScore = 20;
  if (hasAnyFamilySignal(traits, ["oud", "smoky", "leather", "tobacco", "amber", "gourmand"])) {
    heavinessRiskScore += 25;
  }
  if (temperature >= 80) heavinessRiskScore += 15;
  if (humidity >= 65) heavinessRiskScore += 20;
  if (rainy && hasAnyFamilySignal(traits, ["smoky", "leather", "oud"])) {
    heavinessRiskScore += 15;
  }
  if (temperature < 55) heavinessRiskScore -= 15;
  if (temperature >= 85 && humidity >= 65) {
    heavinessRiskScore = Math.max(heavinessRiskScore, 75);
  }

  return {
    heat_amplification_score: clampScore(heatAmplificationScore),
    humidity_weight_score: clampScore(humidityWeightScore),
    freshness_demand_score: freshnessDemandScore,
    sweetness_risk_score: clampScore(sweetnessRiskScore),
    projection_boost_score: clampScore(projectionBoostScore),
    scent_fatigue_risk_score: clampScore(scentFatigueRiskScore),
    heaviness_risk_score: clampScore(heavinessRiskScore),
  };
}

export function calculateScentWeatherRecommendation(
  input: ScentWeatherEngineInput,
): ScentWeatherRecommendation {
  // Compute trait texts ONCE per recommendation and thread them through every
  // sub-function (atmosphere, projection, wear-window, confidence). Previously
  // each derived them independently — ~5 redundant passes per call, multiplied
  // across the vault×week matrix the planner builds. Behaviour is identical.
  const traits = getTraitTexts(input.fragrance);
  const scores = calculateAtmosphereScores(input, traits);
  const temperature = finiteNumber(input.weather.temperature_f, 70);
  const humidity = finiteNumber(input.weather.humidity_percent, 50);
  const windSpeed = finiteNumber(input.weather.wind_speed_mph, 0);
  const settingType = input.setting.type;
  const rainy = isRaining(input);
  const hotHumid = temperature >= 85 && humidity >= 65;
  const hotDry = temperature >= 85 && humidity < 50;
  const coldWeather = temperature < 55;
  const veryCold = temperature < 40;
  const windy = windSpeed >= 12;
  const indoorSetting = INDOOR_RULE_SETTINGS.includes(settingType);
  const nightDate = settingType === "night" || settingType === "date";
  const gym = settingType === "gym";
  const outdoorOrMixed = settingType === "outdoor" || settingType === "mixed";
  const strongSillage = isStrongSillage(input.fragrance);
  const weakSillage = isWeakSillage(input.fragrance);
  const hasSweetProfile = hasAnyTextSignal(traits, SWEET_SIGNALS);
  const hasFreshProfile = hasAnyTextSignal(traits, FRESH_SIGNALS);
  const hasHeavyProfile = hasAnyTextSignal(traits, HEAVY_SIGNALS);
  const hasHeavyAmber =
    hasFamilySignal(traits, "amber") && hasAnyTextSignal(traits, HEAVY_AMBER_MODIFIER_SIGNALS);
  const denseOud = hasFamilySignal(traits, "oud") && (hasHeavyProfile || strongSillage);
  const heavyLeather = hasFamilySignal(traits, "leather") && (hasHeavyProfile || strongSillage);
  const smokyLeatherInRain =
    rainy && (hasFamilySignal(traits, "smoky") || heavyLeather || denseOud);
  const denseOrHeavyProfile = hasHeavyProfile || strongSillage || denseOud || heavyLeather;
  const cleanLightProfile = hasFreshProfile && !hasSweetProfile && !hasHeavyProfile;

  const familyScores: Record<ScentFamily, number> = {
    fresh: 0,
    citrus: 0,
    aquatic: 0,
    green: 0,
    musky: 0,
    woody: 0,
    amber: 0,
    sweet: 0,
    gourmand: 0,
    oud: 0,
    smoky: 0,
    leather: 0,
    tobacco: 0,
    spicy: 0,
    powdery: 0,
  };

  const avoidFamilies = new Set<ScentFamily>();
  const avoidRiskScores: Record<ScentFamily, number> = {
    fresh: 0,
    citrus: 0,
    aquatic: 0,
    green: 0,
    musky: 0,
    woody: 0,
    amber: 0,
    sweet: 0,
    gourmand: 0,
    oud: 0,
    smoky: 0,
    leather: 0,
    tobacco: 0,
    spicy: 0,
    powdery: 0,
  };
  const rulesTriggered: string[] = [];

  const boostFamilies = (families: readonly ScentFamily[], points: number) => {
    for (const family of families) familyScores[family] += points;
  };

  const deprioritizeFamilies = (families: readonly ScentFamily[], points: number) => {
    for (const family of families) familyScores[family] -= points;
  };

  const avoidFamily = (family: ScentFamily, risk: number) => {
    avoidFamilies.add(family);
    avoidRiskScores[family] = Math.max(avoidRiskScores[family], risk);
    familyScores[family] -= risk;
  };

  for (const family of SCENT_FAMILIES) {
    if (hasFamilySignal(traits, family)) familyScores[family] += 8;
  }

  if (hotHumid) {
    rulesTriggered.push("hot_humid_rule");
    boostFamilies(["fresh", "citrus", "aquatic", "green", "musky"], 35);
    for (const family of ["gourmand", "oud", "smoky", "leather", "tobacco"] as const) {
      avoidFamily(family, 45);
    }
    if (hasHeavyAmber) avoidFamily("amber", 35);
  }

  if (hotDry) {
    rulesTriggered.push("hot_dry_rule");
    boostFamilies(["fresh", "citrus", "green", "aquatic"], 28);
    avoidFamily("gourmand", 25);
    if (denseOud) avoidFamily("oud", 25);
    if (heavyLeather) avoidFamily("leather", 20);
  }

  if (coldWeather) {
    rulesTriggered.push("cold_weather_rule");
    boostFamilies(["woody", "amber", "spicy", "tobacco", "leather", "musky"], 28);
    if (veryCold) deprioritizeFamilies(["aquatic", "citrus"], 12);
  }

  if (rainy) {
    rulesTriggered.push("rain_rule");
    boostFamilies(["green", "aquatic", "musky", "fresh"], 26);
    if (temperature < 75) boostFamilies(["woody"], 12);
    avoidFamily("smoky", 30);
    if (heavyLeather) avoidFamily("leather", 25);
    if (denseOud) avoidFamily("oud", 25);
    if (humidity >= 65) avoidFamily("gourmand", 25);
  }

  if (windy) {
    rulesTriggered.push("wind_rule");
    boostFamilies(["musky", "woody", "fresh", "citrus"], 16);
  }

  // Strong UV means bright, high-sun daytime conditions that thin top notes and
  // favour brighter, fresher profiles. UV is 0 at night, so this only fires in
  // genuine daytime sun. Modest boost so it refines, not overrides, the thermal
  // rules. Gated on uv_index being supplied, so callers/tests that omit it are
  // unaffected.
  const uvIndex = finiteNumber(input.weather.uv_index, 0);
  if (uvIndex >= 8) {
    rulesTriggered.push("high_uv_rule");
    boostFamilies(["fresh", "citrus", "aquatic", "green"], 14);
  }

  if (indoorSetting) {
    if (settingType === "indoor") rulesTriggered.push("indoor_rule");
    if (settingType === "work") rulesTriggered.push("work_rule");
    if (settingType === "close_contact") rulesTriggered.push("close_contact_rule");
    boostFamilies(["fresh", "musky", "green", "citrus"], 26);
    if (cleanLightProfile || traits.length === 0) boostFamilies(["powdery"], 8);
    for (const family of ["oud", "smoky", "leather", "tobacco", "gourmand"] as const) {
      avoidFamily(family, 35);
    }
    if (hasHeavyAmber) avoidFamily("amber", 30);
  }

  if (nightDate) {
    rulesTriggered.push("night_date_rule");
    boostFamilies(["woody", "amber", "spicy", "musky"], 26);
    if (!hotHumid) boostFamilies(["leather", "tobacco", "sweet"], 10);
    if (temperature >= 80 && hasFamilySignal(traits, "gourmand")) avoidFamily("gourmand", 25);
    if (humidity >= 65 && denseOud) avoidFamily("oud", 25);
    if (smokyLeatherInRain) {
      avoidFamily("smoky", 30);
      if (heavyLeather) avoidFamily("leather", 25);
    }
  }

  if (gym) {
    rulesTriggered.push("gym_rule");
    boostFamilies(["fresh", "citrus", "aquatic", "green", "musky"], 45);
    for (const family of ["sweet", "gourmand", "oud", "smoky", "leather", "tobacco", "amber"] as const) {
      avoidFamily(family, 50);
    }
    if (hasHeavyProfile) avoidFamily("spicy", 25);
    if (denseOrHeavyProfile) avoidFamily("powdery", 20);
  }

  if (rulesTriggered.length === 0) {
    boostFamilies(["fresh", "citrus", "green", "musky", "woody"], 14);
  }

  const bestScentFamilies = SCENT_FAMILIES.map((family, index) => ({
    family,
    score: familyScores[family],
    index,
  }))
    .filter(({ family, score }) => score > 0 && !avoidFamilies.has(family))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 5)
    .map(({ family }) => family);

  const avoidScentFamilies = SCENT_FAMILIES.map((family, index) => ({
    family,
    risk: avoidRiskScores[family],
    index,
  }))
    .filter(({ family }) => avoidFamilies.has(family))
    .sort((a, b) => b.risk - a.risk || a.index - b.index)
    .map(({ family }) => family);

  const sprayCount = calculateSprayCount(input, scores, {
    hotHumid,
    coldWeather,
    windy,
    outdoorOrMixed,
    strongSillage,
    weakSillage,
  });
  const projectionRisk = calculateProjectionRisk(input, scores, traits, {
    hotHumid,
    gym,
    indoorSetting,
    strongSillage,
    weakSillage,
    hasFreshProfile,
    hasSweetProfile,
    hasHeavyProfile,
  });
  const wearWindow = calculateWearWindow(input, projectionRisk, traits, {
    hotHumid,
    rainy,
    gym,
    indoorSetting,
    nightDate,
    hasFreshProfile,
    hasSweetProfile,
    hasHeavyProfile,
    denseOrHeavyProfile,
    smokyLeatherInRain,
  });
  const confidence = calculateConfidence(input, traits, { windy, gym, indoorSetting });
  const explanation = buildExplanation(input, {
    hotHumid,
    coldWeather,
    rainy,
    windy,
    indoorSetting,
    nightDate,
    gym,
  });

  return {
    best_scent_families: bestScentFamilies,
    avoid_scent_families: avoidScentFamilies,
    spray_count: sprayCount,
    projection_risk: projectionRisk,
    wear_window: wearWindow,
    confidence,
    explanation,
    debug: {
      atmosphere_scores: scores,
      rules_triggered: rulesTriggered,
    },
  };
}

function calculateSprayCount(
  input: ScentWeatherEngineInput,
  scores: AtmosphereScores,
  context: {
    hotHumid: boolean;
    coldWeather: boolean;
    windy: boolean;
    outdoorOrMixed: boolean;
    strongSillage: boolean;
    weakSillage: boolean;
  },
): ScentWeatherRecommendation["spray_count"] {
  const settingType = input.setting.type;
  let recommended = getBaseSprayCount(input.fragrance?.concentration);

  if (context.hotHumid) recommended -= 1;
  if (settingType === "indoor" || settingType === "work") recommended -= 1;
  if (settingType === "close_contact") recommended -= 1;
  if (context.strongSillage) recommended -= 1;
  if (scores.scent_fatigue_risk_score >= 70) recommended -= 1;
  if (input.userPreference?.projectionPreference === "subtle") recommended -= 1;

  if (context.coldWeather && settingType === "outdoor") recommended += 1;
  if (context.windy && context.outdoorOrMixed && !RESTRICTIVE_SETTINGS.includes(settingType)) {
    recommended += 1;
  }
  if (input.userPreference?.scentLastsOnMe === "short") recommended += 1;
  if (context.weakSillage) recommended += 1;

  let contextualMax = 5;
  if (settingType === "gym") contextualMax = Math.min(contextualMax, 1);
  if (settingType === "close_contact") contextualMax = Math.min(contextualMax, 2);
  if (settingType === "work") contextualMax = Math.min(contextualMax, 2);
  if (context.hotHumid) contextualMax = Math.min(contextualMax, 2);

  const wearableMinimum = contextualMax > 0 ? 1 : 0;

  // Clamp the (possibly deeply-negative, stacked-penalty) raw value into the
  // wearable band FIRST, then derive the display band as clamp(recommended ∓ 1)
  // around that clamped value. Deriving min/max from the clamped `recommended`
  // (not the raw value) guarantees a coherent band even if the bounds change.
  const boundedRecommended = Math.max(
    wearableMinimum,
    Math.min(contextualMax, Math.round(recommended)),
  );
  const min = Math.max(wearableMinimum, boundedRecommended - 1);
  const max = Math.min(contextualMax, boundedRecommended + 1);

  // Invariant the band must always satisfy: min <= recommended <= max. Cheap
  // guard so a future bounds change can never silently emit a degenerate band
  // (e.g. min > recommended).
  if (!(min <= boundedRecommended && boundedRecommended <= max)) {
    throw new Error(
      `spray_count band invariant violated: min=${min} recommended=${boundedRecommended} max=${max}`,
    );
  }

  return {
    recommended: boundedRecommended,
    min,
    max,
  };
}

function calculateProjectionRisk(
  input: ScentWeatherEngineInput,
  scores: AtmosphereScores,
  traits: readonly string[],
  context: {
    hotHumid: boolean;
    gym: boolean;
    indoorSetting: boolean;
    strongSillage: boolean;
    weakSillage: boolean;
    hasFreshProfile: boolean;
    hasSweetProfile: boolean;
    hasHeavyProfile: boolean;
  },
): ProjectionRisk {
  const heavyRiskFamily = hasAnyFamilySignal(traits, ["oud", "smoky", "leather", "tobacco", "gourmand"]);
  const closeContactHeavy =
    input.setting.type === "close_contact" && heavyRiskFamily && context.strongSillage;

  if (context.hotHumid && (context.hasHeavyProfile || context.hasSweetProfile)) {
    return "overpowering_risk";
  }
  if (context.gym && context.hasHeavyProfile) return "overpowering_risk";
  if (context.gym && context.hasSweetProfile) return "high";
  if (closeContactHeavy) return "overpowering_risk";

  let riskScore = 0;
  if (scores.heat_amplification_score >= 80) riskScore += 1;
  if (scores.humidity_weight_score >= 75) riskScore += 1;
  if (scores.scent_fatigue_risk_score >= 65) riskScore += 1;
  if (scores.sweetness_risk_score >= 70) riskScore += 1;
  if (scores.heaviness_risk_score >= 70) riskScore += 1;
  if (context.strongSillage) riskScore += 1;
  if (context.hasSweetProfile || context.hasHeavyProfile) riskScore += 1;
  if (context.indoorSetting && (context.hasSweetProfile || context.hasHeavyProfile || context.strongSillage)) {
    riskScore += 1;
  }
  if (context.hasFreshProfile && !context.hasSweetProfile && !context.hasHeavyProfile) riskScore -= 1;
  if (context.weakSillage) riskScore -= 1;

  let risk: ProjectionRisk = "medium";
  if (riskScore <= 0) risk = "low";
  else if (riskScore <= 2) risk = "medium";
  else risk = "high";

  if (
    context.indoorSetting &&
    risk === "high" &&
    !context.strongSillage &&
    !context.hasHeavyProfile &&
    !context.hasSweetProfile
  ) {
    risk = "medium";
  }

  return risk;
}

type WearWindowContext = {
  hotHumid: boolean;
  rainy: boolean;
  gym: boolean;
  indoorSetting: boolean;
  nightDate: boolean;
  hasFreshProfile: boolean;
  hasSweetProfile: boolean;
  hasHeavyProfile: boolean;
  denseOrHeavyProfile: boolean;
  smokyLeatherInRain: boolean;
};

function calculateWearWindow(
  input: ScentWeatherEngineInput,
  projectionRisk: ProjectionRisk,
  traits: readonly string[],
  context: WearWindowContext,
): WearWindow {
  const base = computeBaseWearWindow(input, projectionRisk, traits, context);

  // Refine against the real clock when the caller supplies it. "better_later"
  // and "nighttime_better" both advise holding off for later in the day; if it
  // is already evening or night there is nothing to wait for, so promote to
  // "best_now" unless projection would be overpowering. No-op when time_of_day
  // is omitted, so existing behaviour/tests are unchanged.
  const tod = input.weather.time_of_day;
  const isLateDay = tod === "evening" || tod === "night";
  if (
    isLateDay &&
    (base === "better_later" || base === "nighttime_better") &&
    projectionRisk !== "overpowering_risk"
  ) {
    return "best_now";
  }

  return base;
}

function computeBaseWearWindow(
  input: ScentWeatherEngineInput,
  projectionRisk: ProjectionRisk,
  traits: readonly string[],
  context: WearWindowContext,
): WearWindow {
  const hotHumidAvoidFamily = hasAnyFamilySignal(traits, ["gourmand", "oud", "smoky", "leather", "tobacco"]);

  if (context.gym && context.denseOrHeavyProfile) return "avoid_today";
  if (context.hotHumid && hotHumidAvoidFamily) return "avoid_today";
  if (input.setting.type === "close_contact" && projectionRisk === "overpowering_risk") return "avoid_today";
  if (context.rainy && context.smokyLeatherInRain) return "avoid_today";

  if (context.hotHumid && (context.hasSweetProfile || context.hasHeavyProfile)) return "nighttime_better";
  if (context.indoorSetting && (context.hasSweetProfile || context.hasHeavyProfile) && projectionRisk === "high") {
    return "better_later";
  }
  if (!context.nightDate && context.hasHeavyProfile && !context.hasFreshProfile && projectionRisk !== "low") {
    return "nighttime_better";
  }
  if (context.indoorSetting || context.hotHumid || context.gym) return "daytime_safe";
  if (context.nightDate && projectionRisk !== "overpowering_risk") return "best_now";
  if (projectionRisk === "low" || projectionRisk === "medium") return "best_now";
  return "better_later";
}

function calculateConfidence(
  input: ScentWeatherEngineInput,
  traits: readonly string[],
  context: { windy: boolean; gym: boolean; indoorSetting: boolean },
): Confidence {
  const weatherComplete = hasCompleteWeather(input);
  const settingKnown = isKnownSetting(input);
  const hasFamiliesOrAccords =
    (input.fragrance?.scent_families?.filter(Boolean).length ?? 0) > 0 ||
    (input.fragrance?.accords?.filter(Boolean).length ?? 0) > 0;

  let confidence: Confidence = "low";
  if (weatherComplete && settingKnown && hasFamiliesOrAccords) confidence = "high";
  else if (weatherComplete && settingKnown && traits.length > 0) confidence = "medium";
  else if (weatherComplete && settingKnown && input.fragrance) confidence = "medium";

  // Zero-trait floor: a fragrance object with no resolvable trait signals at all
  // (no families, no accords, no positive vector axes) carries no scent evidence,
  // so the "medium just because `input.fragrance` exists" branch above is not
  // honest. Demote to low — a generic weather pick should not read as a
  // calibrated, fragrance-aware recommendation. dataConfidence (below) is an
  // independent, caller-supplied cap; this covers the case where it is omitted.
  if (traits.length === 0) confidence = "low";

  // Honest confidence: the structural gates above only check that weather +
  // setting are known and that *some* family/accord exists, so a single thin
  // token previously earned "high". When the caller supplies a 0–1 data-quality
  // signal, cap confidence by it so partial/cold-search profiles cannot read as
  // confident. Omitted → unchanged behaviour.
  const dataConfidence = input.dataConfidence;
  if (typeof dataConfidence === "number" && Number.isFinite(dataConfidence)) {
    if (dataConfidence < 0.5) confidence = "low";
    else if (dataConfidence < 0.75 && confidence === "high") confidence = "medium";
  }

  if (context.windy && !context.gym && !context.indoorSetting) {
    confidence = reduceConfidence(confidence);
  }

  return confidence;
}

function buildExplanation(
  input: ScentWeatherEngineInput,
  context: {
    hotHumid: boolean;
    coldWeather: boolean;
    rainy: boolean;
    windy: boolean;
    indoorSetting: boolean;
    nightDate: boolean;
    gym: boolean;
  },
): string {
  if (context.gym) {
    return "Gym settings need very light, clean fragrance. Fresh, citrus, aquatic, green, or clean musk is safest, with no more than 1 spray.";
  }
  if (context.hotHumid) {
    return "Hot, humid air can make sweet and heavy scents feel louder, so fresh, citrus, aquatic, green, or clean musky scents are safer with a lighter spray count.";
  }
  if (context.rainy) {
    return "Rainy weather favors green, aquatic, musky, and fresh scents. Dense smoky, leathery, or oud-heavy scents may feel muddy in wet air.";
  }
  if (context.coldWeather && context.nightDate) {
    return "Cool night weather supports warmer woody, amber, spicy, and musky scents, especially if you are not in a close-contact setting.";
  }
  if (context.coldWeather) {
    return "Cool weather supports woody, amber, spicy, tobacco, leather, and musky scents, with a lighter touch in close indoor settings.";
  }
  if (context.indoorSetting) {
    return "Close indoor settings favor fresh, clean musky, green, or citrus scents. Heavy sweet, smoky, oud, or leather profiles can feel too loud.";
  }
  if (context.nightDate) {
    return "Night and date settings can support woody, amber, spicy, and musky scents when the air is not hot and humid.";
  }
  if (context.windy) {
    return "Wind can thin out projection outdoors, so musky, woody, fresh, or citrus scents hold up better with a moderate spray count.";
  }

  const season = input.weather.season;
  if (season === "spring" || season === "summer") {
    return "Mild warm weather keeps fresh, citrus, green, musky, and light woody scents flexible for daily wear.";
  }

  return "Current conditions are flexible, with fresh, citrus, green, musky, and light woody scents offering the safest daily balance.";
}
