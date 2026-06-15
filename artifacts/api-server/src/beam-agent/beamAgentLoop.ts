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
  collectGroundedFragranceNames,
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

/**
 * Hard wall-clock budget for an entire run. Kept under the SPA's 60s client
 * timeout (ScentMissionPanel BEAM_AGENT_TIMEOUT_MS) so the server emits a real
 * completed/failed result before the client gives up and silently falls back to
 * the scripted path.
 */
const RUN_BUDGET_MS = 52_000;
/**
 * Per-tool execution ceiling. Tool handlers have no AbortSignal of their own, so
 * a slow scrape/DB call could otherwise stall the whole loop until the client
 * times out. The underlying work may keep running; the loop just stops waiting.
 */
const TOOL_TIMEOUT_MS = 20_000;
/**
 * Cap on "you narrated a step but didn't call the tool / you got cut off"
 * re-prompts, so a model that insists on narrating still terminates.
 */
const MAX_ACT_NUDGES = 2;

const SYSTEM_PROMPT = `You are the Beam Agent for ScentBeam, a fragrance wardrobe app. You are
a sharp, confident fragrance concierge: you ground every answer in the user's real vault and
the real catalog, then give a specific, decisive recommendation.

How to work:
- Lead with the tools. To answer almost anything about fragrances, first call the tools that
  fetch real data: beam_get_user_context to ground yourself, beam_get_wardrobe for what they
  own, beam_search_catalog to find real fragrances, beam_get_fragrance_details to deepen the
  evidence (notes, accords, performance) before you commit to a pick, and beam_score_candidates
  to rank the vault for a destination/energy + weather.
- Ground EVERY vault pick in the scorer. When you recommend more than one bottle the user owns,
  ask beam_score_candidates for that many picks (its limit) and name only the ones it returns —
  never add a second "from the vault" pick the scorer didn't rank.
- Score for the right place. beam_score_candidates uses the user's CURRENT local weather by
  default. When the request is about a trip or a destination with a different climate, pass that
  place's typical weather for the travel dates as weatherOverride plus a locationLabel like
  "Tokyo, June" so the ranking reflects where they are going. Reference the locationLabel/weather
  the tool echoes back; never silently score a trip against home weather.
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

Building a collection (e.g. for a trip or an occasion):
1. Ground first — read their vault (beam_get_wardrobe / beam_get_user_context) and name the
   dominant notes/families you actually see.
2. Confirm the plan BEFORE proposing — tell them your read of their taste and exactly what you'll
   look for (how many new bottles, the direction), and offer cues so they confirm or adjust in a tap.
3. Once they've agreed to the direction, DO IT in that same turn: call beam_search_catalog for
   fitting NEW (unowned) fragrances, deepen the best ones with beam_get_fragrance_details, then call
   beam_propose_collection with your final picks. Do NOT ask a second time ("shall I line these up?")
   — their agreement to the plan IS the go-ahead. beam_propose_collection renders the confirmation
   card; after you call it, briefly say you've lined the picks up for their review, then stop.
The app then shows the user a confirmation card and saves ONLY what they approve.

Hard rules:
- Act, don't narrate. When you say you're about to search, score, pull details, or look something
  up, CALL that tool in the SAME turn — never end a message on a promise to act ("now let me…") and
  wait for the user. Either emit the tool call now or give the final answer.
- Only mention fragrances that appeared in a tool result. Never invent fragrances, notes,
  accords, ids, or prices. If a tool result is thin, say what you'd need rather than guessing.
- Weather/scoring math is done by beam_score_candidates — never compute scores yourself.
- You never write to the vault yourself. beam_propose_collection only PROPOSES; the user's Confirm
  performs the save. So never say you have added, saved, or enshrined anything — say you've lined
  the picks up for their confirmation.
- Use beam_research_web ONLY for current external facts (live price/availability,
  discontinued/reformulated/new status, unknown metadata, sample sellers, or when the user
  asks for cited sources) — not for ordinary recommendations or comparisons. If it returns a
  "note" instead of a fact, live research is unavailable: answer from what you know and say so.`;

/** Sent once if the model tries to answer the opening turn without retrieving anything. */
const RETRIEVAL_NUDGE =
  "Before answering, if this request is about specific fragrances, the user's vault, " +
  "weather/occasion fits, or a recommendation, call the appropriate tool(s) first and base " +
  "your answer on the results. If it is only a greeting or a clarifying question, answer directly.";

/**
 * Sent when the model ended a turn without calling tools but clearly wasn't done —
 * it either announced a next step in prose ("now let me search…") or got cut off at
 * the token cap. Pushes it to ACT rather than treating the dangling turn as a final
 * answer (the bug that made the agent stop mid-plan and wait for the user's "Ok").
 */
const ACT_NUDGE =
  "You stopped before finishing. If you still need data, call the tool(s) now — emit the " +
  "actual tool calls, do not just describe them. If you already have enough evidence, write " +
  "the final recommendation instead. Do not end your turn on a promise to act.";

