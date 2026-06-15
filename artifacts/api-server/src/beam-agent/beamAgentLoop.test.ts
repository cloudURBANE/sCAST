/**
 * Loop tests for the Beam Agent. The provider is injected (input.callModel) so
 * the loop runs deterministically with no network.
 *
 *   node --experimental-strip-types --test src/beam-agent/beamAgentLoop.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBeamAgent, type BeamRunSummary } from "./beamAgentLoop.ts";
import { invalidArgsMarker } from "./beamToolCore.ts";
import type {
  BeamRunContext,
  BeamRunEvent,
  BeamToolDefinition,
  ClaudeCallInput,
  ClaudeResponse,
} from "./types.ts";

const ctx: BeamRunContext = { runId: "run_1", sessionId: "s_1", tenantId: "t_1", userId: "u_1" };

function wardrobeTool(calls: { input: unknown }[]): BeamToolDefinition {
  return {
    name: "beam_get_wardrobe",
    description: "List the user's wardrobe",
    inputSchema: { type: "object", properties: {} },
    handler: async (input) => {
      calls.push({ input });
      return { items: [{ id: "f1", name: "Aventus" }] };
    },
  };
}

/** Build a fake callModel that returns the queued responses in order. */
function scriptedModel(responses: ClaudeResponse[]) {
  const seen: ClaudeCallInput[] = [];
  let i = 0;
  const callModel = async (input: ClaudeCallInput): Promise<ClaudeResponse> => {
    seen.push(input);
    const next = responses[i++];
    if (!next) throw new Error(`callModel called more times than scripted (${i})`);
    // Drain streamed text so the synthesis turn exercises onDelta too.
    if (input.onDelta) {
      for (const block of next.content) {
        if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
          input.onDelta((block as { text: string }).text);
        }
      }
    }
    return next;
  };
  return { callModel, seen };
}

const text = (t: string): ClaudeResponse => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });

test("zero-tool opening turn is nudged, then the tool path runs and synthesis writes the final answer", async () => {
  const toolCalls: { input: unknown }[] = [];
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const { callModel, seen } = scriptedModel([
    // 1) opening turn, no tool use -> triggers the retrieval nudge
    text("I think you'd like something woody."),
    // 2) after nudge -> calls a tool
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }],
      usage: { inputTokens: 100, outputTokens: 20 },
    },
    // 3) orchestration turn after tool result -> no more tools, hand to synthesis
    text("draft"),
    // 4) synthesis turn (tool-free, strong model) -> final prose
    { ...text("Wear Aventus today."), usage: { inputTokens: 200, outputTokens: 40 } },
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "what should I wear?",
    tools: [wardrobeTool(toolCalls)],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    model: "cheap-model",
    synthesisModel: "strong-model",
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  // Final answer comes from the synthesis turn, not the clipped "draft".
  assert.equal(completed, "Wear Aventus today.");
  const completedEvent = events.find((e) => e.type === "completed");
  assert.deepEqual(completedEvent, { type: "completed", response: "Wear Aventus today." });

  // The tool actually ran once.
  assert.equal(toolCalls.length, 1);

  // The synthesis call (the 4th) was tool-free and used the strong model.
  const synthesisCall = seen[3];
  assert.equal(synthesisCall.model, "strong-model");
  assert.equal(synthesisCall.tools.length, 0);

  // Orchestration calls used the cheap model.
  assert.equal(seen[0].model, "cheap-model");

  // The summary reflects the run for observability + cost accounting.
  assert.ok(summary);
  assert.equal(summary.outcome, "completed");
  assert.deepEqual(summary.tools, ["beam_get_wardrobe"]);
  assert.equal(summary.usedSynthesis, true);
  assert.equal(summary.synthesisFailed, false);
  assert.equal(summary.modelCalls, 4); // opening + tool turn + draft turn + synthesis
  assert.equal(summary.inputTokens, 300); // only the tool turn (100) + synthesis (200) carried usage

  assert.equal(summary.outputTokens, 60);
});

