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
 * Default hot-path (concierge) tier, as an OpenRouter slug. The default is the
 * free hy3-preview concierge model — the cheap lane for normal fragrance chat.
 * Deliberately OFF the OpenAI "harmony"/gpt-oss family: those slugs emit tool
 * calls as control markup in the plain `content` channel, which the tool-free
 * synthesis turn scrubs to empty → the "I couldn't lock in a confident match"
 * stall (`EMPTY_ANSWER_FALLBACK`). hy3 routes tools structurally, so the loop
 * gets real `tool_use` blocks and a real answer. Override per-deployment with
 * BEAM_AGENT_MODEL. Confirm the exact slug in the OpenRouter dashboard — model
 * ids are provider-namespaced (`vendor/model`), drift over time (recheck before
 * production, brief §15), and are not interchangeable with the Anthropic-direct
 * ids used by `claudeProvider.ts`.
 */
export function defaultOpenRouterModel(): string {
  return process.env.BEAM_AGENT_MODEL?.trim() || "tencent/hy3-preview:free";
}

/**
 * Synthesis / "smart closer" tier. This is the slug that writes the final,
 * tool-free recommendation where quality matters most. In production this is
 * commonly overridden (via BEAM_AGENT_MODEL_STRONG) to an Anthropic Sonnet slug
 * for the closing turn. Falls back to the strong synthesis closer (hy3-preview)
 * when unset.
 *
 * IMPORTANT: this slug is for the SYNTHESIS turn only. Do NOT reuse it for the
 * premium *orchestration* loop — that put every tool-calling turn of a premium
 * mission on the expensive closer model (a "trip/kit" keyword → 7+ closer turns
 * at ~28k input each ≈ $0.60/mission). Premium orchestration has its own,
 * deliberately cheaper tier — see `premiumOrchestrationModel()`.
 */
export function strongOpenRouterModel(): string {
  return process.env.BEAM_AGENT_MODEL_STRONG?.trim() || "tencent/hy3-preview";
}

/**
 * Premium *orchestration* tier: the model that drives the tool-calling loop on
 * the premium lane. Defaults to the same free hy3-preview concierge model as the
 * default lane — a cheap, harmony-free tool-router, NOT the synthesis closer.
 * Pinning it to its own env (`BEAM_AGENT_MODEL_PREMIUM`) is what prevents the
 * premium lane from inheriting a Sonnet `BEAM_AGENT_MODEL_STRONG` override for
 * every orchestration turn. The closing turn still escalates to the synthesis
 * tier above, so premium missions keep the quality where it counts (the final
 * recommendation) without paying closer prices for tool plumbing.
 */
export function premiumOrchestrationModel(): string {
  return process.env.BEAM_AGENT_MODEL_PREMIUM?.trim() || "tencent/hy3-preview:free";
}

/**
 * Deep-strategy tier (brief §02.1 deep_strategy): a free Nemotron reasoning slug.
 * Defined so the env contract exists; reserved for gated deep workflows (the
 * hot-path loop does NOT auto-route here — brief §14.2 "do not call the deep model
 * for normal fragrance chat").
 */
export function deepOpenRouterModel(): string {
  return process.env.BEAM_AGENT_MODEL_DEEP?.trim() || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
}

/**
 * Back-compat constants. Some callers/tests import the eager slug; these resolve
 * the env once at module load. Prefer the functions above where call-time env
 * flipping matters (mirrors researchConfig.ts).
 */
export const DEFAULT_OPENROUTER_MODEL = defaultOpenRouterModel();
export const STRONG_OPENROUTER_MODEL = strongOpenRouterModel();

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

/**
 * An OpenAI-compatible content part. OpenRouter forwards Anthropic prompt-caching
 * breakpoints as a `cache_control` field on a text part, so when the active model
 * is an Anthropic slug we send the (large, run-stable) system prompt as a single
 * cached text part instead of a bare string. Models that don't support caching
 * ignore the field; we only emit it for Anthropic slugs to avoid surprising the
 * cheap concierge lane (gemma), which keeps the plain-string shape.
 */
type OpenAiTextPart = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

type OpenAiMessage =
  | { role: "system"; content: string | OpenAiTextPart[] }
  | { role: "user"; content: string | OpenAiTextPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** True for slugs that honor Anthropic-style `cache_control` breakpoints. */
export function modelSupportsCaching(model: string | undefined): boolean {
  return /claude|anthropic/i.test(model ?? "");
}

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
function toOpenAiMessages(
  system: string,
  messages: ClaudeMessage[],
  cacheSystem = false,
): OpenAiMessage[] {
  // Mark the system prompt as a cache breakpoint for caching-capable (Anthropic)
  // models: it is identical across every call in a run (orchestration turns +
  // synthesis), so caching it makes calls 2..N read it at ~10% of input price
  // instead of re-billing the full prefix each turn.
  const systemContent: OpenAiMessage = cacheSystem
    ? { role: "system", content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] }
    : { role: "system", content: system };
  const out: OpenAiMessage[] = [systemContent];

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

  // Transcript caching for caching-capable (Anthropic) models. The system prompt
  // is already a cache breakpoint above; here we also mark the LAST user turn so
  // the whole prefix before it (system + every tool result + assistant turn) is
  // read from cache on the next call. This matters most for the closing SYNTHESIS
  // turn, whose transcript ends on the folded user instruction and carries the
  // run's full ~25k-token tail — exactly the call where the cache discount pays
  // off. Restricted to the *user* role (the documented OpenRouter cache surface);
  // tool-role parts are intentionally left untouched.
  if (cacheSystem) markLastUserCacheBreakpoint(out);

  return out;
}

