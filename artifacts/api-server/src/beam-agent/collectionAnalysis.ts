/**
 * Beam Agent — deterministic collection intelligence.
 *
 * PURE + dependency-free so it unit-tests in isolation with
 * `node --experimental-strip-types --test`. Given the user's OWNED vault (the
 * real, crowd-voted families/accords/notes/performance that ship on each
 * `user_fragrances` row), it produces a SCIENTIFIC, evidence-gated report the
 * Beam agent answers "what's in my collection / what are my gaps" from — instead
 * of free-styling a guess off a vault summary.
 *
 * Design principles (why this is "valid points only", not vibes):
 *   1. Every claim is computed from real fields, never invented.
 *   2. Every point carries its EVIDENCE ("0 of 11 analyzable bottles cover …").
 *   3. Sparse/unenriched bottles are gated OUT by `sourceConfidence` before any
 *      math runs, and the report states how much of the vault it could actually
 *      assess (`analysisConfidence`). When too little is analyzable we return
 *      `reliable: false` and assert NO gaps — absence-of-evidence is reported as
 *      such, never as evidence-of-absence.
 *   4. A "gap" is only emitted when the analyzable subset genuinely fails to
 *      cover a named, documented occasion/season slot — not when the model feels
 *      like naming something.
 *
 * It intentionally does NOT use the 6-axis keyword scent_vector: that signal is
 * not carried on owned vault items in this layer, and the repo's own audits flag
 * it as the weakest link. Families + accords are voted catalog data and far more
 * trustworthy for coverage math.
 */

/** One owned fragrance, normalized to the fields this engine reasons over. */
export type CollectionItem = {
  id: string;
  name: string;
  brand?: string;
  /** Olfactory families, free-form casing — normalized internally. */
  families: string[];
  /** Voted/parsed accords — normalized internally. */
  accords: string[];
  /** Flattened note tokens (top+heart+base) — normalized internally. */
  notes: string[];
  /** Raw longevity signal: hours number, 0..10 score, or a word ("strong"). */
  longevity?: number | string;
  /** Raw sillage/projection signal: 0..10 score or a word ("intimate"). */
  sillage?: number | string;
  /**
   * 0..1 confidence that the underlying record is real/complete. Items below
   * `MIN_SOURCE_CONFIDENCE` (or with no descriptive tokens at all) are excluded
   * from the analyzable subset so a placeholder never fabricates a signal.
   */
  sourceConfidence?: number;
};

export type DiversityGrade = "narrow" | "focused" | "balanced" | "broad";
export type GapSeverity = "high" | "medium" | "low";
export type AnalysisConfidenceLabel = "low" | "medium" | "high";

export type FamilyShare = { family: string; count: number; share: number };
export type SignatureSignal = { kind: "accord" | "note"; label: string; count: number; share: number };
export type CoverageExemplar = { id: string; name: string };
export type CoverageSlotResult = {
  slot: string;
  label: string;
  description: string;
  covered: boolean;
  exemplars: CoverageExemplar[];
};
export type RedundancyCluster = {
  members: CoverageExemplar[];
  similarity: number;
  band: "near-duplicate" | "very similar";
  sharedTraits: string[];
};
export type CollectionGap = {
  kind: "occasion_season" | "family" | "redundancy";
  label: string;
  evidence: string;
  severity: GapSeverity;
  /** 0..1 — how much we trust this point, folding in analysis coverage. */
  confidence: number;
};

export type CollectionAnalysis = {
  vaultSize: number;
  analyzableCount: number;
  /** analyzableCount / vaultSize, 0..1. */
  analysisConfidence: number;
  analysisConfidenceLabel: AnalysisConfidenceLabel;
  /** True only when there is enough analyzable data to assert gaps honestly. */
  reliable: boolean;
  /** Plain-language note on the data quality behind this report. */
  dataQualityNote: string;
  families: {
    dominant: string | null;
    distribution: FamilyShare[];
    /** 0..1 normalized diversity (1 - Herfindahl), higher = more varied. */
    diversityScore: number;
    diversityGrade: DiversityGrade;
  };
  /** Honest version of the "recurring molecule" claim: share-thresholded. */
  signatureSignals: SignatureSignal[];
  coverage: {
    covered: CoverageSlotResult[];
    gaps: CoverageSlotResult[];
  };
  redundancy: {
    clusters: RedundancyCluster[];
    note: string | null;
  };
  /** Ranked, de-duplicated, evidence-bearing gap list. */
  gaps: CollectionGap[];
  /** One deterministic, evidence-grounded headline paragraph. */
  summary: string;
};

