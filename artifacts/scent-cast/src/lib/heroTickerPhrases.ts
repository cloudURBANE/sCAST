/**
 * Honest hero-ticker phrase selection (Phase 5).
 *
 * The home "signature profile" marquee used to assert signals off NAIVE math: a
 * top family by raw count, a "recurring molecule" the moment any note appeared
 * twice (`topCount > 1`), and a vector axis over a stale `>= 4.5` cutoff. A note
 * appearing twice across a 100-bottle vault was treated as a signature.
 *
 * This module rebuilds that selection on the SAME discipline as the backend
 * collection-intelligence engine
 * (`artifacts/api-server/src/beam-agent/collectionAnalysis.ts`):
 *
 *   1. Share-based thresholds, not raw counts. A note/accord is a "signature"
 *      only when it spans at least `SIGNATURE_SHARE` of the analyzable vault AND
 *      appears in at least `SIGNATURE_MIN_COUNT` bottles (the exact constants the
 *      engine uses for its honest "recurring molecule").
 *   2. Normalization + per-bottle dedup before counting, so one bottle listing a
 *      note twice counts once (matches the engine's `cleanTokens` + per-item Set).
 *   3. Data-quality gating. Sparse/placeholder bottles are excluded from the
 *      note/molecule signal up front: a bottle contributes to the note signal
 *      only when it carries descriptive note tokens, and — when per-row source
 *      coverage is present — only when that coverage is complete. If too little
 *      is analyzable, no signature is asserted (absence reported as such, never
 *      as evidence of absence) and the neutral fallback phrases are used.
 *   4. The vector-axis cutoff is realigned to the post-WS-7 scale: an axis must
 *      reach `VECTOR_TRAIT_THRESHOLD` (3 of 10, the present-trait magnitude the
 *      rest of the app now uses) before the vault is described by it.
 *
 * PURE + framework-free so it unit-tests in isolation with
 * `node --experimental-strip-types --test`, away from the App.tsx component tree.
 */

import { isSourceCoverageComplete, type SourceCoverage } from "./fragranceApi.ts";

// The hero phrase shape is intentionally re-declared here (rather than imported
// from App.tsx) so this stays a leaf module with no component dependency. It is
// structurally identical to App.tsx's `HeroPhrase` / `HeroPhraseSegment`.
export interface HeroPhraseSegment {
  text: string;
  /** Exactly one segment per phrase carries the gold center-sheen highlight. */
  key?: boolean;
}
export type HeroPhrase = HeroPhraseSegment[];

/** The subset of the vault item shape this selector reasons over. */
export type HeroTickerItem = {
  family?: string;
  notes?: string[];
  season?: string;
  brand?: string;
  scent_vector?: {
    freshness: number;
    sweetness: number;
    woodiness: number;
    spice: number;
    warmth: number;
    musk: number;
  } | null;
  source_coverage?: SourceCoverage | null;
};

// ----------------------------------------------------------------------------
// Tunable thresholds — mirrored from collectionAnalysis.ts so the home ticker
// and the Beam analysis engine agree on what counts as a "signature".
// ----------------------------------------------------------------------------

/**
 * A note is a "recurring molecule" only when it spans at least this share of the
 * analyzable vault. Mirrors `SIGNATURE_SHARE` in collectionAnalysis.ts.
 */
export const SIGNATURE_SHARE = 0.4;
/**
 * …and appears in at least this many analyzable bottles (guards tiny vaults).
 * Mirrors `SIGNATURE_MIN_COUNT` in collectionAnalysis.ts.
 */
export const SIGNATURE_MIN_COUNT = 2;
/**
 * Need at least this many analyzable bottles before asserting a note signature
 * at all. Mirrors `MIN_ANALYZABLE_FOR_GAPS` in collectionAnalysis.ts so the
 * supporting set is never trivial.
 */
export const MIN_ANALYZABLE_FOR_SIGNATURE = 3;
/**
 * A profile-vector axis must reach this magnitude (of the 0..10 range) before
 * the vault is described by it. Mirrors WS-7's `VECTOR_TRAIT_THRESHOLD` (3 of
 * 10) in WardrobeContext / the scent-weather engine — the present-trait cutoff
 * the rest of the app now uses (replaces the stale pre-WS-7 `>= 4.5`).
 */
export const VECTOR_TRAIT_THRESHOLD = 3;

const NEUTRAL_FALLBACK: HeroPhrase[] = [
  [{ text: "Add scents to your vault and unlock deeper discovery" }],
  [{ text: "Atmospheric nuance is analyzed to guide each wear" }],
  [{ text: "Your signature profile is syncing with the current environment" }],
];

const FILLER_PHRASES: HeroPhrase[] = [
  [{ text: "Olfactory intelligence active" }],
  [{ text: "Atmospheric pairing in progress" }],
];

