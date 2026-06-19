/**
 * Unit tests for the Beam Agent beta observatory feed producer — no network, no
 * route. Covers the gate (disabled/unauthorized/authorized), buffering, and that
 * the served events carry only redacted, non-PII fields.
 *   node --experimental-strip-types --test src/beam-agent/beamObservatory.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetObservatoryForTests,
  buildObservatoryFeed,
  isObservatoryAuthorized,
  isObservatoryEnabled,
  observatoryBufferSize,
  recordObservatoryRun,
} from "./beamObservatory.ts";
import type { BeamRunSummary } from "./beamAgentLoop.ts";

function sampleSummary(over: Partial<BeamRunSummary> = {}): BeamRunSummary {
  return {
    runId: "run_abc123",
    outcome: "completed",
    turns: 3,
    tools: ["beam_get_wardrobe", "beam_search_catalog"],
    modelCalls: 4,
    inputTokens: 12000,
    outputTokens: 800,
    usedSynthesis: true,
    synthesisFailed: false,
    groundedNames: 6,
    estimatedCostUsd: 0.0123,
    qualityGatePassed: true,
    qualityViolations: [],
    ms: 4200,
    ...over,
  };
}

beforeEach(() => {
  __resetObservatoryForTests();
  delete process.env.BEAM_OBSERVATORY_ENABLED;
  delete process.env.BEAM_OBSERVATORY_TOKEN;
});

test("disabled: feed reports offline and returns no events even when data exists", () => {
  recordObservatoryRun({ summary: sampleSummary() });
  assert.equal(observatoryBufferSize(), 1);
  const feed = buildObservatoryFeed({ enabled: false, authorized: true });
  assert.equal(feed.status, "offline");
  assert.equal(feed.live, false);
  assert.deepEqual(feed.events, []);
});

test("enabled but unauthorized: feed reports unauthorized and returns no events", () => {
  recordObservatoryRun({ summary: sampleSummary() });
  const feed = buildObservatoryFeed({ enabled: true, authorized: false });
  assert.equal(feed.status, "unauthorized");
  assert.equal(feed.live, false);
  assert.deepEqual(feed.events, []);
});

test("authorized but empty: feed is live with an empty event list", () => {
  const feed = buildObservatoryFeed({ enabled: true, authorized: true });
  assert.equal(feed.status, "live");
  assert.equal(feed.live, true);
  assert.deepEqual(feed.events, []);
  assert.equal(feed.count, 0);
});

test("authorized with events: feed returns recorded runs newest-first", () => {
  recordObservatoryRun({ summary: sampleSummary({ runId: "run_1" }), lane: "default", scenario: "chat" });
  recordObservatoryRun({ summary: sampleSummary({ runId: "run_2" }), lane: "premium", scenario: "travel_kit" });
  const feed = buildObservatoryFeed({ enabled: true, authorized: true });
  assert.equal(feed.status, "live");
  assert.equal(feed.events.length, 2);
  assert.equal(feed.events[0].runId, "run_2"); // newest first
  assert.equal(feed.events[1].runId, "run_1");
  assert.equal(feed.events[0].scenario, "travel_kit");
  assert.equal(feed.events[0].lane, "premium");
});

test("redaction: served events carry only safe fields — no user id, message, or prompt", () => {
  recordObservatoryRun({
    summary: sampleSummary({
      runId: "run_redact",
      outcome: "failed",
      failureCode: "run_timeout",
      synthesisFailed: true,
      synthesisFailureReason: "error",
      qualityGatePassed: false,
      qualityViolations: ["mission_unfulfilled"],
    }),
    lane: "premium",
    orchestrationModel: "minimax/minimax-m3",
    synthesisModel: "anthropic/claude-sonnet",
    scenario: "travel_kit",
  });
  const [event] = buildObservatoryFeed({ enabled: true, authorized: true }).events;

  // Safe, expected fields are present.
  assert.equal(event.runId, "run_redact");
  assert.equal(event.status, "failed");
  assert.equal(event.fallbackReason, "run_timeout");
  assert.equal(event.synthesisFailureReason, "error");
  assert.equal(event.gatePassed, false);
  assert.deepEqual(event.gateViolations, ["mission_unfulfilled"]);
  assert.equal(event.orchestrationModel, "minimax/minimax-m3");
  assert.equal(event.synthesisModel, "anthropic/claude-sonnet");
  assert.equal(event.toolCalls, 2);

  // No PII / raw-internal fields ever leak through.
  const keys = new Set(Object.keys(event));
  for (const forbidden of ["userId", "user", "tenantId", "message", "userMessage", "prompt", "system", "history", "inputTokens", "outputTokens"]) {
    assert.equal(keys.has(forbidden), false, `redacted event must not expose "${forbidden}"`);
  }
});

test("scenario is normalized to a safe enum", () => {
  recordObservatoryRun({ summary: sampleSummary({ runId: "run_x" }), scenario: "totally-made-up" });
  const [event] = buildObservatoryFeed({ enabled: true, authorized: true }).events;
  assert.equal(event.scenario, "other");
});

test("ring buffer is bounded and keeps the most recent runs", () => {
  for (let i = 0; i < 250; i++) recordObservatoryRun({ summary: sampleSummary({ runId: `run_${i}` }) });
  assert.ok(observatoryBufferSize() <= 200);
  const feed = buildObservatoryFeed({ enabled: true, authorized: true, limit: 5 });
  assert.equal(feed.events.length, 5);
  assert.equal(feed.events[0].runId, "run_249"); // newest retained
});

test("token gate: enabled flag and constant-time token check honor env", () => {
  assert.equal(isObservatoryEnabled(), false);
  process.env.BEAM_OBSERVATORY_ENABLED = "true";
  assert.equal(isObservatoryEnabled(), true);

  // No token configured → nothing authorizes (even an empty presented token).
  assert.equal(isObservatoryAuthorized(""), false);
  assert.equal(isObservatoryAuthorized("anything"), false);

  process.env.BEAM_OBSERVATORY_TOKEN = "s3cret-token";
  assert.equal(isObservatoryAuthorized("s3cret-token"), true);
  assert.equal(isObservatoryAuthorized("wrong"), false);
  assert.equal(isObservatoryAuthorized("s3cret-toke"), false); // length mismatch
  assert.equal(isObservatoryAuthorized(undefined), false);
});

test("recording never throws on a malformed summary", () => {
  assert.doesNotThrow(() => recordObservatoryRun({ summary: undefined as unknown as BeamRunSummary }));
  assert.doesNotThrow(() => recordObservatoryRun({ summary: { runId: 5 } as unknown as BeamRunSummary }));
  assert.equal(observatoryBufferSize(), 0);
});
