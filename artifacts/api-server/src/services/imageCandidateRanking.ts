import type { RemoveBgStatus } from "./bgService";
import {
  concentrationsAmbiguouslyAdjacent,
  concentrationsConflict,
  detectConcentration,
} from "./concentrationConflict.ts";
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

type ScoreProcessedSerperCandidateInput = {
  brand: string;
  name: string;
  removeBackground: boolean;
  serperCandidate: Pick<SerperImageCandidate, "imageUrl" | "title" | "source" | "score">;
  processed: ProcessedCandidateSnapshot;
};

export type ImageCandidateScoreBreakdown = {
  serperScore: number;
  identityCoverage: number;
  identityBonus: number;
  phraseBonus: number;
  concentrationPenalty: number;
  minEdge: number;
  minEdgeBonus: number;
  aspectRatio: number;
  aspectBonus: number;
  backgroundRemovalBonus: number;
  fallbackPenalty: number;
  total: number;
};

// Reward a candidate whose evidence contains the full fragrance name as a
// contiguous phrase (e.g. "Baccarat Rouge 540") over one that merely scatters
// the same tokens. Single-token names carry no sequence information, so they
// earn nothing here and the score is unchanged for them.
const PHRASE_MATCH_BONUS = 2;

function phraseSequenceBonus(name: string, evidence: string): number {
  const nameTokens = tokenize(name);
  if (nameTokens.length < 2) return 0;
  const phrase = nameTokens.join(" ");
  const haystack = tokenize(evidence).join(" ");
  return haystack.includes(phrase) ? PHRASE_MATCH_BONUS : 0;
}

// A confident concentration mismatch (target EDP, candidate EDT, …) is a hard
// identity failure even when brand/line tokens line up, so the penalty is large
// enough to sink an otherwise-strong candidate below any clean alternative.
const CONCENTRATION_CONFLICT_PENALTY = -10;
// An *ambiguous* mismatch (bare "Parfum" vs "Eau de Parfum", e.g. "Le Parfum")
// only demotes the candidate rather than disqualifying it — see
// concentrationsAmbiguouslyAdjacent (BE-8).
const CONCENTRATION_AMBIGUOUS_PENALTY = -3;

function concentrationPenaltyFor(
  brand: string,
  name: string,
  candidate: Pick<SerperImageCandidate, "imageUrl" | "title" | "source">,
): number {
  const target = detectConcentration(`${brand} ${name}`);
  if (target === "Unknown") return 0;
  const candidateConcentration = detectConcentration(candidateEvidenceText(candidate));
  if (!concentrationsConflict(target, candidateConcentration)) return 0;
  return concentrationsAmbiguouslyAdjacent(target, candidateConcentration)
    ? CONCENTRATION_AMBIGUOUS_PENALTY
    : CONCENTRATION_CONFLICT_PENALTY;
}

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
  // A confident concentration mismatch is disqualifying on its own, independent
  // of token coverage — an "EDT" packshot must never satisfy an "EDP" request
  // even when every other token (brand, line, flanker) lines up perfectly. An
  // *ambiguous* mismatch (the softer CONCENTRATION_AMBIGUOUS_PENALTY, e.g. bare
  // "Parfum" vs "Eau de Parfum") is only demoted via penalty, never hard-skipped,
  // so the correct packshot for "Le Parfum" survives (BE-8).
  if (concentrationPenaltyFor(brand, name, candidate) <= CONCENTRATION_CONFLICT_PENALTY) return true;

  const targetTokens = uniqueTokens(`${brand} ${name}`);
  if (targetTokens.length < 2) return false;

  const evidence = candidateEvidenceText(candidate);
  const evidenceTokens = uniqueTokens(evidence);
  if (evidenceTokens.length < 2) return false;

  const coverage = computeFragranceIdentityCoverage(brand, name, candidate);
  return coverage < 0.34;
}

export function scoreProcessedSerperCandidateBreakdown(
  input: ScoreProcessedSerperCandidateInput,
): ImageCandidateScoreBreakdown {
  const identityCoverage = computeFragranceIdentityCoverage(input.brand, input.name, input.serperCandidate);
  const width = input.processed.width ?? 0;
  const height = input.processed.height ?? 0;
  const minEdge = Math.min(width || 0, height || 0);
  const aspect = width > 0 && height > 0 ? width / height : 1;

  const serperScore = Number.isFinite(input.serperCandidate.score) ? input.serperCandidate.score : 0;
  const identityBonus = identityCoverage * 12;
  const phraseBonus = phraseSequenceBonus(input.name, candidateEvidenceText(input.serperCandidate));
  const concentrationPenalty = concentrationPenaltyFor(input.brand, input.name, input.serperCandidate);

  let minEdgeBonus = 0;
  if (minEdge >= 640) minEdgeBonus = 2;
  else if (minEdge >= 520) minEdgeBonus = 1;
  else if (minEdge > 0 && minEdge < 360) minEdgeBonus = -2;

  const aspectBonus = aspect >= 0.55 && aspect <= 1.85 ? 0.6 : -0.8;

  let backgroundRemovalBonus = 0;
  let fallbackPenalty = 0;
  if (input.removeBackground) {
    backgroundRemovalBonus = input.processed.backgroundRemoved ? 3 : -3;
    fallbackPenalty = input.processed.removeBgStatus === "fallback" ? -2 : 0;
  }

  return {
    serperScore,
    identityCoverage,
    identityBonus,
    phraseBonus,
    concentrationPenalty,
    minEdge,
    minEdgeBonus,
    aspectRatio: aspect,
    aspectBonus,
    backgroundRemovalBonus,
    fallbackPenalty,
    total:
      serperScore +
      identityBonus +
      phraseBonus +
      concentrationPenalty +
      minEdgeBonus +
      aspectBonus +
      backgroundRemovalBonus +
      fallbackPenalty,
  };
}

export function scoreProcessedSerperCandidate(input: ScoreProcessedSerperCandidateInput): number {
  return scoreProcessedSerperCandidateBreakdown(input).total;
}