// ----------------------------------------------------------------------------
// Tunable thresholds — named so the math is auditable, not magic numbers.
// ----------------------------------------------------------------------------

/** Records below this `sourceConfidence` are excluded from analysis. */
const MIN_SOURCE_CONFIDENCE = 0.5;
/** Need at least this many analyzable bottles before asserting gaps at all. */
const MIN_ANALYZABLE_FOR_GAPS = 3;
/** And at least this fraction of the vault analyzable for a reliable verdict. */
const MIN_ANALYZABLE_FRACTION = 0.5;
/** An accord/note is a "signature" only when it spans at least this share. */
const SIGNATURE_SHARE = 0.4;
/** …and appears in at least this many analyzable bottles (guards tiny vaults). */
const SIGNATURE_MIN_COUNT = 2;
/** Jaccard ≥ this on the combined trait set ⇒ "very similar". */
const REDUNDANCY_SIMILAR = 0.5;
/** …and ≥ this ⇒ "near-duplicate". */
const REDUNDANCY_DUPLICATE = 0.7;

/**
 * Documented occasion/season coverage slots. A vault "covers" a slot when at
 * least one analyzable bottle qualifies. These sets are drawn from the app's own
 * accord vocabulary (`scentParser.ts` ACCORD_KEYWORDS) plus family names, so the
 * taxonomy matches the rest of the system rather than inventing a new one.
 *
 * `requireStrong`/`requireSoft` gate on parsed performance so an "evening
 * statement" slot is not claimed by a wisp of incense on a 2-hour skin scent.
 */
type CoverageSlotDef = {
  slot: string;
  label: string;
  description: string;
  traits: string[];
  requireStrong?: boolean;
  requireSoft?: boolean;
};

const COVERAGE_SLOTS: ReadonlyArray<CoverageSlotDef> = [
  {
    slot: "fresh_daytime",
    label: "Fresh daytime / warm weather",
    description: "Bright, airy scents for heat, daytime, and casual wear.",
    traits: ["citrus", "fresh", "aquatic", "marine", "green", "aromatic", "fruity", "tropical", "mineral", "salty"],
  },
  {
    slot: "warm_cold_weather",
    label: "Warm & cozy / cold weather",
    description: "Enveloping scents that hold up in cold, dry air.",
    traits: ["amber", "oriental", "woody", "spicy", "gourmand", "resinous", "balsamic", "sweet", "creamy", "tobacco", "incense", "boozy"],
  },
  {
    slot: "office_clean",
    label: "Office / clean & inoffensive",
    description: "Restrained, clean scents safe for close quarters.",
    traits: ["fresh", "musk", "powdery", "citrus", "aromatic", "green", "clean", "soapy"],
    requireSoft: true,
  },
  {
    slot: "evening_statement",
    label: "Evening / statement",
    description: "Bold, long-lasting scents that project for a night out.",
    traits: ["amber", "oriental", "leathery", "smoky", "spicy", "woody", "incense", "tobacco", "animalic", "oud"],
    requireStrong: true,
  },
  {
    slot: "floral_romantic",
    label: "Floral / romantic",
    description: "Floral-forward or soft romantic profiles.",
    traits: ["floral", "powdery", "rose", "jasmine", "iris", "violet"],
  },
  {
    slot: "woody_earthy",
    label: "Woody / earthy",
    description: "Grounded woody, mossy, or earthy character.",
    traits: ["woody", "earthy", "mossy", "chypre", "fougere", "dry", "cedar", "vetiver", "sandalwood"],
  },
  {
    slot: "gourmand_sweet",
    label: "Gourmand / sweet",
    description: "Edible sweet or dessert-like profiles.",
    traits: ["gourmand", "sweet", "creamy", "vanilla", "caramel", "chocolate", "boozy"],
  },
];

