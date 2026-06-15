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
  DEFAULT_OPENROUTER_MODEL,
  STRONG_OPENROUTER_MODEL,
  callOpenRouter,
  isOpenRouterConfigured,
} from "./openRouterProvider.ts";

export type BeamProvider = "openrouter" | "anthropic";

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
 * the provider that will actually serve the run, resolved from env. Both fall
 * back to the cheap default when the strong env var is unset, so callers can
 * always branch on a defined slug. Returns null when no provider is configured.
 */
export function resolveBeamModels(): { model: string; synthesisModel: string } | null {
  const provider = resolveProvider();
  if (provider === "anthropic") {
    return { model: DEFAULT_BEAM_MODEL, synthesisModel: STRONG_BEAM_MODEL };
  }
  if (provider === "openrouter") {
    return { model: DEFAULT_OPENROUTER_MODEL, synthesisModel: STRONG_OPENROUTER_MODEL };
  }
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
