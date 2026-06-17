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
  | "beam_compare_overlap"
  | "beam_research_web";

/**
 * `beam_propose_collection` resolves catalog fragrances into add-ready payloads
 * and emits a `proposal` event. It writes NOTHING server-side: the actual vault
 * write is the user tapping Confirm in the app, which goes through the existing
 * authenticated `/api/wardrobe` path. So "confirm before write" holds without a
 * model-constructed token.
 */
/**
 * `beam_show_scent_profile`, `beam_compare_fragrances`, and
 * `beam_present_travel_kit` are the agent's UI-card surface: each resolves its
 * data against the real catalog/vault server-side and emits a `card` event the
 * SPA renders as a native component (a radar, a side-by-side compare, a kit
 * board). Like `beam_propose_collection` they write NOTHING — the travel-kit's
 * "new" lane is add-ready but only saved when the user taps Confirm. They are
 * additive and gated on the same `resolveCatalogEntry` dep, so lean/read-only
 * deploys never see them.
 */
export type BeamCardToolName =
  | "beam_show_scent_profile"
  | "beam_compare_fragrances"
  | "beam_present_travel_kit";

export type BeamToolName = BeamReadToolName | "beam_propose_collection" | BeamCardToolName;

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

export type BeamSlotKey = "month" | "destination" | "occasion" | "vibe" | "direction" | "budget";

export type BeamSessionSlots = Partial<Record<BeamSlotKey, string>>;

export type BeamMissionIntent = "travel_kit" | "recommendation";

export type BeamMissionState = {
  intent?: BeamMissionIntent;
  ownedCount?: number;
  newCount?: number;
  destination?: string;
  month?: string;
  userDelegatedChoice?: boolean;
};

export type BeamSessionState = {
  slots: BeamSessionSlots;
  mission?: BeamMissionState;
  userDelegatedChoice?: boolean;
};

export type BeamSessionRecord = {
  turns: ClaudeMessage[];
  state: BeamSessionState;
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
  /**
   * OPTIONAL: derive a client-facing event from a successful tool result (e.g.
   * `beam_propose_collection` → a `proposal` card). The loop emits it right after
   * `tool_completed`. Must never throw on the loop's behalf — the loop guards it.
   */
  clientEvent?: (result: unknown) => BeamRunEvent | null;
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

export type BeamGroundedFragrance = {
  canonicalName: string;
  brand?: string;
  owned: boolean;
};

/**
 * A tap-to-continue chip the agent offers with its reply (e.g. after asking a
 * follow-up question). Model-authored, so it is length/count-clamped before it
 * reaches the client. `value` is what gets sent/typed when tapped; `label` is
 * what's shown (they're usually identical).
 */
export type BeamSuggestion = { label: string; value: string };

/**
 * An add-ready fragrance the agent proposes for the user's vault, resolved from
 * the catalog (NOT model-authored free text). Shaped to drop straight into the
 * app's normal wardrobe-add path. `scentVector` is the server-built 6-axis
 * profile; `imageUrl`/storage fields let the add hydrate an image immediately.
 */
export type BeamProposalItem = {
  name: string;
  brand: string;
  family?: string;
  notes: string[];
  pyramid?: { top: string[]; heart: string[]; base: string[] };
  accords: string[];
  scentVector?: {
    freshness: number;
    sweetness: number;
    woodiness: number;
    spice: number;
    warmth: number;
    musk: number;
  };
  performance?: { sillage?: number | string; longevity?: number | string };
  concentration?: string;
  imageUrl?: string;
  storagePath?: string;
  imageHash?: string;
  storageProvider?: string;
  sourceProvider?: string;
  description?: string;
};

/** The server-built 6-axis scent fingerprint (0..1 per axis). */
export type BeamScentVector = {
  freshness: number;
  sweetness: number;
  woodiness: number;
  spice: number;
  warmth: number;
  musk: number;
};

/**
 * A fragrance as rendered inside an agent-emitted UI card. Always resolved from
 * a real catalog/vault record server-side (never model free-text), so every
 * field the card shows is grounded. `owned` marks a bottle the user already has
 * in their vault (verified against `loadVault`, not claimed by the model).
 */
export type BeamCardFragrance = {
  name: string;
  brand: string;
  family?: string;
  accords: string[];
  scentVector?: BeamScentVector;
  owned?: boolean;
  imageUrl?: string;
  storagePath?: string;
  imageHash?: string;
  storageProvider?: string;
};

/**
 * A native UI card the agent chooses to surface mid-conversation. The model
 * picks the card kind and which (already-retrieved) fragrances to feature; the
 * server resolves and fills every datum, so the SPA can render a trusted
 * component instead of parsing prose. Three kinds today — keep this union and
 * the SPA's `BeamCard` renderer in lockstep.
 */
export type BeamCard =
  | {
      kind: "scent_profile";
      fragrance: BeamCardFragrance;
      pyramid?: { top: string[]; heart: string[]; base: string[] };
      /** One short, server-passed-through line of model context (≤180 chars). */
      caption?: string;
    }
  | {
      kind: "compare";
      a: BeamCardFragrance;
      b: BeamCardFragrance;
      /** 0..100 — deterministic overlap likelihood (same wardrobe slot). */
      overlapPercent: number;
      band: "high" | "moderate" | "some" | "low";
      sharedNotes: string[];
      sharedAccords: string[];
      verdict?: string;
    }
  | {
      kind: "travel_kit";
      title?: string;
      /** Bottles from the user's vault (verified owned). Display-only. */
      ownedPicks: BeamCardFragrance[];
      /** Add-ready new picks — saved only on the user's explicit Confirm. */
      newPicks: BeamProposalItem[];
      /** Lets the kit's "Add new picks" button reuse the proposal add path. */
      proposalId?: string;
    };

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
  | { type: "proposal"; proposalId: string; items: BeamProposalItem[] }
  | { type: "card"; card: BeamCard }
  | { type: "slots"; slots: BeamSessionSlots; mission?: BeamMissionState }
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
