/**
 * Beam Agent — Claude provider.
 *
 * Calls the Anthropic Messages API directly via `fetch`, mirroring how the
 * existing scent-mission route talks to OpenAI/Gemini. No new dependency is
 * added. The credential is read from the environment and is NEVER passed to a
 * tool or surfaced to the client.
 */
import type { ClaudeCallInput, ClaudeResponse } from "./types.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_TIMEOUT_MS = 45_000;

/**
 * Cheap tier by default. Override per-deployment with BEAM_AGENT_MODEL, and use
 * BEAM_AGENT_MODEL_STRONG for the (later) collection-synthesis step. Keeping the
 * model in env means the architecture stays credential/model-agnostic.
 *
 * NOTE: this is the Anthropic-direct slug. When the provider is OpenRouter
 * (`OPENROUTER_API_KEY` set), the OpenRouter slug default lives in
 * `openRouterProvider.ts`. The shared `ClaudeCallInput`/`ClaudeResponse` types
 * now live in `types.ts` so both providers speak one contract.
 */
export const DEFAULT_BEAM_MODEL = process.env.BEAM_AGENT_MODEL?.trim() || "claude-haiku-4-5-20251001";

/**
 * Strong tier for the final synthesis turn (Anthropic-direct slug). Set
 * BEAM_AGENT_MODEL_STRONG to a more capable model (e.g. a Sonnet/Opus slug) to
 * write the closing recommendation; falls back to the cheap default when unset,
 * so the synthesis branch is a no-op upgrade until the env var is provided.
 */
export const STRONG_BEAM_MODEL = process.env.BEAM_AGENT_MODEL_STRONG?.trim() || DEFAULT_BEAM_MODEL;

export type { ClaudeCallInput } from "./types.ts";

/** True when a model credential is configured; the loop checks this up front. */
export function isClaudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function callClaude(input: ClaudeCallInput): Promise<ClaudeResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const stream = typeof input.onDelta === "function";
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
      ...(stream ? { stream: true } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude request failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  if (stream && res.body) {
    return streamClaudeText(res.body, input.onDelta!);
  }

  const data = (await res.json()) as ClaudeResponse;
  if (!data || !Array.isArray(data.content)) {
    throw new Error("Claude returned an unexpected response shape.");
  }
  return data;
}

/**
 * Consume an Anthropic streaming response, forwarding each `text_delta` to
 * `onDelta` and returning the assembled text as a `ClaudeResponse`. Only the
 * text channel is assembled — streaming is used for the loop's tool-free
 * synthesis turn, which never emits tool_use blocks.
 */
async function streamClaudeText(
  body: ReadableStream<Uint8Array>,
  onDelta: (chunk: string) => void,
): Promise<ClaudeResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let stopReason: string | null = null;

  const handleData = (payload: string): void => {
    let evt:
      | { type?: string; delta?: { type?: string; text?: string; stop_reason?: string | null } }
      | undefined;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta") {
      const chunk = evt.delta.text;
      if (typeof chunk === "string" && chunk) {
        text += chunk;
        onDelta(chunk);
      }
    } else if (evt?.type === "message_delta" && evt.delta?.stop_reason) {
      stopReason = evt.delta.stop_reason;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const rawLine of frame.split("\n")) {
          const line = rawLine.replace(/\r$/, "");
          if (line.startsWith("data:")) handleData(line.slice(5).replace(/^ /, ""));
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { stop_reason: stopReason, content: text ? [{ type: "text", text }] : [] };
}
