/**
 * Beam Agent — Beta Observatory feed producer.
 *
 * A small, in-process ring buffer of REDACTED run summaries that powers the beta
 * observability console (docs/beam-beta-observatory.html). It is:
 *
 *   - OFF by default. The feed endpoint only serves data when
 *     `BEAM_OBSERVATORY_ENABLED` is truthy AND the caller presents the configured
 *     `BEAM_OBSERVATORY_TOKEN`. With neither set the producer still records (cheap,
 *     bounded) but the endpoint reports `offline` and returns nothing.
 *   - Redacted by construction. It copies ONLY the safe, already-aggregated fields
 *     off `BeamRunSummary` (status, duration, tool names, gate result, failure /
 *     synthesis-failure codes, model slugs, a coarse scenario label). It never sees
 *     — and never stores — user ids, message text, prompts, tool arguments, or any
 *     other PII. `runId` is a random per-run UUID, not a user identifier.
 *
 * Keeping it in-process matches the rest of the Beam run registry (single replica,
 * see beamAgentRoutes.ts) and means a beta export is a plain GET, with no new
 * datastore. Nothing here can throw on the run's behalf: `recordObservatoryRun` is
 * wrapped by the caller and also self-guards.
 */
import type { BeamRunSummary } from "./beamAgentLoop.ts";

/** Coarse, non-PII scenario labels. Anything else is normalized to `other`. */
export type ObservatoryScenario =
  | "travel_kit"
  | "recommendation"
  | "chat"
  | "research"
  | "other";

const SCENARIOS = new Set<ObservatoryScenario>([
  "travel_kit",
  "recommendation",
  "chat",
  "research",
  "other",
]);

/** One redacted run record as served to the observatory console. */
export type ObservatoryRunEvent = {
  /** Random per-run UUID (not a user identifier). */
  runId: string;
  /** ISO timestamp the run summary was recorded. */
  at: string;
  status: "completed" | "failed";
  /** Stable failure/fallback code when the run did not complete, else null. */
  fallbackReason: string | null;
  durationMs: number;
  turns: number;
  modelCalls: number;
  /** Number of tool invocations this run. */
  toolCalls: number;
  /** Tool names invoked (a fixed `beam_*` enum — safe to surface). */
  tools: string[];
  usedSynthesis: boolean;
  synthesisFailed: boolean;
  /** "empty" | "error" when synthesis failed, else null. */
  synthesisFailureReason: string | null;
  gatePassed: boolean;
  /** Gate names the final answer violated (a fixed enum — safe to surface). */
  gateViolations: string[];
  groundedNames: number;
  estimatedCostUsd: number;
  /** Cost lane ("default" | "premium") when known. */
  lane: string | null;
  /** Orchestration model slug (config, not secret) when known. */
  orchestrationModel: string | null;
  /** Synthesis ("closer") model slug (config, not secret) when known. */
  synthesisModel: string | null;
  /** Coarse scenario label derived from mission intent. */
  scenario: ObservatoryScenario;
};

/** What the feed endpoint returns. `status` is honest about the data source. */
export type ObservatoryFeed = {
  /**
   * `offline`      — the feed is disabled (BEAM_OBSERVATORY_ENABLED unset/false).
   * `unauthorized` — enabled but the caller's token is missing/wrong.
   * `live`         — enabled AND authorized; `events` is real run data.
   */
  status: "offline" | "unauthorized" | "live";
  live: boolean;
  capacity: number;
  count: number;
  generatedAt: string;
  events: ObservatoryRunEvent[];
};

/** Newest-last ring buffer. Bounded so a long beta never grows unbounded. */
const BUFFER_CAPACITY = 200;
const buffer: ObservatoryRunEvent[] = [];

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** True when the observatory feed is enabled for this environment. */
export function isObservatoryEnabled(): boolean {
  return envFlag("BEAM_OBSERVATORY_ENABLED");
}

function configuredToken(): string {
  return (process.env.BEAM_OBSERVATORY_TOKEN ?? "").trim();
}

/**
 * Constant-time-ish token check. Returns false when no token is configured (so an
 * unset token can never authorize), and compares without short-circuiting on the
 * first differing byte to avoid leaking length/content via timing.
 */
