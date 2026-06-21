/**
 * Beam Agent — provider selection.
 *
 * One seam the loop calls (`callModel` / `isModelConfigured`) that resolves to a
 * concrete provider at call time:
 *
 *   - OpenRouter (production) when `OPENROUTER_API_KEY` is set, OR
 *   - Anthropic-direct when only `ANTHROPIC_API_KEY` is set.
 *
 * Force one explicitly with `BEAM_AGENT_PROVIDER=openrouter|anthropic`. This
 * keeps the runtime credential/model-agnostic (the architecture decision) while
 * making OpenRouter the default whenever its key is present.
 */
import type { ClaudeCallInput, ClaudeResponse } from "./types.ts";
import { BEAM_LIMITS } from "./beamToolCore.ts";
import { DEFAULT_BEAM_MODEL, STRONG_BEAM_MODEL, callClaude, isClaudeConfigured } from "./claudeProvider.ts";
import {
  callOpenRouter,
  deepOpenRouterModel,
  defaultOpenRouterModel,
  isOpenRouterConfigured,
  premiumOrchestrationModel,
  strongOpenRouterModel,
} from "./openRouterProvider.ts";

export type BeamProvider = "openrouter" | "anthropic";

/**
 * Concierge lane (brief §03.2). The cheap `default` lane (free Gemma concierge)
 * handles normal fragrance chat; the `premium` lane (also free Gemma orchestration)
 * is reserved for long / multi-turn / nuanced work, with the strong hy3-preview
 * closer reserved for synthesis. The lane is chosen deterministically at the route
 * (see laneSelector.ts) — no extra router LLM call.
 */
export type BeamLane = "default" | "premium";

/** The provider that will actually serve a call, or null if none is configured. */
export function resolveProvider(): BeamProvider | null {
  const explicit = process.env.BEAM_AGENT_PROVIDER?.trim().toLowerCase();
  if (explicit === "openrouter") return isOpenRouterConfigured() ? "openrouter" : null;
  if (explicit === "anthropic") return isClaudeConfigured() ? "anthropic" : null;
  // Auto: prefer OpenRouter (the production path), fall back to Anthropic-direct.
  if (isOpenRouterConfigured()) return "openrouter";
  if (isClaudeConfigured()) return "anthropic";
  return null;
}

/** True when SOME model provider is usable; the loop checks this up front. */
export function isModelConfigured(): boolean {
  return resolveProvider() !== null;
}

/**
 * Global runtime kill-switch for the whole Beam Agent, read fresh from env on
 * every call so an operator can turn the agent on/off for ALL users by changing
 * BEAM_AGENT_ENABLED and restarting (Railway) — no code change. Default ON: only
 * an explicit falsey value ("0" | "false" | "off" | "no" | "disabled",
 * case/space-insensitive) disables it. Anything else (including unset) is ON.
 */
export function isBeamAgentEnabled(): boolean {
  const raw = process.env.BEAM_AGENT_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no", "disabled"].includes(raw);
}

/**
 * The orchestration (`model`) and final-synthesis (`synthesisModel`) slugs for
 * the provider that will actually serve the run, resolved from env at call time.
 * Returns null when no provider is configured.
 *
 * `lane` selects the cost lane (brief §03.2). BOTH lanes run a cheap tool-router
 * for orchestration and reserve the strong slug for the closing synthesis turn
 * only — that "cheap orchestration + smart closer" split is the documented intent.
 * The lane changes only the *orchestration* tier: `default` runs the cheap
 * concierge model (free Gemma / Haiku), `premium` steps orchestration up to the
 * premium tier (free Gemma premium-orch) for nuanced / multi-item missions.
 * Crucially, premium orchestration is
 * NOT the synthesis slug — reusing the (often Sonnet-overridden) strong slug for
 * every premium orchestration turn is what previously made a single "trip/kit"
 * mission cost ~$0.60 (7+ closer-priced tool turns). A no-arg call keeps the
 * historical default-lane behavior.
 */
export function resolveBeamModels(
  lane: BeamLane = "default",
): { model: string; synthesisModel: string } | null {
  const provider = resolveProvider();
  if (provider === "anthropic") {
    // Anthropic-direct has no mid-tier between Haiku and Sonnet, so premium
    // orchestration stays on the cheap default unless explicitly pinned. The
    // closing turn still escalates to the strong (Sonnet) synthesis slug.
    const premiumOrch = process.env.BEAM_AGENT_MODEL_PREMIUM?.trim() || DEFAULT_BEAM_MODEL;
    return {
      model: lane === "premium" ? premiumOrch : DEFAULT_BEAM_MODEL,
      synthesisModel: synthesisModelForLane(lane, STRONG_BEAM_MODEL),
    };
  }
  if (provider === "openrouter") {
    return {
      model: lane === "premium" ? premiumOrchestrationModel() : defaultOpenRouterModel(),
      synthesisModel: synthesisModelForLane(lane, strongOpenRouterModel()),
    };
  }
  return null;
}

/**
 * The closing-synthesis slug for a lane, with the provider's strong slug as the
 * default. Lets the default and premium lanes close on DIFFERENT models without a
 * code change — e.g. route everyday (`default`-lane) traffic to a cheap reasoning
 * closer (`BEAM_AGENT_SYNTH_MODEL_DEFAULT=deepseek/deepseek-v4-flash`) while keeping
 * nuanced premium missions on Sonnet, or vice-versa for an A/B. Provider-agnostic:
 * the slug is whatever the active provider accepts (OpenRouter routes DeepSeek/
 * MiniMax/Anthropic slugs alike). Unset → strong slug, i.e. today's behavior
 * unchanged on both lanes.
 */
