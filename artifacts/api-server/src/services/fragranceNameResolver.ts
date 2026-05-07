import fragrancesRaw from "../data/fragrances.json" with { type: "json" };
import type { FragranceData } from "./datasetLoader";

export type ResolvedFragranceIdentity = {
  brand: string;
  name: string;
  confidence: number;
  corrected: boolean;
};

const MIN_CONFIDENT_SCORE = 0.8;
const QUERY_WORDS_TO_IGNORE = new Set([
  "bottle",
  "fragrance",
  "image",
  "packshot",
  "perfume",
  "photo",
  "picture",
  "product",
  "search",
]);
const EXTRA_WORDS_ALLOWED = new Set([
  "edc",
  "edt",
  "edp",
  "elixir",
  "eau",
  "de",
  "parfum",
  "toilette",
]);
const DATASET = fragrancesRaw as FragranceData[];
const RETAIL_NOISE_PATTERN =
  /\b(?:\d+(?:\.\d+)?\s*(?:m\s*l|ml|millilitre|milliliter|millilitres|milliliters|fl\.?\s*oz\.?|oz\.?|ounces?)|spray|natural\s+spray|vaporisateur|tester|sample|travel\s+size|mini|bottle|boxed|sealed|new\s+in\s+box|nib|refillable|refill|eau\s+de\s+parfum|eau\s+de\s+toilette|eau\s+de\s+cologne|extrait\s+de\s+parfum|edp|edt|edc)\b/i;
const FRAGRANCE_INTENT_PATTERN =
  /\b(?:cologne|fragrance|perfume|parfum|edt|edp|edc|eau\s+de\s+(?:toilette|parfum|cologne)|extrait\s+de\s+parfum)\b/i;

function foldAscii(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

function stripRetailNoise(value: string): string {
  return foldAscii(value)
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
  return foldAscii(value)
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

function tokenCoverage(needle: string, haystack: string): number {
  const wanted = tokens(needle);
  if (wanted.length === 0) return 0;
  const hay = compact(haystack);
  let matched = 0;
  for (const word of wanted) {
    if (hay.split(" ").some((h) => h === word || wordSimilarity(word, h) >= 0.72)) matched++;
  }
  return matched / wanted.length;
}

function unmatchedMeaningfulTokenCount(input: string, candidate: string): number {
  const candidateWords = tokens(candidate);
  return tokens(input).filter((word) => {
    if (EXTRA_WORDS_ALLOWED.has(word)) return false;
    return !candidateWords.some((candidateWord) => candidateWord === word || wordSimilarity(word, candidateWord) >= 0.72);
  }).length;
}

function bestDatasetMatch(brand: string, name: string): ResolvedFragranceIdentity | null {
  const cleanBrand = brand.trim();
  const cleanName = cleanDisplayName(name);
  const originalBrand = compactRaw(brand);
  const originalName = compactRaw(name);
  const rawBrand = compact(cleanBrand);
  const rawName = compact(cleanName);
  const rawFull = compact(`${cleanBrand} ${cleanName}`);
  if (!rawFull) return null;

  let best: { item: FragranceData; score: number } | null = null;
  for (const item of DATASET) {
    const itemBrand = compact(item.brand);
    const itemName = compact(item.name);
    const itemFull = `${itemBrand} ${itemName}`;

    const brandScore = rawBrand ? Math.max(similarity(rawBrand, itemBrand), tokenCoverage(rawBrand, itemBrand)) : 0.5;
    const nameScore = rawName ? Math.max(similarity(rawName, itemName), tokenCoverage(rawName, itemName)) : 0;
    const fullScore = Math.max(similarity(rawFull, itemFull), tokenCoverage(rawFull, itemFull));
    const extraPenalty = unmatchedMeaningfulTokenCount(rawFull, itemFull) * 0.2;
    const score = Math.max(fullScore, brandScore * 0.34 + nameScore * 0.66) - extraPenalty;

    if (!best || score > best.score) best = { item, score };
  }

  if (!best || best.score < MIN_CONFIDENT_SCORE) return null;
  const corrected = compact(best.item.brand) !== originalBrand || compact(best.item.name) !== originalName;
  return {
    brand: best.item.brand,
    name: best.item.name,
    confidence: Number(best.score.toFixed(3)),
    corrected,
  };
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
  return FRAGRANCE_INTENT_PATTERN.test(query) || resolveFragranceQuery(query) !== null;
}

export function asciiForImageSearch(value: string): string {
  return foldAscii(value).replace(/[^\x20-\x7E]/g, "").trim();
}