/**
 * Attach an ephemeral cache breakpoint to the most recent user message, rewriting
 * its string content into a single cached text part. No-op when there is no user
 * message or it already carries parts. Mutates the array in place (it is local to
 * the caller).
 */
function markLastUserCacheBreakpoint(messages: OpenAiMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && typeof message.content === "string") {
      messages[i] = {
        role: "user",
        content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }],
      };
      return;
    }
  }
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

/**
 * Strip OpenAI "harmony" / gpt-oss control markup that some OpenRouter slugs emit
 * inside the plain `content` channel instead of as structured `tool_calls`.
 *
 * The synthesis turn runs tool-free, so a harmony-trained model has no structured
 * channel for a call it still "wants" (e.g. `beam_compare_overlap`) and dumps it as
 * text: `<|start|>assistant<|channel|>commentary to=functions.NAME <|constrain|>json
 * <|message|>{…}<|call|>`. Rendered verbatim that reads as raw tokens to the user.
 *
 * This is a defensive adapter-layer scrub (the real fix is pointing BEAM_AGENT_MODEL*
 * at a non-harmony slug): when the harmony envelope is present we keep only the
 * user-facing `final` channel, drop `commentary`/`analysis` (tool-call + reasoning)
 * blocks, and remove any residual control tokens. Plain answers (no `<|`) pass
 * through byte-for-byte. Real OpenAI `tool_calls` are untouched — they never live in
 * `content`, so structured tool routing is unaffected.
 */
export function stripHarmonyTokens(raw: string): string {
  if (typeof raw !== "string") return "";
  if (!raw.includes("<|")) return raw;

  // Prefer the model's user-facing "final" channel when the harmony envelope wraps it.
  const finalChannel = raw.match(
    /<\|channel\|>\s*final\s*<\|message\|>([\s\S]*?)(?:<\|return\|>|<\|end\|>|<\|start\|>|$)/,
  );
  let text = finalChannel ? finalChannel[1] : raw;

  text = text
    // A whole tool-call / reasoning block: header → args → terminator.
    .replace(/<\|channel\|>\s*(?:commentary|analysis)[\s\S]*?(?:<\|call\|>|<\|end\|>|<\|return\|>)/g, "")
    // A role preamble such as "<|start|>assistant".
    .replace(/<\|start\|>\s*\w*/g, "")
    // Any remaining well-formed control token: <|message|>, <|constrain|>, <|channel|>…
    .replace(/<\|[^|>]*\|>/g, "")
    // A dangling partial token left at the end of a truncated chunk.
    .replace(/<\|[^|>]*$/g, "")
    // A leftover tool-recipient header if its block was malformed.
    .replace(/\bto=functions\.[A-Za-z0-9_.]+/g, "");

  return text.trim();
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

  if (message?.content) {
    const clean = stripHarmonyTokens(message.content);
    if (clean) content.push({ type: "text", text: clean });
  }

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
  const model = input.model ?? defaultOpenRouterModel();
  const cacheSystem = modelSupportsCaching(model);
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers,
    // Combine the caller's signal (client disconnect / run deadline) WITH the
    // upstream timeout instead of letting a supplied signal disable the timeout —
    // a hung socket that never trips the caller's deadline must still abort.
    signal: input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(OPENROUTER_TIMEOUT_MS)])
      : AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      max_tokens: input.maxTokens ?? 1024,
      messages: toOpenAiMessages(input.system, input.messages, cacheSystem),
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
      // Keep accumulating even if the consumer throws — a downstream emit failure
      // must not abort the read and discard the fully-assembled answer.
      try {
        onDelta(chunk);
      } catch {
        /* swallow: the assembled text is still returned at the end */
      }
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
    // Flush a final frame that arrived without its trailing blank-line
    // terminator (some backends end the stream right after the last `data:`
    // line). Dropping it lost the tail text chunk and — worse — the
    // include_usage frame, silently zeroing the run's token/cost accounting.
    buffer += decoder.decode();
    for (const rawLine of buffer.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("data:")) handleData(line.slice(5).replace(/^ /, ""));
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  // Scrub harmony control markup from the assembled answer before it becomes the
  // synthesis reply (the streamed deltas are not rendered as text by the client —
  // it shows a static "Composing your reply" — so the whole-text pass here is the
  // correct boundary and avoids splitting a token across two SSE frames).
  const cleanText = stripHarmonyTokens(text);

  return {
    stop_reason: mapFinishReason(finishReason),
    content: cleanText ? [{ type: "text", text: cleanText }] : [],
    usage: usageFromOpenAi(usage),
  };
}

/** Exposed for unit tests — translate without performing a network call. */
export const __test = { toOpenAiMessages, toOpenAiTools, openAiResponseToClaude };