export function isObservatoryAuthorized(presented: string | undefined | null): boolean {
  const expected = configuredToken();
  if (!expected) return false;
  const got = (presented ?? "").trim();
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function normalizeScenario(value: string | undefined): ObservatoryScenario {
  if (value && SCENARIOS.has(value as ObservatoryScenario)) return value as ObservatoryScenario;
  return "other";
}

function clampString(value: string | undefined | null, max = 80): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function roundUsd(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0;
}

export type RecordObservatoryRunInput = {
  summary: BeamRunSummary;
  lane?: string;
  orchestrationModel?: string;
  synthesisModel?: string;
  scenario?: string;
};

/**
 * Record one finished run into the ring buffer as a redacted event. Pure-ish and
 * self-guarding: it copies only safe summary fields and never throws (a bad input
 * is dropped, never surfaced). Recording happens regardless of the enabled flag —
 * it's cheap and bounded — so flipping the flag on exposes the recent tail
 * immediately; the GATE is at the read endpoint, not here.
 */
export function recordObservatoryRun(input: RecordObservatoryRunInput): void {
  try {
    const s = input.summary;
    if (!s || typeof s.runId !== "string") return;
    const event: ObservatoryRunEvent = {
      runId: s.runId.slice(0, 64),
      at: new Date().toISOString(),
      status: s.outcome === "completed" ? "completed" : "failed",
      fallbackReason: clampString(s.failureCode),
      durationMs: Number.isFinite(s.ms) ? s.ms : 0,
      turns: Number.isFinite(s.turns) ? s.turns : 0,
      modelCalls: Number.isFinite(s.modelCalls) ? s.modelCalls : 0,
      toolCalls: Array.isArray(s.tools) ? s.tools.length : 0,
      tools: Array.isArray(s.tools) ? s.tools.slice(0, 40).map((t) => String(t).slice(0, 60)) : [],
      usedSynthesis: Boolean(s.usedSynthesis),
      synthesisFailed: Boolean(s.synthesisFailed),
      synthesisFailureReason: clampString(s.synthesisFailureReason),
      gatePassed: Boolean(s.qualityGatePassed),
      gateViolations: Array.isArray(s.qualityViolations)
        ? s.qualityViolations.slice(0, 20).map((v) => String(v).slice(0, 60))
        : [],
      groundedNames: Number.isFinite(s.groundedNames) ? s.groundedNames : 0,
      estimatedCostUsd: roundUsd(s.estimatedCostUsd),
      lane: clampString(input.lane),
      orchestrationModel: clampString(input.orchestrationModel),
      synthesisModel: clampString(input.synthesisModel),
      scenario: normalizeScenario(input.scenario),
    };
    buffer.push(event);
    while (buffer.length > BUFFER_CAPACITY) buffer.shift();
  } catch {
    // Observability must never affect a run; drop a malformed record silently.
  }
}

/**
 * Build the feed payload for the given gate decision. Pure: callers (the route
 * and tests) decide `enabled`/`authorized`; this only assembles the honest
 * response. Events are returned newest-first and capped to `limit`.
 */
export function buildObservatoryFeed(
  opts: { enabled: boolean; authorized: boolean; limit?: number },
): ObservatoryFeed {
  const base = {
    capacity: BUFFER_CAPACITY,
    count: buffer.length,
    generatedAt: new Date().toISOString(),
  };
  if (!opts.enabled) {
    return { status: "offline", live: false, ...base, count: 0, events: [] };
  }
  if (!opts.authorized) {
    return { status: "unauthorized", live: false, ...base, count: 0, events: [] };
  }
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, BUFFER_CAPACITY) : BUFFER_CAPACITY;
  const events = buffer.slice(-limit).reverse();
  return { status: "live", live: true, ...base, events };
}

/** Current buffer size (diagnostics/tests). */
export function observatoryBufferSize(): number {
  return buffer.length;
}

/** Test-only: empty the ring buffer between cases. */
export function __resetObservatoryForTests(): void {
  buffer.length = 0;
}
