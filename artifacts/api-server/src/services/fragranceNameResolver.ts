import fragrancesRaw from "../data/fragrances.json" with { type: "json" };
import type { FragranceData } from "./datasetLoader";

export type ResolvedFragranceIdentity = {
  brand: string;
  name: string;
  confidence: number;
  corrected: boolean;
};

export type FragranceCandidateMatch = {
  score: number;
  matched: boolean;
};

const MAX_QUERY_LENGTH = 180;
export const FRAGRANCE_CANDIDATE_MIN_SCORE = 0.82;
export const SAME_FRAGRANCE_IDENTITY_MIN_SCORE = 0.88;
const AMBIGUOUS_VARIANT_MAX_SCORE = FRAGRANCE_CANDIDATE_MIN_SCORE - 0.03;
const QUERY_WORDS_TO_IGNORE = new Set([
  "about",
  "add",
  "bottle",
  "details",
  "find",
  "fragrance",
  "give",
  "image",
  "info",
  "looking",
  "me",
  "my",
  "packshot",
  "perfume",
  "photo",
  "picture",
  "please",
  "product",
  "search",
  "show",
  "the",
  "up",
  "vault",
]);
const EXTRA_WORDS_ALLOWED = new Set([
  "edc",
  "edt",
  "edp",
  "eau",
  "de",
  "extrait",
  "parfum",
  "toilette",
]);
const FRAGRANCE_INTENT_WORDS = new Set([
  "cologne",
  "fragrance",
  "perfume",
  "parfum",
  "edt",
  "edp",
  "edc",
  "elixir",
  "extrait",
]);
function stripBundledImageFallbacks(items: FragranceData[]): FragranceData[] {
  return items.map(({ imageUrl: _imageUrl, ...item }) => item);
}

const DATASET = stripBundledImageFallbacks(fragrancesRaw as FragranceData[]);
const KNOWN_FRAGRANCE_BRAND_TOKENS = new Set(
  [
    ...DATASET.flatMap((item) =>
      compactRaw(item.brand)
        .split(" ")
        .filter((word) => word.length >= 3),
    ),
    "afnan",
    "amouage",
    "armaf",
    "azzaro",
    "byredo",
    "cartier",
    "diptyque",
    "french",
    "guerlain",
    "hermes",
    "initio",
    "lattafa",
    "montale",
    "mugler",
    "nishane",
    "prada",
    "versace",
    "xerjoff",
  ],
);
const RETAIL_NOISE_PATTERN =
  /\b(?:\d+(?:\.\d+)?\s*(?:m\s*l|ml|millilitre|milliliter|millilitres|milliliters|fl\.?\s*oz\.?|oz\.?|ounces?)|spray|natural\s+spray|vaporisateur|tester|sample|travel\s+size|mini|bottle|boxed|sealed|new\s+in\s+box|nib|refillable|refill|eau\s+de\s+parfum|eau\s+de\s+toilette|eau\s+de\s+cologne|extrait\s+de\s+parfum|edp|edt|edc)\b/i;
const FRAGRANCE_INTENT_PATTERN =
  /\b(?:cologne|fragrance|perfume|parfum|edt|edp|edc|elixir|eau\s+de\s+(?:toilette|parfum|cologne)|extrait\s+de\s+parfum)\b/i;
const NON_FRAGRANCE_CATEGORY_PATTERN =
  /\b(?:shoe|shoes|sneaker|sneakers|boot|boots|shirt|shirts|pants|jeans|dress|dresses|jacket|jackets|bag|bags|watch|watches|phone|phones|laptop|laptops|tablet|tablets|lipstick|mascara|foundation|skincare|candle|candles)\b/i;

