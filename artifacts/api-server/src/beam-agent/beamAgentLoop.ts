/**
 * Beam Agent — the agent loop.
 *
 * This is the single thing today's Scent Mission lacks: a model that emits
 * structured tool calls, has them executed server-side, sees the results, and
 * loops until it produces a final answer. The loop is read-only in Phase 1,
 * budget-capped, and degrades gracefully (it emits a `failed` event rather than
 * throwing) so an outage never takes down the request.
 */
import type {
  BeamEmit,
  BeamRunContext,
  BeamToolDefinition,
  BeamToolName,
  ClaudeMessage,
  ClaudeToolResultBlock,
} from "./types.ts";
import {
  BEAM_LIMITS,
  extractAgentCues,
  extractText,
  extractToolUses,
  readInvalidArgs,
  summarizeToolResult,
  toClaudeTools,
} from "./beamToolCore.ts";
import type { ClaudeCallInput, ClaudeResponse } from "./types.ts";
import { callModel as defaultCallModel, isModelConfigured as defaultIsModelConfigured } from "./provider.ts";

/** Token budgets. Tool-orchestration turns are short; the closing synthesis is long. */
const ORCHESTRATION_MAX_TOKENS = 2048;
const SYNTHESIS_MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are the Beam Agent for ScentBeam, a fragrance wardrobe app. You are
a sharp, confident fragrance concierge: you ground every answer in the user's real vault and
the real catalog, then give a specific, decisive recommendation.

How to work:
- Lead with the tools. To answer almost anything about fragrances, first call the tools that
  fetch real data: beam_get_user_context to ground yourself, beam_get_wardrobe for what they
  own, beam_search_catalog to find real fragrances, beam_get_fragrance_details to deepen the
  evidence (notes, accords, performance) before you commit to a pick, and beam_score_candidates
  to rank the vault for a destination/energy + today's weather.
- Retrieve before you recommend. Pull fragrance details for any bottle you are about to
  champion so your reasoning rests on its actual notes — not on memory.
- Be specific and decisive. Name the pick, then explain in one or two sentences why its notes
  and performance fit the occasion, weather, and the user's taste. Offer a runner-up when it
  helps. Prefer a confident recommendation over a hedge.
- Offer tap-to-answer choices. When your reply asks the user a question or invites them to
  choose (occasion, mood, the vibe of a trip, budget, day vs. night), END the message with a
  fenced block of 2-4 short chips so they can answer in one tap, like:
  \`\`\`cues
  Temple mornings
  Shibuya nights
  Business meetings
  \`\`\`
  Each chip is at most ~6 words, phrased as the user's own answer. Omit the block entirely when
  you are not offering a choice (e.g. a final recommendation that needs no follow-up).

Hard rules:
- Only mention fragrances that appeared in a tool result. Never invent fragrances, notes,
  accords, ids, or prices. If a tool result is thin, say what you'd need rather than guessing.
- Weather/scoring math is done by beam_score_candidates — never compute scores yourself.
- This session is READ-ONLY: you cannot save collections or modify the vault. If asked to save
  or add a bottle, say saving is coming in a later release, then offer to recommend or rank.
- Use beam_research_web ONLY for current external facts (live price/availability,
  discontinued/reformulated/new status, unknown metadata, sample sellers, or when the user
  asks for cited sources) — not for ordinary recommendations or comparisons. If it returns a
  "note" instead of a fact, live research is unavailable: answer from what you know and say so.`;

/** Sent once if the model tries to answer the opening turn without retrieving anything. */
const RETRIEVAL_NUDGE =
  "Before answering, if this request is about specific fragrances, the user's vault, " +
  "weather/occasion fits, or a recommendation, call the appropriate tool(s) first and base " +
  "your answer on the results. If it is only a greeting or a clarifying question, answer directly.";

/** Last-turn instruction for the dedicated, tool-free synthesis pass. */
const SYNTHESIS_NUDGE =
  "You now have enough evidence. Write the final answer for the user: a specific, confident " +
  "recommendation grounded ONLY in the fragrances and facts returned by the tools above. Name " +
  "the pick(s), and in one or two sentences each, say why their notes and performance fit. Do " +
  "not call any more tools. If you are asking the user to choose or clarify, end with the " +
  "```cues block of 2-4 short tap chips described above; otherwise omit it.";

