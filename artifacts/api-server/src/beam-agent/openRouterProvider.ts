/**
 * Beam Agent — OpenRouter provider (the production model path).
 *
 * OpenRouter exposes an OpenAI-compatible Chat Completions API, whose tool-call
 * dialect differs from Anthropic's `tool_use`/`tool_result` content blocks. This
 * module is an ADAPTER: it accepts the same `ClaudeCallInput` the loop already
 * builds, translates it to OpenAI on the wire, and translates the reply back
 * into the `ClaudeResponse` block shape the loop consumes. Nothing in
 * `beamAgentLoop.ts`, `beamToolCore.ts`, or the routes changes.
 *
 * The credential is read from the environment and is NEVER passed to a tool or
 * surfaced to the client. No new dependency is added (plain `fetch`).
 */
import type {
  ClaudeCallInput,
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeResponse,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
} from "./types.ts";
import { invalidArgsMarker } from "./beamToolCore.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TIMEOUT_MS = 45_000;

/**
 * Cheap tier by default, as an OpenRouter slug. Override per-deployment with
 * BEAM_AGENT_MODEL. Confirm the exact slug in the OpenRouter dashboard — model
 * ids are provider-namespaced (`vendor/model`) and not interchangeable with the
 * Anthropic-direct ids used by `claudeProvider.ts`.
 */
export const DEFAULT_OPENROUTER_MODEL =
  process.env.BEAM_AGENT_MODEL?.trim() || "anthropic/claude-haiku-4.5";

/**
 * Strong tier, reserved for the (later, Phase 4) collection-synthesis step.
 * Defined here so the env contract exists now; the read-only Phase 1 loop does
 * not yet branch on it. Falls back to the cheap default when unset.
 */
export const STRONG_OPENROUTER_MODEL =
  process.env.BEAM_AGENT_MODEL_STRONG?.trim() || DEFAULT_OPENROUTER_MODEL;

/** True when an OpenRouter credential is configured. */
export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/* ------------------------------------------------------------------ */
/* OpenAI chat-completions wire shapes (minimal)                       */
/* ------------------------------------------------------------------ */

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAiTool = {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
};

type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number };

type OpenAiResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  }>;
  usage?: OpenAiUsage;
};

/* ------------------------------------------------------------------ */
/* Outbound translation: ClaudeCallInput -> OpenAI request             */
/* ------------------------------------------------------------------ */

function toOpenAiTools(tools: ClaudeCallInput["tools"]): OpenAiTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function blocksOf(content: ClaudeMessage["content"]): ClaudeContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Translate the loop's Anthropic-shaped message list into OpenAI messages.
 * Anthropic packs tool results into a single `user` message of `tool_result`
 * blocks; OpenAI requires one `tool` message per result, so those are expanded.
 */
function toOpenAiMessages(system: string, messages: ClaudeMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const blocks = blocksOf(message.content);

    if (message.role === "assistant") {
      let text = "";
      const toolCalls: OpenAiToolCall[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
          text += (block as { text: string }).text;
        } else if (block.type === "tool_use") {
          const use = block as ClaudeToolUseBlock;
          toolCalls.push({
            id: use.id,
            type: "function",
            function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
          });
        }
      }
      const assistant: Extract<OpenAiMessage, { role: "assistant" }> = {
        role: "assistant",
        content: text ? text : null,
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      out.push(assistant);
      continue;
    }

    // role === "user": may carry plain text and/or tool_result blocks.
    let userText = "";
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const result = block as ClaudeToolResultBlock;
        const body = result.is_error ? `ERROR: ${result.content}` : result.content;
        out.push({ role: "tool", tool_call_id: result.tool_use_id, content: body });
      } else if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
        userText += (block as { text: string }).text;
      }
    }
    if (userText) out.push({ role: "user", content: userText });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Inbound translation: OpenAI response -> ClaudeResponse              */
/* ------------------------------------------------------------------ */

