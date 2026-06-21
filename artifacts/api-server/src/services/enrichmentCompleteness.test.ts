import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateEnrichmentLevel,
  isSourceCoverageComplete,
  isDerivedMetricsCompleteFlag,
  isEnrichmentComplete,
  maxEnrichmentAttempts,
  enrichmentAttemptsExhausted,
  readEnrichAttempts,
  DEFAULT_MAX_ENRICHMENT_ATTEMPTS,
} from "./enrichmentCompleteness.ts";

test("isDerivedMetricsCompleteFlag accepts complete/completed/full (case-insensitive)", () => {
  for (const v of ["complete", "Completed", "FULL", " full "]) {
    assert.equal(isDerivedMetricsCompleteFlag(v), true, v);
  }
  for (const v of ["partial", "none", "", null, undefined, 1]) {
    assert.equal(isDerivedMetricsCompleteFlag(v as unknown), false, String(v));
  }
});

test("isSourceCoverageComplete requires both sources AND a complete marker", () => {
  assert.equal(isSourceCoverageComplete(null), false);
  assert.equal(isSourceCoverageComplete({ basenotes: true, fragrantica: true }), false);
  assert.equal(
    isSourceCoverageComplete({ basenotes: true, fragrantica: false, derived_metrics: "full" }),
    false,
  );
  assert.equal(
    isSourceCoverageComplete({ basenotes: true, fragrantica: true, derived_metrics: "partial" }),
    false,
  );
  // Any one of the three completeness markers suffices once both sources are in.
  assert.equal(
    isSourceCoverageComplete({ basenotes: true, fragrantica: true, complete: true }),
    true,
  );
  assert.equal(
    isSourceCoverageComplete({
      basenotes: true,
      fragrantica: true,
      fragrantica_metrics_complete: true,
    }),
    true,
  );
  assert.equal(
    isSourceCoverageComplete({ basenotes: true, fragrantica: true, derived_metrics: "full" }),
    true,
  );
});

test("evaluateEnrichmentLevel collapses coverage + notes into none/partial/full", () => {
  // Full
  assert.equal(
    evaluateEnrichmentLevel({ basenotes: true, fragrantica: true, derived_metrics: "full" }, true),
    "full",
  );
  // Partial: one source only
  assert.equal(evaluateEnrichmentLevel({ basenotes: true, fragrantica: false }, false), "partial");
  // Partial: no coverage object but we got real notes (the screenshot's opposite)
  assert.equal(evaluateEnrichmentLevel(null, true), "partial");
  // Partial: derived marker complete but sources missing still only ranks partial
  assert.equal(evaluateEnrichmentLevel({ derived_metrics: "full" }, false), "partial");
  // None: nothing usable at all
  assert.equal(evaluateEnrichmentLevel(null, false), "none");
  assert.equal(evaluateEnrichmentLevel({ basenotes: false, fragrantica: false }, false), "none");
});

test("isEnrichmentComplete is true only for full", () => {
  assert.equal(isEnrichmentComplete("full"), true);
  assert.equal(isEnrichmentComplete("partial"), false);
  assert.equal(isEnrichmentComplete("none"), false);
});

test("maxEnrichmentAttempts honors env, clamps, and defaults", () => {
  assert.equal(maxEnrichmentAttempts(undefined), DEFAULT_MAX_ENRICHMENT_ATTEMPTS);
  assert.equal(maxEnrichmentAttempts(""), DEFAULT_MAX_ENRICHMENT_ATTEMPTS);
  assert.equal(maxEnrichmentAttempts("0"), DEFAULT_MAX_ENRICHMENT_ATTEMPTS);
  assert.equal(maxEnrichmentAttempts("-3"), DEFAULT_MAX_ENRICHMENT_ATTEMPTS);
  assert.equal(maxEnrichmentAttempts("3"), 3);
  assert.equal(maxEnrichmentAttempts("10"), 10);
});

test("enrichmentAttemptsExhausted compares against a >=1 ceiling", () => {
  assert.equal(enrichmentAttemptsExhausted(0, 6), false);
  assert.equal(enrichmentAttemptsExhausted(5, 6), false);
  assert.equal(enrichmentAttemptsExhausted(6, 6), true);
  assert.equal(enrichmentAttemptsExhausted(7, 6), true);
  // A non-positive ceiling is clamped to 1 so the job is still considered done.
  assert.equal(enrichmentAttemptsExhausted(1, 0), true);
});

test("readEnrichAttempts tolerates missing/garbage metadata", () => {
  assert.equal(readEnrichAttempts(null), 0);
  assert.equal(readEnrichAttempts({}), 0);
  assert.equal(readEnrichAttempts({ enrichAttempts: "2" }), 2);
  assert.equal(readEnrichAttempts({ enrichAttempts: 4 }), 4);
  assert.equal(readEnrichAttempts({ enrichAttempts: "nope" }), 0);
  assert.equal(readEnrichAttempts({ enrichAttempts: -1 }), 0);
});