// ----------------------------------------------------------------------------
// Normalization helpers — mirror collectionAnalysis.ts `norm` / `cleanTokens`.
// ----------------------------------------------------------------------------

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Lowercased, trimmed, de-duplicated descriptive tokens for one bottle. */
function cleanTokens(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const t = norm(raw);
    if (!t || t === "unknown") continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * A bottle contributes to the note/molecule signal only when it carries
 * descriptive note tokens AND, when per-row source coverage is present, that
 * coverage is complete. Legacy rows with no coverage object are not over-gated
 * (honest degradation): they still count if they carry real notes, matching the
 * engine's "exclude bottles with no descriptive tokens" floor.
 */
function isNoteSignalAnalyzable(item: HeroTickerItem): boolean {
  if (cleanTokens(item.notes).length === 0) return false;
  const coverage = item.source_coverage;
  if (coverage && Object.keys(coverage).length > 0) {
    return isSourceCoverageComplete(coverage);
  }
  return true;
}

const VECTOR_DIMS = [
  "freshness",
  "sweetness",
  "woodiness",
  "spice",
  "warmth",
  "musk",
] as const;

const VECTOR_LABELS: Record<(typeof VECTOR_DIMS)[number], string> = {
  freshness: "fresh and airy",
  sweetness: "sweet and gourmand",
  woodiness: "woody and grounded",
  spice: "spiced and bold",
  warmth: "warm and enveloping",
  musk: "musky and skin-close",
};

/**
 * Build the home "signature profile" ticker on honest, share-based math.
 * Pure: same input → same output. Returns the same `HeroPhrase[]` shape and the
 * same neutral fallback the original used.
 */
export function buildHeroTickerPhrases(items: HeroTickerItem[]): HeroPhrase[] {
  if (!items.length) return NEUTRAL_FALLBACK;

  const phrases: HeroPhrase[] = [];

  // --- Dominant family (count each bottle's family once). --------------------
  const familyCounts = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    const fam = typeof item.family === "string" ? item.family.trim() : "";
    if (!fam) continue;
    const key = fam.toLowerCase();
    const entry = familyCounts.get(key);
    if (entry) entry.count += 1;
    else familyCounts.set(key, { label: fam, count: 1 });
  }
  const topFamily = [...familyCounts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  )[0];
  if (topFamily) {
    phrases.push([
      { text: "Predominantly " },
      { text: topFamily.label.toLowerCase(), key: true },
      { text: " olfactory signature" },
    ]);
  }

  // --- Recurring molecule (share-thresholded over the analyzable subset). ----
  // Only bottles with real, complete-coverage notes feed this signal, and the
  // supporting set must be non-trivial; otherwise no molecule is asserted.
  const analyzableForNotes = items.filter(isNoteSignalAnalyzable);
  if (analyzableForNotes.length >= MIN_ANALYZABLE_FOR_SIGNATURE) {
    const noteCounts = new Map<string, number>();
    for (const item of analyzableForNotes) {
      // cleanTokens already de-dupes within a bottle, so one bottle listing a
      // note twice counts once.
      for (const token of cleanTokens(item.notes)) {
        noteCounts.set(token, (noteCounts.get(token) ?? 0) + 1);
      }
    }
    const total = analyzableForNotes.length;
    const signature = [...noteCounts.entries()]
      .map(([label, count]) => ({ label, count, share: count / total }))
      .filter((s) => s.share >= SIGNATURE_SHARE && s.count >= SIGNATURE_MIN_COUNT)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
    if (signature) {
      phrases.push([
        { text: "Recurring molecule detected: " },
        { text: signature.label, key: true },
      ]);
    }
  }

  // --- Dominant vector axis (post-WS-7 present-trait threshold). --------------
  const vectors = items
    .map((i) => i.scent_vector)
    .filter((v): v is NonNullable<HeroTickerItem["scent_vector"]> => Boolean(v));
  if (vectors.length > 0) {
    const top = VECTOR_DIMS.map((d) => ({
      d,
      avg: vectors.reduce((s, v) => s + (Number.isFinite(v[d]) ? v[d] : 0), 0) / vectors.length,
    })).sort((a, b) => b.avg - a.avg)[0];
    if (top.avg >= VECTOR_TRAIT_THRESHOLD) {
      phrases.push([
        { text: "Your vault reads " },
        { text: VECTOR_LABELS[top.d], key: true },
      ]);
    }
  }

  // --- Dominant season (share-thresholded, not raw "appears twice"). ---------
  const seasonItems = items.filter(
    (i) => typeof i.season === "string" && i.season.trim().length > 0,
  );
  if (seasonItems.length >= MIN_ANALYZABLE_FOR_SIGNATURE) {
    const seasonCounts = new Map<string, { label: string; count: number }>();
    for (const item of seasonItems) {
      const season = (item.season as string).trim();
      const key = season.toLowerCase();
      const entry = seasonCounts.get(key);
      if (entry) entry.count += 1;
      else seasonCounts.set(key, { label: season, count: 1 });
    }
    const total = seasonItems.length;
    const topSeason = [...seasonCounts.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label),
    )[0];
    if (topSeason && topSeason.count / total >= SIGNATURE_SHARE && topSeason.count >= SIGNATURE_MIN_COUNT) {
      phrases.push([
        { text: "Calibrated for " },
        { text: topSeason.label.toLowerCase(), key: true },
        { text: " conditions" },
      ]);
    }
  }

  // --- House breadth (unchanged: a simple, honest distinct-brand count). ------
  const brands = new Set(
    items
      .map((i) => (typeof i.brand === "string" ? i.brand.trim() : ""))
      .filter(Boolean),
  );
  if (brands.size > 1) {
    phrases.push([
      { text: `${brands.size} houses`, key: true },
      { text: " represented in your collection" },
    ]);
  }

  if (phrases.length < 3) phrases.push(...FILLER_PHRASES);

  return phrases;
}
