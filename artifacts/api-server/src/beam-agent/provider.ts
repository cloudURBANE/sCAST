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
import { DEFAULT_BEAM_MODEL, STRONG_BEAM_MODEL, callClaude, isClaudeConfigured } from "./claudeProvider.ts";
import {
  callOpenRouter,
  deepOpenRouterModel,
  defaultOpenRouterModel,
  isOpenRouterConfigured,
  strongOpenRouterModel,
} from "./openRouterProvider.ts";

export type BeamProvider = "openrouter" | "anthropic";

/**
 * Concierge lane (brief §03.2). The cheap `default` lane (MiniMax M2.5) handles
 * normal fragrance chat; the `premium` lane (MiniMax M3) is reserved for long /
 * multi-turn / nuanced work. The lane is chosen deterministically at the route
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
 * The orchestration (`model`) and final-synthesis (`synthesisModel`) slugs for
 * the provider that will actually serve the run, resolved from env at call time.
 * Returns null when no provider is configured.
 *
 * `lane` selects the cost lane (brief §03.2): the `premium` lane runs the strong
 * (MiniMax M3 / Sonnet) slug for BOTH orchestration and synthesis so long /
 * nuanced sessions get the better model end-to-end; the `default` lane runs the
 * cheap concierge slug for orchestration and the strong slug only for the closing
 * synthesis turn. A no-arg call keeps the historical default-lane behavior.
 */
export function resolveBeamModels(
  lane: BeamLane = "default",
): { model: string; synthesisModel: string } | null {
  const provider = resolveProvider();
  if (provider === "anthropic") {
    const strong = STRONG_BEAM_MODEL;
    return {
      model: lane === "premium" ? strong : DEFAULT_BEAM_MODEL,
      synthesisModel: strong,
    };
  }
  if (provider === "openrouter") {
    const strong = strongOpenRouterModel();
    return {
      model: lane === "premium" ? strong : defaultOpenRouterModel(),
      synthesisModel: strong,
    };
  }
  return null;
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

export async function callModel(input: ClaudeCallInput): Promise<ClaudeResponse> {
  const provider = resolveProvider();
  if (provider === "openrouter") return callOpenRouter(input);
  if (provider === "anthropic") return callClaude(input);
  throw new Error(
    "No Beam Agent model provider configured. Set OPENROUTER_API_KEY (production) or ANTHROPIC_API_KEY.",
  );
}