export type RunBeamAgentInput = {
  ctx: BeamRunContext;
  userMessage: string;
  tools: BeamToolDefinition[];
  emit: BeamEmit;
  /** Orchestration model (tool-calling turns). Defaults to the provider default. */
  model?: string;
  /**
   * Stronger model for the final, tool-free synthesis turn. When it differs from
   * the orchestration model the closing recommendation is written by it; when it
   * matches, the synthesis turn still runs (tool-free, larger token budget,
   * streamed) so the final prose is never the clipped inline draft.
   */
  synthesisModel?: string;
  /**
   * Prior conversation as clean alternating text turns (no tool plumbing). The
   * route loads this from the per-session store so follow-ups keep context.
   */
  history?: ClaudeMessage[];
  /** Called with the final assistant text on success, so the caller can persist the turn. */
  onComplete?: (assistantText: string) => void;
  /**
   * Called exactly once when the run ends (any outcome) with a structured
   * summary the route logs for observability + cost accounting.
   */
  onSummary?: (summary: BeamRunSummary) => void;
  maxTurns?: number;
  /** Cooperative cancellation, checked between turns/tool calls. */
  shouldStop?: () => boolean;
  /**
   * Provider seam. Defaults to the real provider; injected by tests so the loop
   * can be driven deterministically without a network call.
   */
  callModel?: (input: ClaudeCallInput) => Promise<ClaudeResponse>;
  isModelConfigured?: () => boolean;
};

/**
 * One-line-per-run structured record. `outcome` is the coarse result and
 * `failureCode` distinguishes the failure kinds the route counts (model_unavailable,
 * stopped, max_turns, agent_error). Token counts are best-effort provider sums.
 */