function safeParseArgs(raw: string): unknown {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // A model occasionally emits non-JSON args. Don't silently coerce to `{}` —
    // that becomes an empty tool result the model reads as "nothing exists."
    // Mark it so the loop returns an explicit tool error and the model retries.
    return invalidArgsMarker(trimmed);
  }
}

function mapFinishReason(reason: string | null | undefined): string | null {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  return reason ?? null;
}

export function openAiResponseToClaude(data: OpenAiResponse): ClaudeResponse {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const content: ClaudeContentBlock[] = [];

  if (message?.content) content.push({ type: "text", text: message.content });

  for (const call of message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: safeParseArgs(call.function.arguments),
    } satisfies ClaudeToolUseBlock);
  }

  return {
    stop_reason: mapFinishReason(choice?.finish_reason),
    content,
    usage: usageFromOpenAi(data.usage),
  };
}

function usageFromOpenAi(usage: OpenAiUsage | undefined): ClaudeResponse["usage"] {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* The call                                                            */
/* ------------------------------------------------------------------ */

export async function callOpenRouter(input: ClaudeCallInput): Promise<ClaudeResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  // OpenRouter attribution headers (optional, recommended). Safe, non-secret.
  const referer = process.env.OPENROUTER_SITE_URL?.trim();
  const title = process.env.OPENROUTER_APP_TITLE?.trim() || "ScentBeam Beam Agent";
  if (referer) headers["HTTP-Referer"] = referer;
  headers["X-Title"] = title;

  const stream = typeof input.onDelta === "function";
  // Omit tools/tool_choice entirely on the tool-free synthesis turn — some
  // OpenAI-compatible backends reject `tool_choice` alongside an empty tools list.
  const hasTools = input.tools.length > 0;
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers,
    signal: input.signal ?? AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    body: JSON.stringify({
      model: input.model ?? DEFAULT_OPENROUTER_MODEL,
      max_tokens: input.maxTokens ?? 1024,
      messages: toOpenAiMessages(input.system, input.messages),
      ...(hasTools ? { tools: toOpenAiTools(input.tools), tool_choice: "auto" } : {}),
      // include_usage adds a final usage-only chunk to the stream for cost accounting.
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  if (stream && res.body) {
    return streamOpenAiText(res.body, input.onDelta!);
  }

  const data = (await res.json()) as OpenAiResponse;
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error("OpenRouter returned an unexpected response shape.");
  }
  return openAiResponseToClaude(data);
}

/**
 * Consume an OpenAI-style streaming completion (`data: {…}` SSE frames, ended by
 * `data: [DONE]`), forwarding each text delta to `onDelta` and returning the
 * fully-assembled text as a `ClaudeResponse`. Tool-call deltas are not assembled
 * here: streaming is only used for the loop's tool-free synthesis turn.
 */
async function streamOpenAiText(
  body: ReadableStream<Uint8Array>,
  onDelta: (chunk: string) => void,
): Promise<ClaudeResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason: string | null = null;
  let usage: OpenAiUsage | undefined;

  const handleData = (payload: string): void => {
    if (payload === "[DONE]") return;
    let parsed: OpenAiResponse | undefined;
    try {
      parsed = JSON.parse(payload) as OpenAiResponse;
    } catch {
      return; // tolerate keep-alive / partial frames
    }
    // The include_usage final frame carries usage with an empty choices array.
    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0] as
      | { finish_reason?: string | null; delta?: { content?: string | null } }
      | undefined;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const chunk = choice.delta?.content;
    if (typeof chunk === "string" && chunk) {
      text += chunk;
      onDelta(chunk);
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
    stop_reason: mapFinishReason(finishReason),
    content: text ? [{ type: "text", text }] : [],
    usage: usageFromOpenAi(usage),
  };
}

/** Exposed for unit tests — translate without performing a network call. */
export const __test = { toOpenAiMessages, toOpenAiTools, openAiResponseToClaude };
