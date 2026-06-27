import type { ParsedFragrance, Concentration } from "./scentParser";

export interface ScentVector {
  freshness: number;
  sweetness: number;
  woodiness: number;
  spice: number;
  warmth: number;
  musk: number;
}

export interface PerformanceMetrics {
  sillage: number;
  longevity: number;
  /**
   * A2-GAP5: optional projection (0..10) — only set when an authoritative source
   * (the Python engine's `derived_metrics`) supplied it. The keyword formula does
   * not fabricate a projection, so its absence is meaningful.
   */
  projection?: number;
}

export interface ContextProfile {
  weather: string[];
  occasion: string[];
}

/**
 * A2-GAP1/2/3: how much of a fragrance's note set actually fed the vector.
 * `match_ratio` is matched note tokens / total note tokens; a low ratio (or zero
 * matched notes) means the 6-axis vector is mostly fabricated and must not be
 * presented with full confidence.
 */
export interface VectorCoverage {
  matched_notes: number;
  total_notes: number;
  match_ratio: number;
}

export type VectorConfidence = "none" | "low" | "ok";

type VectorKey = keyof ScentVector;

interface Rule {
  words: string[];
  weight: number;
}

const RULES: Record<VectorKey, Rule[]> = {
  freshness: [
    { words: ["bergamot", "lemon", "lime", "grapefruit", "orange", "mandarin", "yuzu", "citrus", "neroli", "petitgrain", "bigarade", "cedrat", "verbena", "litsea"], weight: 2.0 },
    { words: ["mint", "spearmint", "peppermint", "eucalyptus", "menthol"], weight: 1.8 },
    { words: ["fresh", "aquatic", "marine", "ozone", "sea", "ocean", "water", "watery", "ozonic", "calone", "sea salt", "sea spray"], weight: 2.0 },
    { words: ["green", "grass", "basil", "violet leaf", "fig leaf", "tomato leaf", "galbanum", "ivy", "bamboo", "rhubarb"], weight: 1.2 },
    { words: ["tea", "green tea", "black tea", "matcha", "white tea"], weight: 1.2 },
    { words: ["lavender", "lavandin"], weight: 1.2 },
    { words: ["pineapple", "apple", "pear", "melon", "cucumber", "blackcurrant", "lychee", "lotus", "water lily"], weight: 0.9 },
    { words: ["aldehydic", "aldehydes", "aldehyde"], weight: 0.8 },
  ],
  sweetness: [
    { words: ["vanilla", "vanillin", "ethyl vanillin", "bourbon vanilla"], weight: 2.5 },
    { words: ["tonka", "tonka bean", "coumarin"], weight: 2.0 },
    { words: ["honey", "beeswax", "praline", "sugar", "caramel", "butterscotch", "toffee", "marshmallow", "cotton candy", "nougat"], weight: 2.0 },
    { words: ["coconut", "almond", "marzipan", "amaretto"], weight: 1.6 },
    { words: ["milk", "milky", "lactonic", "lactone", "cream", "creamy", "custard", "condensed milk"], weight: 1.4 },
    { words: ["chocolate", "cocoa", "coffee", "espresso"], weight: 1.8 },
    { words: ["heliotrope", "benzyl acetate", "ethyl maltol", "maltol", "licorice", "liquorice"], weight: 1.5 },
    { words: ["peach", "apricot", "plum", "cherry", "berry", "raspberry", "strawberry", "fruity", "fig", "date", "blackberry", "mango"], weight: 1.0 },
    { words: ["jasmine", "rose", "tuberose", "sweet", "ylang", "magnolia", "orange blossom", "frangipani"], weight: 0.6 },
  ],
  woodiness: [
    { words: ["cedar", "cedarwood", "virginian cedar", "atlas cedar"], weight: 2.0 },
    { words: ["sandalwood", "mysore sandalwood", "australian sandalwood", "santal"], weight: 2.0 },
    { words: ["vetiver", "haitian vetiver", "javanese vetiver"], weight: 2.2 },
    { words: ["patchouli", "dark patchouli"], weight: 2.0 },
    { words: ["oud", "agarwood", "oud wood"], weight: 2.5 },
    { words: ["guaiac", "guaiac wood", "gaiac"], weight: 1.8 },
    { words: ["birch", "birch tar"], weight: 1.8 },
    { words: ["oakmoss", "treemoss", "moss", "mossy"], weight: 1.5 },
    { words: ["woody", "forest", "timber", "driftwood", "bark", "hinoki", "cypress", "papyrus", "teak"], weight: 1.5 },
    { words: ["pine", "fir", "spruce", "balsam fir", "pine needle"], weight: 1.2 },
    { words: ["iso e super", "ambroxan", "javanol", "bacdanol", "cashmeran", "cashmere wood"], weight: 1.0 },
  ],
  spice: [
    { words: ["pepper", "black pepper", "pink pepper", "sichuan pepper", "white pepper"], weight: 2.5 },
    { words: ["cardamom", "cardamon"], weight: 2.2 },
    { words: ["ginger", "ginger root"], weight: 2.0 },
    { words: ["saffron", "safran"], weight: 2.5 },
    { words: ["clove", "clove bud", "eugenol"], weight: 2.0 },
    { words: ["cinnamon", "cassia", "cinnamic"], weight: 1.8 },
    { words: ["nutmeg", "mace"], weight: 1.6 },
    { words: ["cumin", "caraway"], weight: 1.5 },
    { words: ["anise", "star anise", "fennel", "coriander", "juniper"], weight: 1.4 },
    { words: ["spicy", "spice", "incense", "oud", "frankincense", "myrrh"], weight: 1.2 },
  ],
  warmth: [
    { words: ["amber", "ambergris", "grey amber"], weight: 2.5 },
    { words: ["ambroxan", "ambrette"], weight: 2.0 },
    { words: ["resin", "resinous", "benzoin", "styrax", "labdanum", "cistus", "rockrose"], weight: 2.5 },
    { words: ["balsam", "balsamic", "peru balsam", "tolu balsam"], weight: 2.0 },
    { words: ["tobacco", "tobacco leaf", "virginia tobacco", "dark tobacco"], weight: 2.0 },
    { words: ["leather", "leathery", "suede", "birch tar", "castoreum"], weight: 1.8 },
    { words: ["smoke", "smoky", "smoked", "campfire", "birch smoke"], weight: 1.8 },
    { words: ["rum", "whiskey", "whisky", "cognac", "brandy", "boozy", "absinthe"], weight: 1.4 },
    { words: ["warm", "opulent", "rich", "deep", "dark", "heavy"], weight: 1.0 },
    { words: ["spices", "dry spices", "warm spices"], weight: 1.2 },
    { words: ["elemi", "olibanum", "incense"], weight: 1.5 },
  ],
  musk: [
    { words: ["musk", "white musk", "clean musk", "musks", "musky"], weight: 2.5 },
    { words: ["ambroxan", "iso e super", "hedione", "galaxolide"], weight: 1.8 },
    { words: ["ambergris", "ambrette", "exaltolide"], weight: 2.0 },
    { words: ["civet", "castoreum", "animalic", "animal"], weight: 2.0 },
    { words: ["powder", "powdery", "talcum", "iris", "orris"], weight: 1.2 },
    { words: ["skin", "skin-like", "salty skin", "clean"], weight: 1.0 },
  ],
};