/** Last-turn instruction for the dedicated, tool-free synthesis pass. */
const SYNTHESIS_NUDGE =
  "You now have enough evidence. Write the final answer for the user: a specific, confident " +
  "recommendation grounded ONLY in the fragrances and facts returned by the tools above. Name " +
  "the pick(s), and in one or two sentences each, say why their notes and performance fit. Do " +
  "not call any more tools. If you are asking the user to choose or clarify, end with the " +
  "```cues block of 2-4 short tap chips described above; otherwise omit it.";

/** How many grounded fragrance names to pin into the synthesis allowlist. */
const MAX_GROUNDED_ALLOWLIST = 40;

/**
 * Build the closing-turn allowlist clause from the fragrances actually retrieved
 * this run. Pinning the synthesis to this exact set is the mechanical guard
 * against hallucinated picks (the prompt rule alone was unenforced). Empty when
 * nothing was retrieved (e.g. a greeting), so the clause is simply omitted.
 */
function groundingAllowlistClause(names: string[]): string {
  if (names.length === 0) return "";
  const listed = names.slice(0, MAX_GROUNDED_ALLOWLIST);
  return (
    " You may name ONLY these fragrances, which were actually retrieved by the tools this run: " +
    listed.map((n) => `"${n}"`).join(", ") +
    ". Do NOT name any fragrance outside this list — if you feel one is missing, say what you'd " +
    "need to look up rather than naming it from memory."
  );
}

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
  /** Distinct fragrances retrieved this run and pinned into the answer allowlist. */
  groundedNames: number;
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
function withSynthesisInstruction(messages: ClaudeMessage[], instructionText: string): ClaudeMessage[] {
  const out = messages.slice();
  const last = out[out.length - 1];
  const instruction = { type: "text", text: instructionText } as const;
  if (last && last.role === "user") {
    const blocks = Array.isArray(last.content)
      ? [...last.content, instruction]
      : [{ type: "text", text: last.content } as const, instruction];
    out[out.length - 1] = { role: "user", content: blocks };
  } else {
    out.push({ role: "user", content: instructionText });
  }
  return out;
}

