/**
 * Pure, dependency-free enrichment-completeness logic.
 *
 * This is the single server-side source of truth for "is a fragrance's
 * enrichment actually complete enough to surface to a user / notify about / let
 * the agent recommend?". It deliberately mirrors the SPA predicate
 * (`scent-cast/src/lib/fragranceApi.ts:isSourceCoverageComplete`) so the backend
 * gate and the frontend gate can never drift: a fragrance is only "complete"
 * once BOTH community sources resolved (Basenotes + Fragrantica) AND the derived
 * metrics are full. Anything weaker is "partial"; no usable signal at all is
 * "none".
 *
 * Why this exists: the curation/enrichment worker used to mark a job "completed"
 * the moment the engine returned a single note. That thin bar is what let an
 * under-enriched fragrance ("Unknown" year/gender/concentration, no notes, no
 * image) be flagged `ready`, force-opened on app load, and pushed as a
 * notification. Everything that decides "ready" now routes through
 * `evaluateSourceCoverage` here.
 *
 * Nothing in this file does I/O, touches the DB, or reads runtime config, so it
 * is exhaustively unit-tested in enrichmentCompleteness.test.ts.
 */

/** Coarse enrichment level, ordered none < partial < full. */
export type EnrichmentLevel = "none" | "partial" | "full";

/**
 * The subset of the engine's `/details` `source_coverage` object we read. The
 * engine sets more keys than this; we type only what the completeness rule
 * consults and tolerate the rest (`additionalProperties` ignored).
 */
export type EngineSourceCoverage = {
  basenotes?: boolean;
  fragrantica?: boolean;
  /** Engine's own "everything resolved" flag. */
  complete?: boolean;
  /** True once all four Fragrantica status-derived metric groups are present. */
  fragrantica_metrics_complete?: boolean;
  /** "none" | "partial" | "full" | "complete" | "completed" (engine wording varies). */
  derived_metrics?: string | null;
};

/**
 * True when a `derived_metrics` marker string counts as complete. Mirrors the
 * SPA's `isDerivedMetricsCompleteFlag` exactly.
 */
export function isDerivedMetricsCompleteFlag(value: unknown): boolean {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return status === "complete" || status === "completed" || status === "full";
}

/**
 * Is this `source_coverage` complete? Identical rule to the SPA predicate:
 * Basenotes AND Fragrantica both resolved, AND (engine `complete` flag OR
 * `fragrantica_metrics_complete` OR a complete `derived_metrics` marker).
 */
export function isSourceCoverageComplete(coverage?: EngineSourceCoverage | null): boolean {
  if (!coverage) return false;
  return (
    coverage.basenotes === true &&
    coverage.fragrantica === true &&
    (coverage.complete === true ||
      coverage.fragrantica_metrics_complete === true ||
      isDerivedMetricsCompleteFlag(coverage.derived_metrics))
  );
}

/** True when the coverage shows at least one real community source resolved. */
function hasAnyCoverage(coverage?: EngineSourceCoverage | null): boolean {
  if (!coverage) return false;
  return (
    coverage.basenotes === true ||
    coverage.fragrantica === true ||
    coverage.complete === true ||
    coverage.fragrantica_metrics_complete === true ||
    isDerivedMetricsCompleteFlag(coverage.derived_metrics)
  );
}

/**
 * Collapse a `source_coverage` object (plus whether we actually obtained any
 * notes) into a single ordered `EnrichmentLevel`.
 *
 *   - "full"    → complete by the SPA rule;
 *   - "partial" → some coverage OR at least real notes, but not complete;
 *   - "none"    → nothing usable.
 *
 * `hasNotes` lets the caller treat "engine returned real notes but the coverage
 * object was absent/thin" as partial rather than none, so a job that produced
 * displayable data still climbs above "none".
 */
export function evaluateEnrichmentLevel(
  coverage: EngineSourceCoverage | null | undefined,
  hasNotes: boolean,
): EnrichmentLevel {
  if (isSourceCoverageComplete(coverage)) return "full";
  if (hasAnyCoverage(coverage) || hasNotes) return "partial";
  return "none";
}

/** True only for the terminal, surface-and-notify-eligible level. */
export function isEnrichmentComplete(level: EnrichmentLevel): boolean {
  return level === "full";
}

// --- bounded retry budget ----------------------------------------------------
//
// The worker must "keep researching until complete" WITHOUT hammering the paid
// engine forever. It retries a partial job on an exponential backoff for a
// bounded number of attempts, then gives up quietly (status "ignored" — never
// surfaced, never notified). These pure helpers decide the budget; the DB-backed
// worker (enrichmentProcessor.ts) tracks the attempt counter in job metadata.

/** Default ceiling on enrichment attempts before a partial job is abandoned. */
export const DEFAULT_MAX_ENRICHMENT_ATTEMPTS = 6;

/**
 * How many attempts to allow before giving up on an incomplete job. Reads
 * `BEAM_ENRICHMENT_MAX_ATTEMPTS`; falls back to the default for an unset or
 * non-positive value. Clamped to at least 1 so a job always runs once.
 */
export function maxEnrichmentAttempts(rawEnv?: string): number {
  const raw = Number(rawEnv);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_MAX_ENRICHMENT_ATTEMPTS;
}

/** True once a partial job has used up its attempt budget. */
export function enrichmentAttemptsExhausted(attempts: number, max: number): boolean {
  return attempts >= Math.max(1, max);
}

/**
 * Read the running attempt counter we stamp onto `enrichment_jobs.metadata_json`.
 * Tolerates a missing/garbage value (treated as 0) so a legacy row without the
 * field just starts counting from its next pass.
 */
export function readEnrichAttempts(metadata: Record<string, unknown> | null | undefined): number {
  const raw = (metadata ?? {})["enrichAttempts"];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