/**
 * A2-GAP4: low-weight map from a parsed accord keyword to the axis(es) it
 * reinforces. The parser computes `accords` from the description + notes but the
 * vectorizer never read them; folding them in at a low weight lets a crowd/curated
 * accord (e.g. "gourmand", "chypre", "leathery") nudge the vector even when the
 * raw note text didn't contain a matching keyword. Kept deliberately lighter than
 * a real note match so accords corroborate rather than dominate.
 */
const ACCORD_AXES: Record<string, VectorKey[]> = {
  citrus: ["freshness"],
  fresh: ["freshness"],
  aquatic: ["freshness"],
  marine: ["freshness"],
  green: ["freshness"],
  herbal: ["freshness"],
  mineral: ["freshness"],
  gourmand: ["sweetness"],
  sweet: ["sweetness"],
  fruity: ["sweetness"],
  tropical: ["sweetness"],
  creamy: ["sweetness"],
  woody: ["woodiness"],
  earthy: ["woodiness"],
  mossy: ["woodiness"],
  chypre: ["woodiness", "freshness"],
  fougere: ["woodiness", "freshness"],
  spicy: ["spice"],
  amber: ["warmth"],
  oriental: ["warmth", "sweetness"],
  balsamic: ["warmth"],
  resinous: ["warmth"],
  smoky: ["warmth"],
  leathery: ["warmth"],
  tobacco: ["warmth"],
  incense: ["warmth", "spice"],
  boozy: ["warmth", "sweetness"],
  powdery: ["musk"],
  musk: ["musk"],
  animalic: ["musk"],
  floral: ["sweetness"],
  salty: ["freshness"],
  metallic: ["freshness"],
  dry: ["woodiness"],
  aromatic: ["freshness"],
};

