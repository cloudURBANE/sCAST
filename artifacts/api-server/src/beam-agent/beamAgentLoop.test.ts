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
