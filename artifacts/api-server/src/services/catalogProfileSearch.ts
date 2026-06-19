import type { ScentProfile } from "./scentEngineCore.ts";

type ProfileConcept = {
  pattern: RegExp;
  terms: string[];
  vector?: keyof ScentProfile["scent_vector"];
};

const PROFILE_SEARCH_CONCEPTS: ProfileConcept[] = [
  {
    pattern: /\b(?:clean|crisp)\b/i,
    terms: ["clean", "fresh", "citrus", "musk", "soapy"],
    vector: "freshness",
  },
  {
    pattern: /\b(?:airy|light|lightweight|ozonic)\b/i,
    terms: ["airy", "light", "ozonic", "aquatic", "marine", "fresh"],
    vector: "freshness",
  },
  {
    pattern: /\b(?:fresh|refreshing)\b/i,
    terms: ["fresh", "citrus", "green", "aquatic", "marine"],
    vector: "freshness",
  },
  {
    pattern: /\b(?:humid|humidity|muggy)\b/i,
    terms: ["aquatic", "marine", "ozonic", "fresh", "citrus", "green"],
    vector: "freshness",
  },
  {
    pattern: /\b(?:hot|heat|summer)\b/i,
    terms: ["summer", "hot", "fresh", "citrus", "aquatic", "green"],
    vector: "freshness",
  },
  {
    pattern: /\b(?:wood|woods|woody)\b/i,
    terms: ["woody", "wood", "cedar", "sandalwood", "vetiver"],
    vector: "woodiness",
  },
  {
    pattern: /\b(?:sweet|sweetness|gourmand)\b/i,
    terms: ["sweet", "gourmand", "vanilla", "tonka"],
    vector: "sweetness",
  },
  {
    pattern: /\b(?:warm|warmth|cozy)\b/i,
    terms: ["warm", "amber", "resin", "spicy"],
    vector: "warmth",
  },
  {
    pattern: /\b(?:spicy|spice)\b/i,
    terms: ["spicy", "spice", "pepper", "cardamom"],
    vector: "spice",
  },
  { pattern: /\b(?:musky|musk)\b/i, terms: ["musk", "musky"], vector: "musk" },
  {
    pattern: /\b(?:green|aromatic)\b/i,
    terms: ["green", "aromatic", "herbal", "vetiver"],
  },
  {
    pattern: /\b(?:party|night out|social)\b/i,
    terms: ["party", "night", "social", "evening"],
  },
  {
    pattern: /\b(?:office|work|interview)\b/i,
    terms: ["office", "work", "professional", "day"],
  },
  {
    pattern: /\b(?:date|dinner|romantic)\b/i,
    terms: ["date", "dinner", "romantic", "evening"],
  },
  {
    pattern: /\bmodern\b/i,
    terms: ["modern", "clean", "minimal", "contemporary"],
  },
];

export function catalogProfileSearchConcepts(query: string): ProfileConcept[] {
  return PROFILE_SEARCH_CONCEPTS.filter((concept) =>
    concept.pattern.test(query),
  );
}

export function catalogProfileSearchTerms(query: string): string[] {
  return [
    ...new Set(
      catalogProfileSearchConcepts(query).flatMap((concept) => concept.terms),
    ),
  ];
}

function normalizedVectorValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(value, 10)) / 10
    : 0;
}

/** Rank profile evidence against the user's descriptive scent language. */
export function scoreCatalogProfileForQuery(
  query: string,
  profile: ScentProfile,
): number {
  const concepts = catalogProfileSearchConcepts(query);
  if (concepts.length === 0) return 0;
  const document = JSON.stringify({
    family: profile.family,
    notes: profile.notes,
    pyramid: profile.pyramid,
    accords: profile.accords,
    context: profile.context,
    description: profile.description,
  }).toLowerCase();
  let score = 0;
  for (const concept of concepts) {
    const textMatch = concept.terms.some((term) => document.includes(term));
    const vectorMatch = concept.vector
      ? normalizedVectorValue(profile.scent_vector?.[concept.vector])
      : 0;
    score += Math.max(textMatch ? 0.8 : 0, vectorMatch * 0.6);
  }
  return Number((score / concepts.length).toFixed(4));
}