const ACCORD_WEIGHT = 0.8;

const PYRAMID_WEIGHTS: Record<"top" | "heart" | "base", number> = {
  top: 0.7,
  heart: 1.0,
  base: 1.4,
};

const CONCENTRATION_BOOSTS: Record<string, { longevity: number; sillage: number }> = {
  "Extrait": { longevity: 3, sillage: 2 },
  "Parfum": { longevity: 2, sillage: 1 },
  "Eau de Parfum": { longevity: 1, sillage: 1 },
  "Eau de Toilette": { longevity: 0, sillage: 0 },
  "Eau de Cologne": { longevity: -1, sillage: -1 },
  "Body Spray": { longevity: -2, sillage: -1 },
  "Unknown": { longevity: 0, sillage: 0 },
};

// A2-GAP2: word-boundary matching. The old `text.includes(word)` leaked across
// note boundaries — "warm" matched inside "lukewarm", "sea" inside "seasonal" —
// and turned an unbounded substring scan into silent false positives. We now
// require whole-token matches (word boundaries on both sides), which also lets
// multi-word rule phrases like "iso e super" or "white musk" still match. Each
// matched rule word adds its weight once, regardless of frequency (unchanged).
const wordRegexCache = new Map<string, RegExp>();
function wordRegex(word: string): RegExp {
  let re = wordRegexCache.get(word);
  if (!re) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i");
    wordRegexCache.set(word, re);
  }
  return re;
}

function scoreText(text: string, rules: Rule[]): number {
  let score = 0;
  for (const rule of rules) {
    for (const word of rule.words) {
      if (wordRegex(word).test(text)) score += rule.weight;
    }
  }
  return score;
}

function scoreLayer(notes: string[], positionWeight: number, rules: Rule[]): number {
  const text = notes.join(" , ");
  return scoreText(text, rules) * positionWeight;
}

// A2-GAP4: fold the parsed accords into the relevant axes at a low weight.
function scoreAccords(accords: string[] | undefined, key: VectorKey): number {
  if (!accords || accords.length === 0) return 0;
  let score = 0;
  const seen = new Set<string>();
  for (const accord of accords) {
    const normalized = accord.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const axes = ACCORD_AXES[normalized];
    if (axes && axes.includes(key)) score += ACCORD_WEIGHT;
  }
  return score;
}

export function vectorize(parsed: ParsedFragrance): ScentVector {
  const v: Record<VectorKey, number> = {
    freshness: 0, sweetness: 0, woodiness: 0, spice: 0, warmth: 0, musk: 0
  };

  const { top, heart, base } = parsed.pyramidNotes;
  const hasPyramid = top.length > 0 || heart.length > 0 || base.length > 0;

  for (const key of Object.keys(v) as VectorKey[]) {
    const rules = RULES[key];

    if (hasPyramid) {
      v[key] +=
        scoreLayer(top, PYRAMID_WEIGHTS.top, rules) +
        scoreLayer(heart, PYRAMID_WEIGHTS.heart, rules) +
        scoreLayer(base, PYRAMID_WEIGHTS.base, rules);
    } else {
      v[key] += scoreLayer(parsed.notes, 1.0, rules);
    }

    v[key] += scoreText(parsed.description, rules) * 0.5;
    v[key] += scoreAccords(parsed.accords, key);
  }

  const vector: any = {};
  for (const key in v) {
    let val = v[key as VectorKey];
    if (val > 0) val += 2.5;
    vector[key] = Math.min(10, Math.round(val));
  }
  return vector as ScentVector;
}

const ALL_RULE_WORDS: string[] = Array.from(
  new Set(
    (Object.values(RULES) as Rule[][]).flatMap((rules) => rules.flatMap((rule) => rule.words)),
  ),
);

/**
 * A2-GAP1/3: measure how much of a fragrance's note set actually matched the
 * keyword dictionary. A note "matches" when any rule word is a whole-token hit
 * inside it. `match_ratio` (matched / total notes) is the data-quality signal the
 * profile carries upward so a vector built from mostly-unrecognized notes is not
 * trusted like a fully-recognized one.
 */