export type BeamRunSummary = {
  runId: string;
  outcome: "completed" | "failed";
  failureCode?: string;
  turns: number;
  tools: string[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  usedSynthesis: boolean;
  synthesisFailed: boolean;
  ms: number;
};

/** Keep at most this many prior text turns when seeding, to bound the token cost. */
const MAX_HISTORY_TURNS = 16;

/**
 * Trim seeded history to the most recent turns and guarantee it begins on a user
 * turn, so the provider never sees a dangling assistant-first transcript.
 */
function seedHistory(history: ClaudeMessage[] | undefined): ClaudeMessage[] {
  if (!history || history.length === 0) return [];
  let trimmed = history.slice(-MAX_HISTORY_TURNS);
  while (trimmed.length > 0 && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
  return trimmed;
}

/**
 * Append the synthesis instruction without creating two consecutive user turns
 * (which the Anthropic API rejects): when the transcript already ends on a user
 * turn — it does, on the last tool_result round — fold the instruction into that
 * turn as an extra text block; otherwise add a fresh user turn.
 */
function withSynthesisInstruction(messages: ClaudeMessage[]): ClaudeMessage[] {
  const out = messages.slice();
  const last = out[out.length - 1];
  const instruction = { type: "text", text: SYNTHESIS_NUDGE } as const;
  if (last && last.role === "user") {
    const blocks = Array.isArray(last.content)
      ? [...last.content, instruction]
      : [{ type: "text", text: last.content } as const, instruction];
    out[out.length - 1] = { role: "user", content: blocks };
  } else {
    out.push({ role: "user", content: SYNTHESIS_NUDGE });
  }
  return out;
}

/**
 * Drives the read-only Beam agent to completion, emitting client-safe progress
 * events. Never throws: failures are reported as a `failed` event.
 */
export async function runBeamAgent(input: RunBeamAgentInput): Promise<void> {
  const { ctx, tools, emit } = input;
  const callModel = input.callModel ?? defaultCallModel;
  const isModelConfigured = input.isModelConfigured ?? defaultIsModelConfigured;

  // Run-scoped accounting, emitted once at the end for observability + cost.
  const startedAt = Date.now();
  const toolsUsed: string[] = [];
  let outcome: BeamRunSummary["outcome"] = "failed";
  let failureCode: string | undefined;
  let turnCount = 0;
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usedSynthesis = false;
  let synthesisFailed = false;

  const recordUsage = (response: ClaudeResponse): void => {
    modelCalls++;
    if (response.usage) {
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
    }
  };
  const fail = (code: string, message: string): void => {
    failureCode = code;
    emit({ type: "failed", code, message });
  };

  try {
    if (!isModelConfigured()) {
      fail(
        "model_unavailable",
        "The agent model is not configured yet. Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) to enable Beam Agent.",
      );
      return;
    }

    const maxTurns = Math.min(input.maxTurns ?? BEAM_LIMITS.maxAgentTurns, BEAM_LIMITS.maxAgentTurns);
    const toolByName = new Map<BeamToolName, BeamToolDefinition>(tools.map((tool) => [tool.name, tool]));
    const claudeTools = toClaudeTools(tools);

    const messages: ClaudeMessage[] = [
      ...seedHistory(input.history),
      { role: "user", content: input.userMessage.slice(0, BEAM_LIMITS.maxUserMessageLength) },
    ];

    let usedTools = false;
    let retrievalNudged = false;

    /**
     * Finish the run: write the closing answer and persist it. When tools produced
     * evidence, run a dedicated tool-free synthesis turn (stronger model, larger
     * budget, streamed) instead of shipping the orchestration model's clipped
     * inline draft. `draft` is that inline text, used as a fallback.
     */
    const finish = async (draft: string): Promise<void> => {
      let finalText = draft;
      if (usedTools) {
        usedSynthesis = true;
        emit({ type: "status", label: "Writing your recommendation" });
        const synthMessages = withSynthesisInstruction(messages);
        try {
          const synth = await callModel({
            system: SYSTEM_PROMPT,
            messages: synthMessages,
            tools: [],
            model: input.synthesisModel ?? input.model,
            maxTokens: SYNTHESIS_MAX_TOKENS,
            onDelta: (chunk) => emit({ type: "message_delta", text: chunk }),
          });
          recordUsage(synth);
          const synthText = extractText(synth.content);
          if (synthText) finalText = synthText;
          else synthesisFailed = true;
        } catch {
          // Streaming/synthesis failed — keep the orchestration draft so the user
          // still gets an answer rather than a failed run. Flagged in the summary
          // so a high synthesis-failure rate is visible, not silent.
          synthesisFailed = true;
        }
      }
      // Split off any trailing ```cues block so the visible answer stays clean
      // and the chips ride their own event the UI can render as tap buttons.
      const { text: parsed, cues } = extractAgentCues(finalText || "Done.");
      const response = parsed || "Done.";
      messages.push({ role: "assistant", content: response });
      outcome = "completed";
      input.onComplete?.(response);
      if (cues.length > 0) {
        emit({ type: "suggestions", items: cues.map((label) => ({ label, value: label })) });
      }
      emit({ type: "completed", response });
    };

    emit({ type: "status", label: "Understanding your request" });

    for (let turn = 0; turn < maxTurns; turn++) {
      if (input.shouldStop?.()) {
        fail("stopped", "Run stopped.");
        return;
      }

      turnCount++;
      const response = await callModel({
        system: SYSTEM_PROMPT,
        messages,
        tools: claudeTools,
        model: input.model,
        maxTokens: ORCHESTRATION_MAX_TOKENS,
      });
      recordUsage(response);

      const toolUses = extractToolUses(response.content);
      const text = extractText(response.content);

      if (toolUses.length === 0) {
        // The model wants to answer. If it never retrieved anything, nudge it once
        // toward the tools before accepting a from-memory reply.
        if (!usedTools && !retrievalNudged) {
          retrievalNudged = true;
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: RETRIEVAL_NUDGE });
          continue;
        }
        await finish(text);
        return;
      }

      // Preserve the assistant turn verbatim so the tool_use ids line up with the
      // tool_result blocks we send back on the next user turn.
      messages.push({ role: "assistant", content: response.content });
      usedTools = true;

      const results: ClaudeToolResultBlock[] = [];
      for (const use of toolUses) {
        if (input.shouldStop?.()) {
          fail("stopped", "Run stopped.");
          return;
        }
        const def = toolByName.get(use.name as BeamToolName);
        if (!def) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `Unknown tool: ${use.name}`,
            is_error: true,
          });
          emit({ type: "status", label: "Skipped an unavailable tool" });
          continue;
        }

        // The provider couldn't parse the model's arguments. Tell it explicitly so
        // it retries with valid JSON instead of running the tool on coerced-empty
        // args and reading the empty result as "nothing exists."
        const invalidArgs = readInvalidArgs(use.input);
        if (invalidArgs !== null) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `Your arguments for ${def.name} were not valid JSON. Re-call ${def.name} with a single valid JSON object.`,
            is_error: true,
          });
          emit({ type: "tool_completed", tool: def.name, summary: "invalid arguments" });
          continue;
        }

        toolsUsed.push(def.name);
        emit({ type: "tool_started", tool: def.name });
        try {
          const result = await def.handler(use.input, ctx);
          const serialized = JSON.stringify(result).slice(0, BEAM_LIMITS.maxToolResultChars);
          results.push({ type: "tool_result", tool_use_id: use.id, content: serialized });
          emit({ type: "tool_completed", tool: def.name, summary: summarizeToolResult(def.name, result) });
        } catch (err) {
          const message = err instanceof Error ? err.message : "tool error";
          results.push({ type: "tool_result", tool_use_id: use.id, content: `Tool failed: ${message}`, is_error: true });
          emit({ type: "tool_completed", tool: def.name, summary: "failed" });
        }
      }

      messages.push({ role: "user", content: results });
    }

    fail("max_turns", "Reached the tool-call budget before finishing.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "agent error";
    fail("agent_error", message);
  } finally {
    input.onSummary?.({
      runId: ctx.runId,
      outcome,
      failureCode,
      turns: turnCount,
      tools: toolsUsed,
      modelCalls,
      inputTokens,
      outputTokens,
      usedSynthesis,
      synthesisFailed,
      ms: Date.now() - startedAt,
    });
  }
}