test("a turn that narrates a next step instead of calling tools is pushed to act, not finished", async () => {
  const toolCalls: { input: unknown }[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const { callModel, seen } = scriptedModel([
    // 1) calls a tool (so usedTools is set and the retrieval nudge is spent)
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }],
    },
    // 2) narrates the next step WITHOUT calling tools -> must trigger the act nudge,
    //    NOT be accepted as the final answer.
    text("Now let me search the catalog and score your vault for two new bottles."),
    // 3) after the act nudge -> gives the real answer
    text("Aventus is your pick."),
    // 4) synthesis turn
    text("Final: wear Aventus tonight."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "build me a kit",
    tools: [wardrobeTool(toolCalls)],
    emit: () => {},
    isModelConfigured: () => true,
    callModel,
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  // The dangling "now let me…" turn did NOT become the answer; the run continued.
  assert.equal(completed, "Final: wear Aventus tonight.");
  // opening tool turn + narration turn + answer turn + synthesis = 4 model calls.
  assert.equal(summary?.modelCalls, 4);
  // The loop sent the ACT nudge back to the model after the narration turn.
  const sentActNudge = seen.some((call) =>
    call.messages.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        /emit the actual tool calls/i.test(m.content),
    ),
  );
  assert.ok(sentActNudge, "expected the act nudge to be sent after the narration turn");
});

test("malformed tool arguments produce an explicit tool error, not a silent empty run", async () => {
  const toolCalls: { input: unknown }[] = [];
  let summary: BeamRunSummary | undefined;
  const toolResultContents: string[] = [];

  const { callModel } = scriptedModel([
    // 1) model emits a tool call whose args failed to parse (provider sentinel)
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_bad", name: "beam_get_wardrobe", input: invalidArgsMarker("{not json") }],
    },
    // 2) next orchestration turn just answers
    text("ok, retried"),
  ]);

  // Wrap callModel to capture what the loop sent back as the tool result.
  const capturing = async (input: ClaudeCallInput): Promise<ClaudeResponse> => {
    for (const m of input.messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "tool_result") toolResultContents.push(String((b as { content: string }).content));
        }
      }
    }
    return callModel(input);
  };

  await runBeamAgent({
    ctx,
    userMessage: "show my vault",
    tools: [wardrobeTool(toolCalls)],
    emit: () => {},
    isModelConfigured: () => true,
    callModel: capturing,
    onSummary: (s) => (summary = s),
  });

  // The handler was NEVER invoked on coerced-empty args...
  assert.equal(toolCalls.length, 0);
  // ...and the model was told its arguments were invalid so it can retry.
  assert.ok(toolResultContents.some((c) => /not valid JSON/i.test(c)));
  assert.equal(summary?.outcome, "completed");
});

test("the synthesis turn is pinned to an allowlist of the fragrances tools actually returned", async () => {
  const toolCalls: { input: unknown }[] = [];
  let summary: BeamRunSummary | undefined;

  const { callModel, seen } = scriptedModel([
    // 1) call the wardrobe tool -> grounds "Aventus"
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }],
    },
    // 2) orchestration done
    text("draft"),
    // 3) synthesis
    text("Wear Aventus."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "what should I wear?",
    tools: [wardrobeTool(toolCalls)],
    emit: () => {},
    isModelConfigured: () => true,
    callModel,
    onSummary: (s) => (summary = s),
  });

  // The synthesis call (last) carries the grounding allowlist naming the
  // retrieved fragrance, so the model can't reach for one from memory.
  const synthesisCall = seen[seen.length - 1];
  const folded = synthesisCall.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("\n");
  assert.match(folded, /You may name ONLY these fragrances/i);
  assert.match(folded, /"Aventus"/);
  assert.equal(summary?.groundedNames, 1);
});