function foldAscii(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

function applyKnownFragranceAliases(value: string): string {
  return value
    .replace(/\bcentel\s*33\b/gi, "Santal 33")
    .replace(/\binito\b/gi, "Initio")
    .replace(/\bfood\s*wood\b/gi, "Oud Wood")
    .replace(/\bhugo\s+boss\s+pacific\b/gi, "Hugo Boss Boss Bottled Pacific")
    .replace(/\bboss\s+bottles\s+pacific\b/gi, "Boss Bottled Pacific")
    .replace(/\b(?:initio\s+)?parfums?\s+priv(?:e|es|ees)\s+side\s+effect\b/gi, "Initio Side Effect")
    .replace(/\bmerv(?:i|e)l(?:i|e)s\b/gi, "Merveilles")
    .replace(/\begoste\s+leogiste\b/gi, "Egoiste Platinum")
    .replace(/\begoiste\s+l(?:egoiste|eogiste)\b/gi, "Egoiste Platinum")
    .replace(/\bego(?:\s+teast)?\s+legosti\b/gi, "Egoiste Platinum");
}

export function sanitizeFragranceQueryInput(value: string): string {
  return applyKnownFragranceAliases(foldAscii(value))
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function stripRetailNoise(value: string): string {
  return sanitizeFragranceQueryInput(value)
    .replace(/\([^)]*\)/g, (part) => (RETAIL_NOISE_PATTERN.test(part) ? " " : part))
    .replace(/\[[^\]]*\]/g, (part) => (RETAIL_NOISE_PATTERN.test(part) ? " " : part))
    .replace(/\b\d+(?:\.\d+)?\s*(?:m\s*l|ml|millilitre|milliliter|millilitres|milliliters)\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\.?\s*)?oz\.?\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*ounces?\b/gi, " ")
    .replace(/\b(?:natural\s+spray|vaporisateur|tester|sample|travel\s+size|mini|bottle|boxed|sealed|new\s+in\s+box|nib|refillable|refill|spray)\b/gi, " ")
    .replace(/\b(?:eau\s+de\s+parfum|eau\s+de\s+toilette|eau\s+de\s+cologne|extrait\s+de\s+parfum|edp|edt|edc)\b/gi, " ")
    .replace(/\s*[/|,;:-]\s*$/g, " ")
    .replace(/^\s*[/|,;:-]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanDisplayName(value: string): string {
  return stripRetailNoise(value) || value.trim();
}

function compactRaw(value: string): string {
  return sanitizeFragranceQueryInput(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bno\.\s*/g, "no ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(value: string): string {
  return compactRaw(cleanDisplayName(value));
}

function queryCompact(value: string): string {
  return compact(value)
    .split(" ")
    .filter((word) => !QUERY_WORDS_TO_IGNORE.has(word))
    .join(" ");
}

function tokens(value: string): string[] {
  return compact(value).split(" ").filter(Boolean);
}

function wordsFromCompact(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

function meaningfulQueryTokens(value: string): string[] {
  return compactRaw(stripRetailNoise(value))
    .split(" ")
    .filter((word) => {
      if (!word || word.length <= 1) return false;
      if (QUERY_WORDS_TO_IGNORE.has(word)) return false;
      if (FRAGRANCE_INTENT_WORDS.has(word)) return false;
      if (EXTRA_WORDS_ALLOWED.has(word)) return false;
      return true;
    });
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = next;
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const aa = compact(a);
  const bb = compact(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) {
    return Math.min(0.94, Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length) + 0.18);
  }
  const distance = levenshtein(aa, bb);
  const editScore = Math.max(0, 1 - distance / Math.max(aa.length, bb.length));
  const aaPairs = new Set(Array.from({ length: Math.max(0, aa.length - 1) }, (_, i) => aa.slice(i, i + 2)));
  const bbPairs = Array.from({ length: Math.max(0, bb.length - 1) }, (_, i) => bb.slice(i, i + 2));
  const sharedPairs = bbPairs.filter((pair) => aaPairs.has(pair)).length;
  const diceScore = bbPairs.length || aaPairs.size ? (2 * sharedPairs) / (aaPairs.size + bbPairs.length) : 0;
  return Math.max(editScore, diceScore);
}

function wordSimilarity(a: string, b: string): number {
  const score = similarity(a, b);
  if (score >= 0.72 && Math.min(a.length, b.length) >= 5) return score;
  if (a.length === b.length && a.length >= 6) {
    const sortedA = [...a].sort().join("");
    const sortedB = [...b].sort().join("");
    if (sortedA === sortedB) return 0.92;
  }
  return score;
}

function wordsMatch(a: string, b: string): boolean {
  return a === b || wordSimilarity(a, b) >= 0.72;
}

function tokenCoverage(needle: string, haystack: string): number {
  const wanted = tokens(needle);
  if (wanted.length === 0) return 0;
  const hayWords = tokens(haystack);
  let matched = 0;
  for (const word of wanted) {
    if (hayWords.some((h) => wordsMatch(word, h))) matched++;
  }
  return matched / wanted.length;
}

function unmatchedMeaningfulTokenCount(input: string, candidate: string): number {
  const candidateWords = tokens(candidate);
  return tokens(input).filter((word) => {
    if (EXTRA_WORDS_ALLOWED.has(word)) return false;
    return !candidateWords.some((candidateWord) => wordsMatch(word, candidateWord));
  }).length;
}

function unmatchedNameVariantTokenCount(inputName: string, candidateName: string): number {
  const candidateWords = tokens(candidateName);
  return tokens(inputName).filter((word) => {
    if (EXTRA_WORDS_ALLOWED.has(word)) return false;
    return !candidateWords.some((candidateWord) => wordsMatch(word, candidateWord));
  }).length;
}

function unmatchedCandidateNameTokenCount(input: string, candidateName: string): number {
  const inputWords = tokens(input);
  return tokens(candidateName).filter((word) => {
    if (EXTRA_WORDS_ALLOWED.has(word)) return false;
    if (/^\d+$/.test(word)) return false;
    return !inputWords.some((inputWord) => wordsMatch(word, inputWord));
  }).length;
}

function candidateScore(
  brand: string,
  name: string,
  candidateBrand: string,
  candidateName: string,
): number {
  const meaningfulInputTokens = meaningfulQueryTokens(`${brand} ${name}`);
  if (meaningfulInputTokens.length === 0) return 0;

  const cleanBrand = brand.trim();
  const cleanName = cleanDisplayName(name);
  const rawBrand = compact(cleanBrand);
  const rawName = compact(cleanName);
  const rawFull = compact(`${cleanBrand} ${cleanName}`);
  if (!rawFull) return 0;

  const itemBrand = compact(candidateBrand);
  const itemName = compact(candidateName);
  const itemFull = `${itemBrand} ${itemName}`.trim();
  const inputWords = wordsFromCompact(rawFull);
  const candidateBrandWords = wordsFromCompact(itemBrand);
  const candidateNameWords = wordsFromCompact(itemName);
  const allInputTokensAreBrand =
    inputWords.length > 0 &&
    inputWords.every((word) => candidateBrandWords.some((candidateWord) => wordsMatch(word, candidateWord)));
  const isExactName =
    rawName.length > 0 &&
    (rawName === itemName || (inputWords.length === candidateNameWords.length && tokenCoverage(rawName, itemName) === 1));

  const brandScore = rawBrand ? Math.max(similarity(rawBrand, itemBrand), tokenCoverage(rawBrand, itemBrand)) : 0.5;
  const nameScore = rawName ? Math.max(similarity(rawName, itemName), tokenCoverage(rawName, itemName)) : 0;
  const fullScore = Math.max(similarity(rawFull, itemFull), tokenCoverage(rawFull, itemFull));
  const weightedScore = rawBrand ? brandScore * 0.34 + nameScore * 0.66 : Math.max(nameScore, fullScore * 0.96);
  const extraPenalty = unmatchedMeaningfulTokenCount(rawFull, itemFull) * 0.18;
  let score = Math.max(fullScore, weightedScore) - extraPenalty;

  if (rawBrand && brandScore < 0.72) score -= 0.18;
  if (isExactName) score += 0.05;
  if (rawBrand && rawBrand === itemBrand) score += 0.04;

  if (allInputTokensAreBrand && !isExactName) {
    score = Math.min(score, 0.68);
  }

  const singleMeaningfulInputWord = meaningfulInputTokens.length === 1 ? meaningfulInputTokens[0] : "";
  const singleTokenVariantOnly =
    singleMeaningfulInputWord &&
    candidateNameWords.length > 1 &&
    candidateNameWords.some((word) => wordsMatch(singleMeaningfulInputWord, word)) &&
    !isExactName;
  if (singleTokenVariantOnly) {
    score = Math.min(score, AMBIGUOUS_VARIANT_MAX_SCORE);
  }

  const inputHasNumber = inputWords.some((word) => /\d/.test(word));
  const candidateNameAddsVariant = unmatchedCandidateNameTokenCount(rawFull, itemName) > 0;
  if (!inputHasNumber && candidateNameAddsVariant) {
    score = Math.min(score, AMBIGUOUS_VARIANT_MAX_SCORE);
  }

  return Math.max(0, Math.min(1, score));
}

function rankDatasetMatches(brand: string, name: string): Array<{ item: FragranceData; score: number }> {
  const rawFull = compact(`${brand.trim()} ${cleanDisplayName(name)}`);
  if (!rawFull) return [];

  return DATASET
    .map((item) => ({ item, score: candidateScore(brand, name, item.brand, item.name) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.name.length - b.item.name.length;
    });
}

function bestDatasetMatch(brand: string, name: string): ResolvedFragranceIdentity | null {
  const cleanBrand = brand.trim();
  const cleanName = cleanDisplayName(name);
  const originalBrand = compactRaw(brand);
  const originalName = compactRaw(name);
  const ranked = rankDatasetMatches(cleanBrand, cleanName);
  const best = ranked[0];
  if (!best || best.score < FRAGRANCE_CANDIDATE_MIN_SCORE) return null;
  const second = ranked[1];
  if (second && best.score < 0.97 && best.score - second.score < 0.04) return null;
  const corrected = compact(best.item.brand) !== originalBrand || compact(best.item.name) !== originalName;
  return {
    brand: best.item.brand,
    name: best.item.name,
    confidence: Number(best.score.toFixed(3)),
    corrected,
  };
}

export function fragranceCatalogSearchTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const word of queryCompact(query).split(" ")) {
    if (word.length <= 1) continue;
    if (FRAGRANCE_INTENT_WORDS.has(word)) continue;
    if (EXTRA_WORDS_ALLOWED.has(word)) continue;
    seen.add(word);
  }
  return [...seen].slice(0, 6);
}

export function matchesFragranceBrandQuery(query: string, brand: string): boolean {
  const queryWords = wordsFromCompact(queryCompact(query));
  const brandWords = wordsFromCompact(compactRaw(brand));
  if (queryWords.length === 0 || brandWords.length === 0) return false;
  return queryWords.every((word) => brandWords.some((brandWord) => wordsMatch(word, brandWord)));
}

export function hasMeaningfulFragranceQuery(query: string): boolean {
  return meaningfulQueryTokens(query).length > 0;
}

function looksLikeNamedFragranceQuery(query: string): boolean {
  if (NON_FRAGRANCE_CATEGORY_PATTERN.test(query) && !hasKnownFragranceBrandSignal(query)) return false;
  return meaningfulQueryTokens(query).length >= 2;
}

export function hasKnownFragranceBrandSignal(query: string): boolean {
  const queryWords = meaningfulQueryTokens(query);
  return queryWords.some((word) => KNOWN_FRAGRANCE_BRAND_TOKENS.has(word));
}

export function scoreFragranceCandidate(
  input: string | { brand?: string; name?: string },
  candidate: { brand?: string; name?: string },
  minScore = FRAGRANCE_CANDIDATE_MIN_SCORE,
): FragranceCandidateMatch {
  const inputBrand = typeof input === "string" ? "" : input.brand ?? "";
  const inputName = typeof input === "string" ? input : input.name ?? "";
  const candidateBrand = candidate.brand ?? "";
  const candidateName = candidate.name ?? "";
  const score = candidateScore(inputBrand, inputName, candidateBrand, candidateName);
  return {
    score: Number(score.toFixed(3)),
    matched: score >= minScore,
  };
}

export function isLikelySameFragranceIdentity(
  input: { brand?: string; name?: string },
  candidate: { brand?: string; name?: string },
  minScore = SAME_FRAGRANCE_IDENTITY_MIN_SCORE,
): boolean {
  const match = scoreFragranceCandidate(input, candidate, minScore);
  if (!match.matched) return false;
  const inputName = input.name ?? "";
  const candidateName = candidate.name ?? "";
  return (
    unmatchedNameVariantTokenCount(inputName, candidateName) === 0 &&
    unmatchedNameVariantTokenCount(candidateName, inputName) === 0
  );
}

export function findDatasetFragrance(brand: string, name: string): FragranceData | undefined {
  const resolved = bestDatasetMatch(brand, name);
  if (!resolved) return undefined;
  return DATASET.find((item) => item.brand === resolved.brand && item.name === resolved.name);
}

export function searchFragranceDataset(query: string, limit = 5): FragranceData[] {
  const cleaned = queryCompact(query);
  if (!cleaned) return [];
  return rankDatasetMatches("", cleaned)
    .filter((item) => item.score >= FRAGRANCE_CANDIDATE_MIN_SCORE)
    .slice(0, limit)
    .map((item) => item.item);
}

export function searchFragranceDatasetByBrand(query: string, limit = 12): FragranceData[] {
  const cleaned = queryCompact(query);
  if (!cleaned || !hasMeaningfulFragranceQuery(cleaned)) return [];
  const boundedLimit = Math.max(1, Math.min(limit, 24));

  return DATASET
    .filter((item) => matchesFragranceBrandQuery(cleaned, item.brand))
    .sort((a, b) => {
      const aExact = compactRaw(a.brand) === cleaned ? 0 : 1;
      const bExact = compactRaw(b.brand) === cleaned ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.name.localeCompare(b.name);
    })
    .slice(0, boundedLimit);
}

export function resolveFragranceIdentity(brand: string, name: string): ResolvedFragranceIdentity {
  const cleanBrand = brand.trim();
  const cleanName = cleanDisplayName(name);
  const fallback = {
    brand: cleanBrand,
    name: cleanName,
    confidence: 0,
    corrected: compactRaw(cleanBrand) !== compactRaw(brand) || compactRaw(cleanName) !== compactRaw(name),
  };
  return bestDatasetMatch(brand, name) ?? fallback;
}

export function resolveFragranceQuery(query: string): ResolvedFragranceIdentity | null {
  const cleaned = queryCompact(query);
  if (!cleaned) return null;
  return bestDatasetMatch("", cleaned);
}

export function shouldSearchExternalFragranceSources(query: string): boolean {
  const sanitized = sanitizeFragranceQueryInput(query);
  if (!sanitized) return false;
  return (
    resolveFragranceQuery(sanitized) !== null ||
    hasKnownFragranceBrandSignal(sanitized) ||
    (FRAGRANCE_INTENT_PATTERN.test(sanitized) && hasMeaningfulFragranceQuery(sanitized)) ||
    looksLikeNamedFragranceQuery(sanitized)
  );
}

export function asciiForImageSearch(value: string): string {
  return foldAscii(value).replace(/[^\x20-\x7E]/g, "").trim();
}
