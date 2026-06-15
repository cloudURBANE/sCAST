/**
 * Beam Agent — shared types.
 *
 * Framework-agnostic and DEPENDENCY-FREE: nothing here imports a workspace
 * package, a third-party module, or even a Node built-in. That keeps the type
 * surface (and the pure `beamToolCore` logic that builds on it) unit-testable in
 * isolation, and lets the same tool contract be reused later by a Hermes/MCP
 * runtime without change. See docs/beam-agent/.
 */

/**
 * Read-only tool surface for Phase 1. Write tools (save collection, add to
 * wardrobe) arrive in Phase 4 behind app-issued confirmation tokens and are
 * deliberately NOT part of this union yet.
 */
export type BeamReadToolName =
  | "beam_get_user_context"
  | "beam_get_wardrobe"
  | "beam_search_catalog"
  | "beam_get_fragrance_details"
  | "beam_score_candidates"
  | "beam_research_web";

export type BeamToolName = BeamReadToolName;

/**
 * Run context derived from the authenticated app session — NEVER from model
 * arguments. Every tool reads tenant/user scope from here, so a model can never
 * widen its own access by passing a different id. See docs/beam-agent/04.
 */
export type BeamRunContext = {
  runId: string;
  sessionId: string;
  tenantId: string;
  userId: string;
};

/** Minimal JSON-schema shape Claude needs to advertise a tool. */
export type BeamJsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/** A tool the agent can call. `handler` runs server-side with the run context. */
export type BeamToolDefinition = {
  name: BeamToolName;
  description: string;
  inputSchema: BeamJsonSchema;
  /** Read-only in Phase 1. Returns a JSON-serializable result. */
  handler: (input: unknown, ctx: BeamRunContext) => Promise<unknown>;
};

/**
 * Compact, normalized evidence the model selects from. The model may only
 * recommend fragranceIds that appeared in a CandidatePacket from a tool result.
 */
export type CandidatePacket = {
  fragranceId: string;
  canonicalName: string;
  brand: string;
  owned: boolean;
  notes: { top: string[]; middle: string[]; base: string[] };
  accords: string[];
  performance: { longevity?: number | string; projection?: number | string };
  /** 0..1 — how complete/trusted the underlying record is. */
  sourceConfidence: number;
  missingFields: string[];
};

/**
 * A tap-to-continue chip the agent offers with its reply (e.g. after asking a
 * follow-up question). Model-authored, so it is length/count-clamped before it
 * reaches the client. `value` is what gets sent/typed when tapped; `label` is
 * what's shown (they're usually identical).
 */
export type BeamSuggestion = { label: string; value: string };

/**
 * Client-safe event stream. Raw tool arguments, DB ids, stack traces, provider
 * credentials, and system prompts must NEVER reach the browser — see
 * `redactEventForClient`.
 */
export type BeamRunEvent =
  | { type: "status"; label: string }
  | { type: "message_delta"; text: string }
  | { type: "tool_started"; tool: BeamToolName }
  | { type: "tool_completed"; tool: BeamToolName; summary: string }
  | { type: "suggestions"; items: BeamSuggestion[] }
  | { type: "completed"; response: string }
  | { type: "failed"; code: string; message: string };

export type BeamEmit = (event: BeamRunEvent) => void;

/* ------------------------------------------------------------------ */
/* Minimal Claude Messages API shapes (we call the REST API via fetch) */
/* ------------------------------------------------------------------ */

export type ClaudeTextBlock = { type: "text"; text: string };
export type ClaudeToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
/** Permissive fall-through member so tool_result blocks are assignable too. */
export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | { type: string; [key: string]: unknown };

export type ClaudeToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ClaudeMessage = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

/** Token usage for one model call, normalized across providers (best-effort). */
export type ClaudeUsage = { inputTokens: number; outputTokens: number };

export type ClaudeResponse = {
  stop_reason: string | null;
  content: ClaudeContentBlock[];
  /** Present when the provider reported token counts; used for cost accounting. */
  usage?: ClaudeUsage;
};

/**
 * Provider-agnostic call input. Both the Anthropic-direct provider and the
 * OpenRouter adapter accept this exact shape; the adapter translates it to the
 * OpenAI chat-completions dialect on the wire and translates the reply back into
 * the `ClaudeResponse` block shape the loop already understands. Keeping this in
 * `types.ts` (dependency-free) lets every provider share one contract.
 */
export type ClaudeCallInput = {
  system: string;
  messages: ClaudeMessage[];
  tools: Array<{ name: string; description: string; input_schema: unknown }>;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * When provided, the provider streams the model's TEXT output and invokes this
   * with each incremental chunk, then returns the assembled `ClaudeResponse` as
   * usual. Only the text channel is streamed — callers that stream must pass an
   * empty `tools` array (the loop only streams the tool-free synthesis turn). A
   * provider may ignore this and answer non-streamed; the assembled result is
   * identical either way.
   */
  onDelta?: (textChunk: string) => void;
};
