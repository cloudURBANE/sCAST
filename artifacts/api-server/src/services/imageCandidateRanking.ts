import type { RemoveBgStatus } from "./bgService";
import type { SerperImageCandidate } from "./serperService";

const IMAGE_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "bottle",
  "by",
  "cologne",
  "de",
  "eau",
  "edp",
  "edt",
  "elixir",
  "extrait",
  "for",
  "fragrance",
  "in",
  "ml",
  "no",
  "of",
  "packshot",
  "parfum",
  "perfume",
  "photo",
  "product",
  "single",
  "spray",
  "studio",
  "the",
  "toilette",
  "with",
]);

type ProcessedCandidateSnapshot = {
  width: number | null;
  height: number | null;
  backgroundRemoved: boolean;
  removeBgStatus?: RemoveBgStatus;
};

function tokenize(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !IMAGE_TOKEN_STOPWORDS.has(token));
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))];
}

function candidateEvidenceText(candidate: Pick<SerperImageCandidate, "imageUrl" | "title" | "source">): string {
  let urlText = "";
  try {
    const parsed = new URL(candidate.imageUrl);
    urlText = `${parsed.hostname} ${decodeURIComponent(parsed.pathname)}`;
  } catch {
    urlText = candidate.imageUrl;
  }
  return `${candidate.title ?? ""} ${candidate.source ?? ""} ${urlText}`.trim();
}

export function computeFragranceIdentityCoverage(
  brand: string,
  name: string,
  candidate: Pick<SerperImageCandidate, "imageUrl" | "title" | "source">,
): number {
  const targetTokens = uniqueTokens(`${brand} ${name}`);
  if (targetTokens.length === 0) return 0.5;

  const evidence = candidateEvidenceText(candidate);
  const hayTokens = uniqueTokens(evidence);
  if (hayTokens.length === 0) return 0;

  const matched = targetTokens.filter((token) =>
    hayTokens.some((hay) => hay === token || hay.includes(token) || token.includes(hay)),
  ).length;

  return matched / targetTokens.length;
}

export function shouldSkipSerperCandidateByIdentity(
  brand: string,
  name: string,
  candidate: Pick<SerperImageCandidate, "imageUrl" | "title" | "source">,
): boolean {
  const targetTokens = uniqueTokens(`${brand} ${name}`);
  if (targetTokens.length < 2) return false;

  const evidence = candidateEvidenceText(candidate);
  const evidenceTokens = uniqueTokens(evidence);
  if (evidenceTokens.length < 2) return false;

  const coverage = computeFragranceIdentityCoverage(brand, name, candidate);
  return coverage < 0.34;
}

export function scoreProcessedSerperCandidate(input: {
  brand: string;
  name: string;
  removeBackground: boolean;
  serperCandidate: Pick<SerperImageCandidate, "imageUrl" | "title" | "source" | "score">;
  processed: ProcessedCandidateSnapshot;
}): number {
  const identityCoverage = computeFragranceIdentityCoverage(input.brand, input.name, input.serperCandidate);
  const width = input.processed.width ?? 0;
  const height = input.processed.height ?? 0;
  const minEdge = Math.min(width || 0, height || 0);
  const aspect = width > 0 && height > 0 ? width / height : 1;

  let score = Number.isFinite(input.serperCandidate.score) ? input.serperCandidate.score : 0;
  score += identityCoverage * 12;

  if (minEdge >= 640) score += 2;
  else if (minEdge >= 520) score += 1;
  else if (minEdge > 0 && minEdge < 360) score -= 2;

  if (aspect >= 0.55 && aspect <= 1.85) score += 0.6;
  else score -= 0.8;

  if (input.removeBackground) {
    if (input.processed.backgroundRemoved) score += 3;
    else score -= 3;
    if (input.processed.removeBgStatus === "fallback") score -= 2;
  }

  return score;
}
