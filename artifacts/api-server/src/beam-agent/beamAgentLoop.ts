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
  extractText,
  extractToolUses,
  summarizeToolResult,
  toClaudeTools,
} from "./beamToolCore.ts";
import { callClaude, isClaudeConfigured } from "./claudeProvider.ts";

const SYSTEM_PROMPT = `You are the Beam Agent for ScentBeam, a fragrance wardrobe app.
You help the user understand their vault and discover REAL fragrances, using tools.

Rules:
- ALWAYS use tools to retrieve facts. Never invent fragrances, notes, accords, ids, or prices.
- Only mention fragrances that appeared in a tool result.
- Weather/scoring math is done by beam_score_candidates — never compute scores yourself.
- This session is READ-ONLY. You cannot save collections or modify the vault. If the user
  asks to save or add a bottle, explain that saving will arrive in a later release and is not
  available yet, then offer to recommend or rank instead.
- Be concise and concrete. When you recommend, say briefly why each pick fits.`;

export type RunBeamAgentInput = {
  ctx: BeamRunContext;
  userMessage: string;
  tools: BeamToolDefinition[];
  emit: BeamEmit;
  model?: string;
  maxTurns?: number;
  /** Cooperative cancellation, checked between turns/tool calls. */
  shouldStop?: () => boolean;
};

/**
 * Drives the read-only Beam agent to completion, emitting client-safe progress
 * events. Never throws: failures are reported as a `failed` event.
 */
export async function runBeamAgent(input: RunBeamAgentInput): Promise<void> {
  const { ctx, tools, emit } = input;

  if (!isClaudeConfigured()) {
    emit({
      type: "failed",
      code: "model_unavailable",
      message: "The agent model is not configured yet. Set ANTHROPIC_API_KEY to enable Beam Agent.",
    });
    return;
  }

  const maxTurns = Math.min(input.maxTurns ?? BEAM_LIMITS.maxAgentTurns, BEAM_LIMITS.maxAgentTurns);
  const toolByName = new Map<BeamToolName, BeamToolDefinition>(tools.map((tool) => [tool.name, tool]));
  const claudeTools = toClaudeTools(tools);

  const messages: ClaudeMessage[] = [
    { role: "user", content: input.userMessage.slice(0, BEAM_LIMITS.maxUserMessageLength) },
  ];

  emit({ type: "status", label: "Understanding your request" });

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (input.shouldStop?.()) {
        emit({ type: "failed", code: "stopped", message: "Run stopped." });
        return;
      }

      const response = await callClaude({
        system: SYSTEM_PROMPT,
        messages,
        tools: claudeTools,
        model: input.model,
      });

      const toolUses = extractToolUses(response.content);
      const text = extractText(response.content);

      // Preserve the assistant turn verbatim so the tool_use ids line up with the
      // tool_result blocks we send back on the next user turn.
      messages.push({ role: "assistant", content: response.content });

      if (toolUses.length === 0) {
        emit({ type: "completed", response: text || "Done." });
        return;
      }

      const results: ClaudeToolResultBlock[] = [];
      for (const use of toolUses) {
        if (input.shouldStop?.()) {
          emit({ type: "failed", code: "stopped", message: "Run stopped." });
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

    emit({ type: "failed", code: "max_turns", message: "Reached the tool-call budget before finishing." });
  } catch (err) {
    const message = err instanceof Error ? err.message : "agent error";
    emit({ type: "failed", code: "agent_error", message });
  }
}