// ----------------------------------------------------------------------------
// Normalization helpers
// ----------------------------------------------------------------------------

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function cleanTokens(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const t = norm(raw);
    if (!t || t === "unknown" || t === "unknown family") continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** All descriptive trait tokens for a bottle, de-duplicated. */
function traitSet(item: NormalizedItem): Set<string> {
  return new Set<string>([...item.families, ...item.accords, ...item.notes]);
}

const STRONG_WORDS = /\b(strong|heavy|beast|enormous|huge|powerful|monster|loud|long[\s-]?lasting|eternal|very\s+long)\b/i;
const SOFT_WORDS = /\b(weak|soft|light|intimate|skin|quiet|subtle|moderate|modest|short|fleeting)\b/i;

/**
 * Map a raw longevity/sillage signal to a 0..1 strength, or null when unknown.
 * Numbers ≤ 10 are treated as a 0..10 score; larger numbers as hours (≈12h max).
 */
function parseStrength(raw: number | string | undefined): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw <= 0) return 0;
    if (raw <= 10) return Math.min(1, raw / 10);
    return Math.min(1, raw / 12);
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    const numeric = Number(s);
    if (Number.isFinite(numeric)) return parseStrength(numeric);
    if (STRONG_WORDS.test(s)) return 0.85;
    if (SOFT_WORDS.test(s)) return 0.3;
    if (/\bmoderate|medium|average\b/i.test(s)) return 0.55;
  }
  return null;
}

type NormalizedItem = {
  id: string;
  name: string;
  brand: string;
  families: string[];
  accords: string[];
  notes: string[];
  /** 0..1, or null when no performance signal at all. */
  strength: number | null;
  sourceConfidence: number;
  analyzable: boolean;
};

function normalizeItem(item: CollectionItem): NormalizedItem {
  const families = cleanTokens(item.families);
  const accords = cleanTokens(item.accords);
  const notes = cleanTokens(item.notes);
  const conf =
    typeof item.sourceConfidence === "number" && Number.isFinite(item.sourceConfidence)
      ? Math.min(1, Math.max(0, item.sourceConfidence))
      : 0;
  const long = parseStrength(item.longevity);
  const sill = parseStrength(item.sillage);
  const strengthVals = [long, sill].filter((n): n is number => n !== null);
  const strength = strengthVals.length ? Math.max(...strengthVals) : null;
  const hasSignal = families.length + accords.length + notes.length > 0;
  return {
    id: item.id,
    name: item.name,
    brand: item.brand ?? "",
    families,
    accords,
    notes,
    strength,
    sourceConfidence: conf,
    analyzable: hasSignal && conf >= MIN_SOURCE_CONFIDENCE,
  };
}

function exemplar(item: NormalizedItem): CoverageExemplar {
  return { id: item.id, name: item.name };
}

// ----------------------------------------------------------------------------
// Sub-analyses
// ----------------------------------------------------------------------------

function analyzeFamilies(items: NormalizedItem[]): CollectionAnalysis["families"] {
  const counts = new Map<string, number>();
  for (const item of items) {
    // Count each bottle once per distinct family it carries.
    for (const fam of new Set(item.families)) {
      counts.set(fam, (counts.get(fam) ?? 0) + 1);
    }
  }
  const totalTags = [...counts.values()].reduce((a, b) => a + b, 0);
  const distribution: FamilyShare[] = [...counts.entries()]
    .map(([family, count]) => ({ family, count, share: totalTags ? round2(count / totalTags) : 0 }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));

  // Herfindahl-Hirschman concentration over family shares → normalized diversity.
  const hhi = distribution.reduce((acc, d) => acc + (totalTags ? d.count / totalTags : 0) ** 2, 0);
  const k = distribution.length;
  // Normalize so a perfectly even spread → 1 and a single family → 0.
  const diversityScore = k > 1 ? round2((1 - hhi) / (1 - 1 / k)) : 0;
  const diversityGrade: DiversityGrade =
    k <= 1 ? "narrow" : diversityScore >= 0.75 ? "broad" : diversityScore >= 0.5 ? "balanced" : diversityScore >= 0.25 ? "focused" : "narrow";

  return {
    dominant: distribution[0]?.family ?? null,
    distribution,
    diversityScore,
    diversityGrade,
  };
}

