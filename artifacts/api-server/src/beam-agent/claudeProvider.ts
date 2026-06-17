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
 * Strong tier for the final synthesis turn (Anthropic-direct slug). This is the
 * "smart when it needs to be" half of the cheap/smart split: cheap Haiku drives
 * the multi-turn tool orchestration, and a single Sonnet call writes the closing
 * recommendation where quality matters most.
 *
 * The default is a real, always-available first-party Anthropic model
 * (claude-sonnet-4-6), so on the Anthropic-direct path the quality jump is ON by
 * default — no extra env required and no risk of an unprovisioned-slug 404.
 * Override with BEAM_AGENT_MODEL_STRONG to pin a different slug (e.g. an Opus
 * tier). (OpenRouter slugs are account-provisioned, so that provider keeps a
 * cheap default and opts in via env — see openRouterProvider.ts.)
 */
export const STRONG_BEAM_MODEL = process.env.BEAM_AGENT_MODEL_STRONG?.trim() || "claude-sonnet-4-6";

export type { ClaudeCallInput } from "./types.ts";

/** True when a model credential is configured; the loop checks this up front. */
export function isClaudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const EPHEMERAL = { type: "ephemeral" as const };

/**
 * Prompt caching (Anthropic Messages API). The system prompt and tool schemas are
 * identical across every call in a run (orchestration turns + the synthesis turn),
 * and the transcript prefix only grows — so we place cache breakpoints at the end
 * of `system`, the last tool, and the last message block. Calls 2..N then read
 * that shared prefix at ~10% of input price instead of re-billing ~20k+ tokens of
 * system+tools+transcript every turn. Breakpoints are silently ignored for blocks
 * below the model's minimum cacheable size, so this is safe on tiny early turns.
 * (Anthropic allows up to 4 breakpoints; we use at most 3.)
 */
function cachedSystem(system: string): unknown {
  return [{ type: "text", text: system, cache_control: EPHEMERAL }];
}

function cachedTools(tools: ClaudeCallInput["tools"]): unknown {
  if (tools.length === 0) return tools;
  return tools.map((tool, i) =>
    i === tools.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool,
  );
}

function cachedMessages(messages: ClaudeCallInput["messages"]): unknown {
  if (messages.length === 0) return messages;
  const out: unknown[] = messages.slice();
  const last = messages[messages.length - 1];
  const blocks: Array<Record<string, unknown>> =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : last.content.map((b) => ({ ...b }));
  if (blocks.length > 0) {
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  }
  out[out.length - 1] = { ...last, content: blocks };
  return out;
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
      system: cachedSystem(input.system),
      tools: cachedTools(input.tools),
      messages: cachedMessages(input.messages),
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

  const data = (await res.json()) as ClaudeResponse & {
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (!data || !Array.isArray(data.content)) {
    throw new Error("Claude returned an unexpected response shape.");
  }
  return {
    stop_reason: data.stop_reason ?? null,
    content: data.content,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
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
  let inputTokens = 0;
  let outputTokens = 0;

  const handleData = (payload: string): void => {
    let evt:
      | {
          type?: string;
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          usage?: { output_tokens?: number };
          delta?: { type?: string; text?: string; stop_reason?: string | null };
        }
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
    } else if (evt?.type === "message_start" && evt.message?.usage) {
      inputTokens = evt.message.usage.input_tokens ?? inputTokens;
    } else if (evt?.type === "message_delta") {
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      if (typeof evt.usage?.output_tokens === "number") outputTokens = evt.usage.output_tokens;
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

  return {
    stop_reason: stopReason,
    content: text ? [{ type: "text", text }] : [],
    usage: { inputTokens, outputTokens },
  };
}