function synthesisModelForLane(lane: BeamLane, fallback: string): string {
  const raw =
    lane === "premium"
      ? process.env.BEAM_AGENT_SYNTH_MODEL_PREMIUM
      : process.env.BEAM_AGENT_SYNTH_MODEL_DEFAULT;
  return raw?.trim() || fallback;
}

/** Per-run guardrails resolved from env, defaulting to today's hardcoded limits. */
export type BeamBudget = {
  /** Max tool-calling orchestration turns before the run is forced to close. */
  maxTurns: number;
  /** Output-token ceiling for each orchestration (tool-decision) turn. */
  orchestrationMaxTokens: number;
  /** Output-token ceiling for the closing synthesis (and repair) turn. */
  synthesisMaxTokens: number;
};

/**
 * Per-lane run budget (tool-round + output-token caps). All knobs default to the
 * current hardcoded behavior (`BEAM_LIMITS.maxAgentTurns` rounds, 2048/4096 output
 * tokens), so an environment that sets nothing behaves exactly as before. The caps
 * exist so a cheaper/reasoning closer can be adopted safely: lowering free-lane tool
 * rounds and the synthesis token ceiling bounds the worst-case bill (reasoning slugs
 * bill their trace as output). `maxTurns` is clamped to the hard ceiling
 * `BEAM_LIMITS.maxAgentTurns` — env can only LOWER it, never exceed the server wall.
 */
export function resolveBeamBudget(lane: BeamLane = "default"): BeamBudget {
  const turnsRaw =
    lane === "premium"
      ? process.env.BEAM_AGENT_MAX_TURNS_PREMIUM
      : process.env.BEAM_AGENT_MAX_TURNS_DEFAULT;
  return {
    maxTurns: Math.min(
      positiveIntFromEnv(turnsRaw, BEAM_LIMITS.maxAgentTurns),
      BEAM_LIMITS.maxAgentTurns,
    ),
    orchestrationMaxTokens: positiveIntFromEnv(
      process.env.BEAM_AGENT_ORCH_MAX_TOKENS,
      BEAM_LIMITS.orchestrationMaxTokens,
    ),
    synthesisMaxTokens: positiveIntFromEnv(
      process.env.BEAM_AGENT_SYNTH_MAX_TOKENS,
      BEAM_LIMITS.synthesisMaxTokens,
    ),
  };
}

/** Parse a positive integer env value, falling back when absent/blank/invalid. */
function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The deep-strategy slug (brief §02.1 deep_strategy / §03.2 use_kimi_if) for the
 * active provider, exposed for telemetry and future gated deep workflows. The
 * hot-path loop does NOT auto-route here. Returns null when no provider is set.
 */
export function resolveDeepModel(): string | null {
  const provider = resolveProvider();
  if (provider === "anthropic") return STRONG_BEAM_MODEL;
  if (provider === "openrouter") return deepOpenRouterModel();
  return null;
}

/**
 * Reasoning/"thinking" slugs bill their hidden trace as output tokens and run far
 * slower per turn — fine for the single closing synthesis, dangerous on the
 * tool-calling orchestration loop where they can eat the whole wall-clock budget
 * before a kit is composed (the live ~52s/synthesisFailed symptom). We only WARN:
 * env is owner-controlled and we never override an explicit choice.
 */
function looksLikeReasoningSlug(slug: string | undefined): boolean {
  return /thinking|reason|deepseek-r|kimi/i.test(slug ?? "");
}

/**
 * Non-fatal model-configuration audit (brief §C). Returns human-readable warnings
 * for the misconfigurations the code can detect without changing behavior:
 *   - no provider configured (the agent will report model_unavailable),
 *   - the premium ORCHESTRATION slug pinned to the strong SYNTHESIS slug (every
 *     premium tool turn then pays closer prices — the documented ~$0.60/mission
 *     footgun),
 *   - a reasoning/"thinking" slug used for ORCHESTRATION (latency/budget risk).
 * Pure (reads env only); the caller logs the result once at mount.
 */
export function validateBeamModelConfig(): string[] {
  const warnings: string[] = [];
  const provider = resolveProvider();
  if (!provider) {
    warnings.push(
      "No Beam Agent model provider configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY); runs will report model_unavailable.",
    );
    return warnings;
  }
  const premium = resolveBeamModels("premium");
  const def = resolveBeamModels("default");
  if (premium && premium.model === premium.synthesisModel) {
    warnings.push(
      `Premium orchestration model equals the synthesis model ("${premium.model}"); every premium tool turn pays the closer's price. Set BEAM_AGENT_MODEL_PREMIUM to a cheaper orchestration slug.`,
    );
  }
  for (const [lane, models] of [["default", def], ["premium", premium]] as const) {
    if (models && looksLikeReasoningSlug(models.model)) {
      warnings.push(
        `The ${lane}-lane ORCHESTRATION model ("${models.model}") looks like a reasoning/thinking slug; it can exhaust the run's wall-clock budget before synthesis. Prefer a fast non-reasoning slug for orchestration and reserve reasoning for the synthesis turn.`,
      );
    }
  }
  return warnings;
}

export async function callModel(input: ClaudeCallInput): Promise<ClaudeResponse> {
  const provider = resolveProvider();
  if (provider === "openrouter") return callOpenRouter(input);
  if (provider === "anthropic") return callClaude(input);
  throw new Error(
    "No Beam Agent model provider configured. Set OPENROUTER_API_KEY (production) or ANTHROPIC_API_KEY.",
  );
}