function analyzeSignature(items: NormalizedItem[]): SignatureSignal[] {
  const total = items.length;
  if (!total) return [];
  const tally = (pick: (i: NormalizedItem) => string[], kind: "accord" | "note"): SignatureSignal[] => {
    const counts = new Map<string, number>();
    for (const item of items) {
      for (const tok of new Set(pick(item))) counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ kind, label, count, share: round2(count / total) }))
      .filter((s) => s.share >= SIGNATURE_SHARE && s.count >= SIGNATURE_MIN_COUNT)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  // Accords are the more trustworthy "character" signal; notes corroborate.
  return [...tally((i) => i.accords, "accord"), ...tally((i) => i.notes, "note")].slice(0, 6);
}

function analyzeCoverage(items: NormalizedItem[]): CollectionAnalysis["coverage"] {
  const covered: CoverageSlotResult[] = [];
  const gaps: CoverageSlotResult[] = [];
  for (const def of COVERAGE_SLOTS) {
    const traitSetDef = new Set(def.traits);
    const exemplars: CoverageExemplar[] = [];
    for (const item of items) {
      const traits = traitSet(item);
      let matches = false;
      for (const t of traits) {
        if (traitSetDef.has(t)) {
          matches = true;
          break;
        }
      }
      if (!matches) continue;
      // Performance gates: only apply when the bottle carries a strength signal;
      // unknown strength does not disqualify (honest degradation, not a guess).
      if (def.requireStrong && item.strength !== null && item.strength < 0.5) continue;
      if (def.requireSoft && item.strength !== null && item.strength > 0.8) continue;
      exemplars.push(exemplar(item));
    }
    const result: CoverageSlotResult = {
      slot: def.slot,
      label: def.label,
      description: def.description,
      covered: exemplars.length > 0,
      exemplars: exemplars.slice(0, 4),
    };
    (result.covered ? covered : gaps).push(result);
  }
  return { covered, gaps };
}

/** Jaccard similarity over the combined trait set of two bottles. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function analyzeRedundancy(items: NormalizedItem[]): CollectionAnalysis["redundancy"] {
  const traitSets = items.map((i) => traitSet(i));
  // Union-Find to merge transitively-similar bottles into clusters.
  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const pairSim = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = jaccard(traitSets[i], traitSets[j]);
      if (sim >= REDUNDANCY_SIMILAR) {
        union(i, j);
        pairSim.set(`${i}:${j}`, sim);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }
  const clusters: RedundancyCluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // Cluster similarity = max pairwise sim, and shared traits = intersection.
    let maxSim = 0;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const key = `${Math.min(idxs[a], idxs[b])}:${Math.max(idxs[a], idxs[b])}`;
        maxSim = Math.max(maxSim, pairSim.get(key) ?? jaccard(traitSets[idxs[a]], traitSets[idxs[b]]));
      }
    }
    let shared: Set<string> | null = null;
    for (const idx of idxs) {
      shared = shared === null ? new Set(traitSets[idx]) : new Set([...shared].filter((t) => traitSets[idx].has(t)));
    }
    clusters.push({
      members: idxs.map((idx) => exemplar(items[idx])),
      similarity: round2(maxSim),
      band: maxSim >= REDUNDANCY_DUPLICATE ? "near-duplicate" : "very similar",
      sharedTraits: shared ? [...shared].sort().slice(0, 6) : [],
    });
  }
  clusters.sort((a, b) => b.similarity - a.similarity || b.members.length - a.members.length);
  const clustered = clusters.reduce((acc, c) => acc + c.members.length, 0);
  const note =
    clusters.length === 0
      ? null
      : `${clustered} of ${items.length} analyzable bottles fall into ${clusters.length} closely-overlapping cluster${clusters.length > 1 ? "s" : ""}.`;
  return { clusters, note };
}

// ----------------------------------------------------------------------------
// Gap synthesis + summary
// ----------------------------------------------------------------------------

function buildGaps(
  coverage: CollectionAnalysis["coverage"],
  redundancy: CollectionAnalysis["redundancy"],
  families: CollectionAnalysis["families"],
  analyzableCount: number,
  analysisConfidence: number,
): CollectionGap[] {
  const gaps: CollectionGap[] = [];
  const gapConfidence = round2(0.5 + 0.5 * analysisConfidence);

  for (const slot of coverage.gaps) {
    // Evening/floral absences are higher-impact for an "all-rounder" than niche ones.
    const severity: GapSeverity =
      slot.slot === "evening_statement" || slot.slot === "fresh_daytime" || slot.slot === "warm_cold_weather"
        ? "high"
        : slot.slot === "office_clean" || slot.slot === "floral_romantic"
          ? "medium"
          : "low";
    gaps.push({
      kind: "occasion_season",
      label: `No ${slot.label.toLowerCase()} coverage`,
      evidence: `0 of ${analyzableCount} analyzable bottles cover "${slot.label}" (${slot.description})`,
      severity,
      confidence: gapConfidence,
    });
  }

  // Over-concentration is a diversification gap, only when diversity is low AND
  // there is real redundancy (avoids nagging a deliberately tight collection).
  if (families.diversityGrade === "narrow" && redundancy.clusters.length > 0) {
    const top = redundancy.clusters[0];
    gaps.push({
      kind: "redundancy",
      label: "Collection is concentrated / redundant",
      evidence:
        `${redundancy.note ?? ""} Dominant family "${families.dominant}".` +
        (top.sharedTraits.length ? ` Closest cluster shares: ${top.sharedTraits.join(", ")}.` : ""),
      severity: "medium",
      confidence: gapConfidence,
    });
  }

  const order: Record<GapSeverity, number> = { high: 0, medium: 1, low: 2 };
  return gaps.sort((a, b) => order[a.severity] - order[b.severity]);
}

function buildSummary(a: Omit<CollectionAnalysis, "summary">): string {
  if (a.vaultSize === 0) return "Your vault is empty — add a few fragrances and I can map its character and gaps.";
  if (!a.reliable) {
    return (
      `I can only reliably read ${a.analyzableCount} of your ${a.vaultSize} bottles right now ` +
      `(the rest are missing notes/accords). That's too little to call out real gaps without guessing — ` +
      `I'd rather enrich those first than invent a verdict.`
    );
  }
  const fam = a.families.dominant ? `leans ${a.families.dominant}` : "has no dominant family";
  const div = `${a.families.diversityGrade} diversity`;
  const coveredCount = a.coverage.covered.length;
  const slotTotal = coveredCount + a.coverage.gaps.length;
  const topGap = a.gaps[0];
  const gapClause = topGap ? ` Biggest gap: ${topGap.label.toLowerCase()}.` : " No major coverage gaps.";
  return (
    `Across ${a.analyzableCount} analyzable bottles your collection ${fam} with ${div}, ` +
    `covering ${coveredCount}/${slotTotal} core occasion–season slots.${gapClause}`
  );
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

/**
 * Analyze an owned collection into a deterministic, evidence-gated report. Pure:
 * same input → same output, no I/O. Safe on empty/sparse input.
 */