/**
 * Reject if `promise` does not settle within `ms`. The underlying work may keep
 * running (tool handlers have no cancellation seam yet), but the loop stops
 * waiting on it so a single slow tool can't stall the whole run.
 */
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Heuristic: did the model end a tool-free turn by PROMISING tool work instead of
 * doing it (e.g. "now let me score your vault and search for two…")? We re-prompt
 * it to act in that case. Conservative on purpose — requires a first-person future
 * intent AND a retrieval verb, and never fires when the reply is offering the user
 * a choice (a fenced ```cues block), which is a deliberate pause for their input.
 */
function announcesPendingToolWork(text: string): boolean {
  if (!text) return false;
  if (/```+\s*cues\b/i.test(text)) return false;
  const intent =
    /\b(let me|i['’]?ll|i will|i['’]?m going to|going to|let['’]?s|now i['’]?ll|hold on|one moment|give me a (?:sec|second|moment))\b/i;
  const retrieval =
    /\b(search|searching|score|scoring|look up|looking up|pull|pulling|fetch|check|find|scan|research)\b/i;
  return intent.test(text) && retrieval.test(text);
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
  const deadline = startedAt + RUN_BUDGET_MS;
  const toolsUsed: string[] = [];
  let outcome: BeamRunSummary["outcome"] = "failed";
  let failureCode: string | undefined;
  let turnCount = 0;
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usedSynthesis = false;
  let synthesisFailed = false;
  // Fragrances actually returned by tools this run, keyed lowercased for dedupe
  // (value preserves display casing). The closing answer is pinned to this set.
  const groundedNames = new Map<string, string>();
  const addGroundedNames = (names: string[]): void => {
    for (const name of names) {
      if (groundedNames.size >= MAX_GROUNDED_ALLOWLIST) break;
      const key = name.toLowerCase();
      if (!groundedNames.has(key)) groundedNames.set(key, name);
    }
  };

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
  // A per-call abort signal bounded by BOTH the provider's own ceiling and the
  // remaining run budget, so a single model call can never overrun the whole run.
  const callBudgetSignal = (): AbortSignal =>
    AbortSignal.timeout(Math.min(45_000, Math.max(1_000, deadline - Date.now())));

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
    let actNudges = 0;
    // Most recent non-empty assistant prose; shipped as the answer if we hit the
    // run budget mid-orchestration (better than a scripted-fallback non-sequitur).
    let lastText = "";

    /**
     * Finish the run: write the closing answer and persist it. When tools produced
     * evidence, run a dedicated tool-free synthesis turn (stronger model, larger
     * budget, streamed) instead of shipping the orchestration model's clipped
     * inline draft. `draft` is that inline text, used as a fallback.
     */
    const finish = async (draft: string, opts?: { skipSynthesis?: boolean }): Promise<void> => {
      let finalText = draft;
      // Don't open a fresh synthesis call once we're already out of wall-clock
      // budget — that extra round could push the response past the client's 60s
      // timeout. Ship the grounded draft instead.
      const outOfTime = Date.now() >= deadline;
      if (usedTools && !opts?.skipSynthesis && !outOfTime) {
        usedSynthesis = true;
        emit({ type: "status", label: "Writing your recommendation" });
        const instruction = SYNTHESIS_NUDGE + groundingAllowlistClause([...groundedNames.values()]);
        const synthMessages = withSynthesisInstruction(messages, instruction);
        try {
          const synth = await callModel({
            system: SYSTEM_PROMPT,
            messages: synthMessages,
            tools: [],
            model: input.synthesisModel ?? input.model,
            maxTokens: SYNTHESIS_MAX_TOKENS,
            signal: callBudgetSignal(),
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
      // Out of wall-clock budget. Ship the best grounded draft we have rather than
      // dead-spinning until the client's 60s timeout fires and falls back.
      if (Date.now() >= deadline) {
        if (usedTools && lastText) await finish(lastText, { skipSynthesis: true });
        else fail("run_timeout", "The agent ran out of time before finishing.");
        return;
      }

      turnCount++;
      let response: ClaudeResponse;
      try {
        response = await callModel({
          system: SYSTEM_PROMPT,
          messages,
          tools: claudeTools,
          model: input.model,
          maxTokens: ORCHESTRATION_MAX_TOKENS,
          signal: callBudgetSignal(),
        });
      } catch (err) {
        // A budget/abort timeout mid-call: degrade to the best draft we already
        // have instead of surfacing a raw "operation aborted" error to the user.
        const aborted =
          Date.now() >= deadline ||
          (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));
        if (aborted && usedTools && lastText) {
          await finish(lastText, { skipSynthesis: true });
          return;
        }
        throw err;
      }
      recordUsage(response);

      const toolUses = extractToolUses(response.content);
      const text = extractText(response.content);
      if (text) lastText = text;

      if (toolUses.length === 0) {
        // The model wants to answer. If it never retrieved anything, nudge it once
        // toward the tools before accepting a from-memory reply.
        if (!usedTools && !retrievalNudged) {
          retrievalNudged = true;
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: RETRIEVAL_NUDGE });
          continue;
        }
        // It didn't call tools but isn't actually done: it narrated a next step
        // ("let me search…") or was cut off at the token cap. Push it to act rather
        // than mistaking the dangling turn for a final answer. Bounded by
        // MAX_ACT_NUDGES so a model that insists on narrating still terminates.
        const cutOff = response.stop_reason === "max_tokens";
        if (actNudges < MAX_ACT_NUDGES && (cutOff || announcesPendingToolWork(text))) {
          actNudges++;
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: ACT_NUDGE });
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
        if (Date.now() >= deadline) {
          // Out of time mid-round. Every tool_use id still needs a matching
          // tool_result or the next model call is rejected, so emit an error
          // result for the rest; the top-of-loop budget check then finishes.
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: "Skipped: the agent ran out of time.",
            is_error: true,
          });
          continue;
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

        // Run the handler. A failure (including the per-tool timeout) becomes a
        // single is_error tool_result and we move on.
        let result: unknown;
        try {
          result = await raceTimeout(def.handler(use.input, ctx), TOOL_TIMEOUT_MS, def.name);
        } catch (err) {
          const message = err instanceof Error ? err.message : "tool error";
          results.push({ type: "tool_result", tool_use_id: use.id, content: `Tool failed: ${message}`, is_error: true });
          emit({ type: "tool_completed", tool: def.name, summary: "failed" });
          continue;
        }

        // Serialize the success. JSON.stringify can throw (circular refs, BigInt);
        // treat that as a tool error so the model knows it got no usable data,
        // rather than silently dropping the result.
        let serialized: string;
        try {
          serialized = JSON.stringify(result).slice(0, BEAM_LIMITS.maxToolResultChars);
        } catch {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `Tool ${def.name} returned a result that could not be serialized.`,
            is_error: true,
          });
          emit({ type: "tool_completed", tool: def.name, summary: "failed" });
          continue;
        }
        results.push({ type: "tool_result", tool_use_id: use.id, content: serialized });
        // Register the fragrances this result actually grounds, so the closing
        // synthesis can be pinned to only naming fragrances we retrieved.
        addGroundedNames(collectGroundedFragranceNames(result));

        // Reporting + UI side-effects happen AFTER the result is recorded and are
        // fully isolated: a throw here must never fall through to the failure path
        // above, which would push a SECOND tool_result for this same tool_use_id
        // and make the next model call reject the transcript.
        try {
          emit({ type: "tool_completed", tool: def.name, summary: summarizeToolResult(def.name, result) });
          // Some tools surface a structured card to the UI (e.g. a collection proposal).
          if (def.clientEvent) {
            const extra = def.clientEvent(result);
            if (extra) emit(extra);
          }
        } catch {
          /* summary/client-event failures are non-fatal — the run continues */
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
      groundedNames: groundedNames.size,
      ms: Date.now() - startedAt,
    });
  }
}