test("an unserializable tool result yields exactly one error result, not a duplicate tool_use_id", async () => {
  let summary: BeamRunSummary | undefined;
  // For each model call, record how many tool_result blocks carry the circular
  // tool's id. A real double-push would put two with the SAME id in one
  // transcript (which the API rejects); we assert no single call ever sees more
  // than one, and that the one present is an error.
  let maxPerCall = 0;
  let sawError = false;

  // A tool whose result is circular -> JSON.stringify throws AFTER the handler
  // succeeds. The loop must record one is_error result and continue, never a
  // second result for the same id.
  const circularTool: BeamToolDefinition = {
    name: "beam_get_wardrobe",
    description: "List the user's wardrobe",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const obj: Record<string, unknown> = { id: "f1" };
      obj.self = obj; // circular
      return obj;
    },
  };

  const { callModel } = scriptedModel([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_circ", name: "beam_get_wardrobe", input: {} }],
    },
    text("ok, moving on"),
    text("Final answer."),
  ]);

  const capturing = async (input: ClaudeCallInput): Promise<ClaudeResponse> => {
    let perCall = 0;
    for (const m of input.messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "tool_result") {
            const block = b as { tool_use_id: string; is_error?: boolean };
            if (block.tool_use_id === "tu_circ") {
              perCall++;
              if (block.is_error === true) sawError = true;
            }
          }
        }
      }
    }
    maxPerCall = Math.max(maxPerCall, perCall);
    return callModel(input);
  };

  await runBeamAgent({
    ctx,
    userMessage: "show my vault",
    tools: [circularTool],
    emit: () => {},
    isModelConfigured: () => true,
    callModel: capturing,
    onSummary: (s) => (summary = s),
  });

  assert.equal(maxPerCall, 1, "no single transcript should carry a duplicate tool_use_id");
  assert.ok(sawError, "the unserializable result should be reported as a tool error");
  assert.equal(summary?.outcome, "completed");
});

test("a synthesis answer with an unsupported price is repaired once and the clean answer ships", async () => {
  const toolCalls: { input: unknown }[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const { callModel, seen } = scriptedModel([
    // 1) call a tool (grounds the run; no external fact -> price claims are unsupported)
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }],
      usage: { inputTokens: 100, outputTokens: 20 },
    },
    // 2) orchestration done -> hand to synthesis
    text("draft"),
    // 3) synthesis invents a price with no external evidence -> gate fails
    { ...text("Aventus is $300 at most retailers."), usage: { inputTokens: 200, outputTokens: 30 } },
    // 4) the single constrained repair pass writes a clean answer
    { ...text("Wear Aventus tonight — a confident, smoky-fruity pick."), usage: { inputTokens: 80, outputTokens: 20 } },
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "what should I wear?",
    tools: [wardrobeTool(toolCalls)],
    emit: () => {},
    isModelConfigured: () => true,
    callModel,
    model: "cheap-model",
    synthesisModel: "strong-model",
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  // The clean repaired answer shipped, not the one with the invented price.
  assert.equal(completed, "Wear Aventus tonight — a confident, smoky-fruity pick.");
  // tool turn + draft turn + synthesis + ONE repair.
  assert.equal(summary?.modelCalls, 4);
  // The repair call (last) was tool-free, used the synthesis model, and fed the
  // broken price rule back to the model.
  const repairCall = seen[seen.length - 1];
  assert.equal(repairCall.model, "strong-model");
  assert.equal(repairCall.tools.length, 0);
  const folded = repairCall.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("\n");
  assert.match(folded, /Do NOT state any price/i);

  // Telemetry reflects a passing gate and a non-zero estimated cost.
  assert.equal(summary?.qualityGatePassed, true);
  assert.deepEqual(summary?.qualityViolations, []);
  assert.ok((summary?.estimatedCostUsd ?? 0) > 0, "expected a non-zero cost estimate");
});

test("an unconfigured model fails gracefully with a summary", async () => {
  const events: BeamRunEvent[] = [];
  let summary: BeamRunSummary | undefined;

  await runBeamAgent({
    ctx,
    userMessage: "hi",
    tools: [],
    emit: (e) => events.push(e),
    isModelConfigured: () => false,
    callModel: async () => {
      throw new Error("should not be called");
    },
    onSummary: (s) => (summary = s),
  });

  const failed = events.find((e) => e.type === "failed");
  assert.equal(failed?.type, "failed");
  assert.equal((failed as { code: string }).code, "model_unavailable");
  assert.equal(summary?.outcome, "failed");
  assert.equal(summary?.failureCode, "model_unavailable");
});
