/**
 * Beam Agent — Claude provider.
 *
 * Calls the Anthropic Messages API directly via `fetch`, mirroring how the
 * existing scent-mission route talks to OpenAI/Gemini. No new dependency is
 * added. The credential is read from the environment and is NEVER passed to a
 * tool or surfaced to the client.
 */
import type { ClaudeMessage, ClaudeResponse } from "./types.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_TIMEOUT_MS = 45_000;

/**
 * Cheap tier by default. Override per-deployment with BEAM_AGENT_MODEL, and use
 * BEAM_AGENT_MODEL_STRONG for the (later) collection-synthesis step. Keeping the
 * model in env means the architecture stays credential/model-agnostic.
 */
export const DEFAULT_BEAM_MODEL = process.env.BEAM_AGENT_MODEL?.trim() || "claude-haiku-4-5-20251001";

export type ClaudeCallInput = {
  system: string;
  messages: ClaudeMessage[];
  tools: Array<{ name: string; description: string; input_schema: unknown }>;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
};

/** True when a model credential is configured; the loop checks this up front. */
export function isClaudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function callClaude(input: ClaudeCallInput): Promise<ClaudeResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    signal: input.signal ?? AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    body: JSON.stringify({
      model: input.model ?? DEFAULT_BEAM_MODEL,
      max_tokens: input.maxTokens ?? 1024,
      system: input.system,
      tools: input.tools,
      messages: input.messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude request failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as ClaudeResponse;
  if (!data || !Array.isArray(data.content)) {
    throw new Error("Claude returned an unexpected response shape.");
  }
  return data;
}