export function assessVectorCoverage(parsed: ParsedFragrance): VectorCoverage {
  const { top, heart, base } = parsed.pyramidNotes;
  const hasPyramid = top.length > 0 || heart.length > 0 || base.length > 0;
  const noteSource = hasPyramid ? [...top, ...heart, ...base] : parsed.notes;

  const seen = new Set<string>();
  const notes: string[] = [];
  for (const raw of noteSource) {
    const note = String(raw ?? "").trim().toLowerCase();
    if (!note || seen.has(note)) continue;
    seen.add(note);
    notes.push(note);
  }

  const total = notes.length;
  if (total === 0) return { matched_notes: 0, total_notes: 0, match_ratio: 0 };

  let matched = 0;
  for (const note of notes) {
    if (ALL_RULE_WORDS.some((word) => wordRegex(word).test(note))) matched += 1;
  }
  return {
    matched_notes: matched,
    total_notes: total,
    match_ratio: matched / total,
  };
}

/**
 * A2-GAP3: turn raw coverage into a coarse provenance flag. `none` means the
 * vector has no note support at all (its axes are fabricated); `low` means the
 * note set is sparse or mostly unrecognized; `ok` means the dictionary backed a
 * solid share of the notes.
 */
export function deriveVectorConfidence(coverage: VectorCoverage): VectorConfidence {
  if (coverage.matched_notes === 0) return "none";
  if (coverage.matched_notes < 3 || coverage.match_ratio < 0.34) return "low";
  return "ok";
}

export function calculatePerformance(
  vector: ScentVector,
  family: string,
  concentration: string,
  coverage?: VectorCoverage,
): PerformanceMetrics {
  const heaviness = (vector.woodiness * 1.3 + vector.warmth * 1.2 + vector.musk * 1.0 + vector.spice * 0.5) / 4;
  let longevity = Math.round(4 + heaviness * 0.7 - vector.freshness * 0.15);
  let sillage = Math.round(3 + (
    vector.spice * 0.7 +
    vector.sweetness * 0.5 +
    vector.woodiness * 0.4 +
    vector.musk * 0.4 +
    vector.warmth * 0.3
  ) / 3);

  if (family.toLowerCase().includes("parfum") || family.toLowerCase().includes("intense")) {
    longevity += 1;
    sillage += 1;
  }

  const boost = CONCENTRATION_BOOSTS[concentration] ?? CONCENTRATION_BOOSTS["Unknown"];
  longevity += boost.longevity;
  sillage += boost.sillage;

  // A2-GAP3: when an all-zero / note-less vector reaches here, the formula's
  // constant base would emit a plausible-looking { sillage: 3, longevity: 4 } as
  // if it were a real reading. When the caller passes coverage proving no note
  // matched the dictionary, de-rate by one band so an empty profile cannot
  // present confident performance. Callers that omit `coverage` keep the legacy
  // formula output unchanged.
  if (coverage && coverage.matched_notes === 0) {
    longevity -= 1;
    sillage -= 1;
  }

  return {
    sillage: Math.min(10, Math.max(1, sillage)),
    longevity: Math.min(10, Math.max(1, longevity)),
  };
}

export function calculateContext(vector: ScentVector): ContextProfile {
  const profile: ContextProfile = { weather: [], occasion: [] };

  if (vector.freshness >= 5) {
    profile.weather.push("Warm", "Mild");
    profile.occasion.push("Casual", "Daytime");
  }
  if (vector.warmth >= 5 || vector.spice >= 5) {
    profile.weather.push("Cool", "Cold");
    profile.occasion.push("Evening", "Formal");
  }
  if (vector.woodiness >= 5 || vector.musk >= 5) {
    profile.occasion.push("Professional", "Social");
    if (profile.weather.length === 0) profile.weather.push("Universal");
  }
  if (vector.freshness >= 5 && vector.woodiness >= 5) {
    profile.occasion.push("Executive", "Social Dominance");
    if (!profile.weather.includes("Universal")) profile.weather.push("Universal");
  }
  if (vector.sweetness >= 6) {
    profile.occasion.push("Date Night", "Intimate");
    if (!profile.weather.includes("Cool") && !profile.weather.includes("Cold")) {
      profile.weather.push("Cool");
    }
  }
  if (vector.freshness >= 7 && vector.warmth < 4) {
    profile.occasion.push("Sport", "Outdoor");
    if (!profile.weather.includes("Warm")) profile.weather.push("Warm");
  }

  const deduped = (arr: string[]) => Array.from(new Set(arr));
  profile.weather = deduped(profile.weather);
  profile.occasion = deduped(profile.occasion);

  if (profile.weather.length === 0) profile.weather.push("Universal");
  if (profile.occasion.length === 0) profile.occasion.push("Daily Wear");

  return profile;
}