export function analyzeCollection(rawItems: CollectionItem[]): CollectionAnalysis {
  const all = Array.isArray(rawItems) ? rawItems.map(normalizeItem) : [];
  const vaultSize = all.length;
  const analyzable = all.filter((i) => i.analyzable);
  const analyzableCount = analyzable.length;
  const analysisConfidence = vaultSize ? round2(analyzableCount / vaultSize) : 0;
  const analysisConfidenceLabel: AnalysisConfidenceLabel =
    analysisConfidence >= 0.75 ? "high" : analysisConfidence >= 0.4 ? "medium" : "low";
  const reliable =
    analyzableCount >= MIN_ANALYZABLE_FOR_GAPS && analysisConfidence >= MIN_ANALYZABLE_FRACTION;

  const families = analyzeFamilies(analyzable);
  const signatureSignals = analyzeSignature(analyzable);
  const coverage = analyzeCoverage(analyzable);
  const redundancy = analyzeRedundancy(analyzable);
  const gaps = reliable
    ? buildGaps(coverage, redundancy, families, analyzableCount, analysisConfidence)
    : [];

  const dataQualityNote = !vaultSize
    ? "No fragrances in the vault."
    : reliable
      ? `${analyzableCount} of ${vaultSize} bottles had enough data to analyze (${Math.round(analysisConfidence * 100)}% coverage).`
      : `Only ${analyzableCount} of ${vaultSize} bottles had enough data to analyze — too few to assert gaps without guessing. Enrich more bottles for a confident verdict.`;

  const partial: Omit<CollectionAnalysis, "summary"> = {
    vaultSize,
    analyzableCount,
    analysisConfidence,
    analysisConfidenceLabel,
    reliable,
    dataQualityNote,
    families,
    signatureSignals,
    coverage,
    redundancy,
    gaps,
  };
  return { ...partial, summary: buildSummary(partial) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
