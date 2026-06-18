/**
 * Loop tests for the Beam Agent. The provider is injected (input.callModel) so
 * the loop runs deterministically with no network.
 *
 *   node --experimental-strip-types --test src/beam-agent/beamAgentLoop.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clientEventFitsMission,
  missionToolResultError,
  runBeamAgent,
  toolFitsMission,
  toolInputForMission,
  type BeamRunSummary,
} from "./beamAgentLoop.ts";
import { invalidArgsMarker } from "./beamToolCore.ts";
import { deriveBeamSessionState, inferPendingSlotFromAssistant } from "./missionState.ts";
import type {
  BeamRunContext,
  BeamRunEvent,
  BeamSessionState,
  BeamToolDefinition,
  ClaudeCallInput,
  ClaudeResponse,
} from "./types.ts";

const ctx: BeamRunContext = { runId: "run_1", sessionId: "s_1", tenantId: "t_1", userId: "u_1" };

test("new-only mission suppresses owned profile cards and incomplete travel cards", () => {
  const state: BeamSessionState = {
    slots: { destination: "Tokyo", month: "August", direction: "lighter/fresh" },
    mission: { intent: "travel_kit", newCount: 2, destination: "Tokyo", month: "August" },
  };
  const ownedProfile: BeamRunEvent = {
    type: "card",
    card: { kind: "scent_profile", fragrance: { name: "Silver Mountain Water", brand: "Creed", accords: ["fresh"], owned: true } },
  };
  assert.equal(clientEventFitsMission(ownedProfile, state), false);

  const onePick: BeamRunEvent = {
    type: "card",
    card: { kind: "travel_kit", ownedPicks: [], newPicks: [{ name: "Wulong Cha", brand: "Nishane", notes: [], accords: ["fresh"] }] },
  };
  assert.equal(clientEventFitsMission(onePick, state), false);
  onePick.card.kind === "travel_kit" && onePick.card.newPicks.push({ name: "Tygar", brand: "Bvlgari", notes: [], accords: ["citrus"] });
  assert.equal(clientEventFitsMission(onePick, state), true);
  assert.equal(toolFitsMission("beam_score_candidates", state), false);
  assert.equal(toolFitsMission("beam_search_catalog", state), true);
  assert.equal(toolFitsMission("beam_propose_collection", state), false);
  assert.deepEqual(toolInputForMission("beam_search_catalog", { query: "citrus", excludeOwned: false }, state), {
    query: "citrus",
    excludeOwned: true,
  });
  assert.match(
    missionToolResultError("beam_present_travel_kit", { ownedCount: 0, newCount: 1 }, state) ?? "",
    /required 0 owned and 2 new/i,
  );
  assert.equal(
    missionToolResultError("beam_present_travel_kit", { ownedCount: 0, newCount: 2 }, state),
    null,
  );
});

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

test("a response that still fails quality gates is never completed", async () => {
  const events: BeamRunEvent[] = [];
  const toolCalls: { input: unknown }[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;
  const { callModel } = scriptedModel([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }] },
    text("draft"),
    text("Aventus is $300 everywhere."),
    text("Aventus costs $250 everywhere."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "Recommend something",
    tools: [wardrobeTool(toolCalls)],
    emit: (event) => events.push(event),
    isModelConfigured: () => true,
    callModel,
    onComplete: (response) => (completed = response),
    onSummary: (value) => (summary = value),
  });

  assert.equal(completed, undefined);
  assert.equal(events.some((event) => event.type === "completed"), false);
  assert.ok(events.some((event) => event.type === "failed" && event.code === "quality_gate_failed"));
  assert.equal(summary?.qualityGatePassed, false);
  assert.ok(summary?.qualityViolations.includes("price_without_evidence"));
});

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

test("per-run token budgets are forwarded to orchestration and synthesis calls", async () => {
  const toolCalls: { input: unknown }[] = [];

  const { callModel, seen } = scriptedModel([
    // 1) tool turn
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }],
    },
    // 2) orchestration draft (no more tools)
    text("draft"),
    // 3) synthesis turn
    text("Wear Aventus today."),
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
    orchestrationMaxTokens: 512,
    synthesisMaxTokens: 1024,
  });

  // Orchestration (tool-bearing) calls carry the orchestration ceiling; the
  // tool-free synthesis call carries the larger synthesis ceiling.
  const orchestrationCalls = seen.filter((c) => c.tools.length > 0);
  const synthesisCalls = seen.filter((c) => c.tools.length === 0);
  assert.ok(orchestrationCalls.length > 0);
  assert.ok(synthesisCalls.length > 0);
  for (const c of orchestrationCalls) assert.equal(c.maxTokens, 512);
  for (const c of synthesisCalls) assert.equal(c.maxTokens, 1024);
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

test("the synthesis turn is held to the scorer's top pick and warned off invented locations (W-8)", async () => {
  let summary: BeamRunSummary | undefined;

  // A scoring tool that ranks Gabrielle first, Aventus second, scored against
  // local weather (no locationLabel) — the exact shape beam_score_candidates returns.
  const scoreTool: BeamToolDefinition = {
    name: "beam_score_candidates",
    description: "Rank the vault",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      recommendation: { canonicalName: "Gabrielle", brand: "Chanel", score: 91 },
      picks: [
        { canonicalName: "Gabrielle", brand: "Chanel", score: 91 },
        { canonicalName: "Aventus", brand: "Creed", score: 80 },
      ],
      scoredFor: { locationLabel: null, usedOverride: false },
    }),
  };

  const { callModel, seen } = scriptedModel([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "beam_score_candidates", input: {} }],
    },
    text("draft"),
    text("Reach for Gabrielle tonight."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "what should I wear for a night out?",
    tools: [scoreTool],
    emit: () => {},
    isModelConfigured: () => true,
    callModel,
    onSummary: (s) => (summary = s),
  });

  const synthesisCall = seen[seen.length - 1];
  const folded = synthesisCall.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("\n");
  // The scorer's ranking and top-pick rule are pinned into the closing instruction…
  assert.match(folded, /scorer ranked the user's OWNED vault best-first as: "Gabrielle" then "Aventus"/i);
  assert.match(folded, /lead with the scorer's top pick \("Gabrielle"\)/i);
  // …and, since no destination was scored, it is warned off inventing a location.
  assert.match(folded, /do NOT name any city, country, or climate they did not give/i);
  assert.equal(summary?.outcome, "completed");
});

test("a circular tool result is bounded to exactly one serializable result, not a duplicate tool_use_id", async () => {
  let summary: BeamRunSummary | undefined;
  // For each model call, record how many tool_result blocks carry the circular
  // tool's id. A real double-push would put two with the SAME id in one
  // transcript (which the API rejects); we assert no single call ever sees more
  // than one. The transcript trimmer (`boundToolResultForTranscript`) is
  // depth-capped, so a self-referential result is now safely bounded into a
  // serializable shape instead of throwing — the model gets a usable (if
  // truncated) result and the run still carries exactly one tool_result for the id.
  let maxPerCall = 0;
  let sawError = false;

  // A tool whose result is circular. Pre-trim this made JSON.stringify throw; the
  // record-aware trimmer now collapses the cycle at the depth ceiling, so the loop
  // records one ordinary result and continues — never a second result for the id.
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
  assert.equal(sawError, false, "a depth-bounded circular result is usable, not an error");
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

test("session state is injected and redundant known-slot clarification is repaired", async () => {
  const toolCalls: { input: unknown }[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const { callModel, seen } = scriptedModel([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }],
    },
    text("draft"),
    text("What month are you going to Tokyo?"),
    text("Wear Aventus for Tokyo in August."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "August and artsy",
    sessionState: { slots: { month: "August", destination: "Tokyo", vibe: "artsy" } },
    tools: [wardrobeTool(toolCalls)],
    emit: () => {},
    isModelConfigured: () => true,
    callModel,
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(completed, "Wear Aventus for Tokyo in August.");
  assert.equal(summary?.qualityGatePassed, true);
  assert.match(seen[0].system, /Known so far: .*month=August/i);

  const repairCall = seen[seen.length - 1];
  const folded = repairCall.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("\n");
  assert.match(folded, /Do NOT ask for month/i);
});

test("pre-tool cue clarification that re-asks known state is nudged instead of completed", async () => {
  const toolCalls: { input: unknown }[] = [];
  let completed: string | undefined;
  const { callModel, seen } = scriptedModel([
    text("What month are you going?\n```cues\nAugust\nSeptember\n```"),
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }],
    },
    text("draft"),
    text("Wear Aventus for Tokyo in August."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "August and artsy",
    sessionState: { slots: { month: "August", destination: "Tokyo", vibe: "artsy" } },
    tools: [wardrobeTool(toolCalls)],
    emit: () => {},
    isModelConfigured: () => true,
    callModel,
    onComplete: (t) => (completed = t),
  });

  assert.equal(completed, "Wear Aventus for Tokyo in August.");
  assert.equal(toolCalls.length, 1);
  const sentStateNudge = seen.some((call) =>
    call.messages.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        /structured session state/i.test(m.content),
    ),
  );
  assert.ok(sentStateNudge, "expected a state nudge instead of completing the cue question");
});

test("regression script: Tokyo 2+2 kit persists slots, never re-asks month, honors delegation, ships a 4-item kit", async () => {
  // Drives the §7 regression script end-to-end against runBeamAgent, threading
  // structured state across turns exactly the way beamAgentRoutes does: derive
  // from each user message (with the pending slot inferred from the prior
  // assistant turn), then feed the merged state into the loop. The injected model
  // is the only seam — no network.
  const ownedTool: BeamToolDefinition = {
    name: "beam_score_candidates",
    description: "Rank the vault",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      recommendation: { canonicalName: "Aventus", brand: "Creed", score: 90 },
      picks: [
        { canonicalName: "Aventus", brand: "Creed", score: 90 },
        { canonicalName: "Gabrielle", brand: "Chanel", score: 84 },
      ],
      scoredFor: { locationLabel: "Tokyo, August", usedOverride: true },
    }),
  };
  const newTool: BeamToolDefinition = {
    name: "beam_search_catalog",
    description: "Find new (unowned) catalog fragrances",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      items: [
        { canonicalName: "Tam Dao", brand: "Diptyque", owned: false },
        { canonicalName: "Philosykos", brand: "Diptyque", owned: false },
      ],
    }),
  };
  const tools = [ownedTool, newTool];

  // Helper: run one turn the way the route does, returning the completed text and
  // the system prompt the orchestration turn actually saw.
  async function runTurn(
    prevState: BeamSessionState | undefined,
    userMessage: string,
    lastAssistantText: string | undefined,
    responses: ClaudeResponse[],
  ): Promise<{ state: BeamSessionState; completed: string | undefined; firstSystem: string; events: BeamRunEvent[] }> {
    const pending = lastAssistantText ? inferPendingSlotFromAssistant(lastAssistantText) : undefined;
    const state = deriveBeamSessionState(prevState, userMessage, pending);
    const { callModel, seen } = scriptedModel(responses);
    const events: BeamRunEvent[] = [];
    let completed: string | undefined;
    await runBeamAgent({
      ctx,
      userMessage,
      sessionState: state,
      tools,
      emit: (e) => events.push(e),
      isModelConfigured: () => true,
      callModel,
      onComplete: (t) => (completed = t),
    });
    return { state, completed, firstSystem: seen[0]?.system ?? "", events };
  }

  // Turn 1: the kit request. One clarifying question (asks month + vibe).
  const t1 = await runTurn(
    undefined,
    "I'm planning a trip to Tokyo and I need two fragrances to take with me and two new ones not in my collection yet",
    undefined,
    [text("What month is the trip, and what vibe are you after?\n```cues\nAugust\nArtsy\n```")],
  );
  assert.equal(t1.state.mission?.intent, "travel_kit");
  assert.equal(t1.state.mission?.ownedCount, 2);
  assert.equal(t1.state.mission?.newCount, 2);
  assert.equal(t1.state.slots.destination, "Tokyo");
  // The clarifying question shipped (it asks for unknown month/vibe — allowed).
  assert.match(String(t1.completed), /month/i);

  // Turn 2: "August and artsy" — month + vibe must persist; no month re-ask.
  const t2 = await runTurn(
    t1.state,
    "August and artsy",
    "What month is the trip, and what vibe are you after?",
    [text("Great — Tokyo in August, artsy. Want me to build the kit now?\n```cues\nYes build it\nTweak the vibe\n```")],
  );
  assert.equal(t2.state.slots.month, "August");
  assert.equal(t2.state.slots.vibe, "artsy");
  assert.equal(t2.state.mission?.month, "August");
  // The injected state carries month into the system prompt, so the model is told
  // never to re-ask it.
  assert.match(t2.firstSystem, /Known so far: .*month=August/i);

  // Turn 3: "Idk you tell me" — delegation honored, and the agent produces a
  // 4-item kit (2 owned + 2 new). The model first tries to re-ask the vibe (a
  // known/delegated slot); the loop's pre-tool cue gate rejects that and nudges
  // it to act, then it scores the vault + searches new and synthesizes the kit.
  const t3 = await runTurn(
    t2.state,
    "Idk you tell me",
    "Great — Tokyo in August, artsy. Want me to build the kit now?",
    [
      // 1) the model tries to ask another preference question -> delegation gate trips -> STATE_NUDGE
      text("Sure — do you prefer something fresher or warmer?\n```cues\nFresher\nWarmer\n```"),
      // 2) after the nudge it scores the vault (owned lane)
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_score", name: "beam_score_candidates", input: {} }],
      },
      // 3) then searches the catalog (new lane)
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_search", name: "beam_search_catalog", input: {} }],
      },
      // 4) orchestration draft
      text("draft kit"),
      // 5) a synthesis attempt that under-fills the kit (only 1 owned, 1 new) -> mission_unfulfilled
      text("Pack Aventus from your vault and add Tam Dao."),
      // 6) the single repair pass names the full 2+2 kit
      text(
        "From your vault, pack Aventus and Gabrielle. For new picks, line up Tam Dao and Philosykos — both fit an artsy Tokyo August.",
      ),
    ],
  );
  assert.equal(t3.state.userDelegatedChoice, true);
  assert.equal(t3.state.mission?.userDelegatedChoice, true);

  // HARD FAIL guards from §7:
  const finalText = String(t3.completed);
  // - never a month re-ask
  assert.doesNotMatch(finalText, /what month|travel dates|can'?t guess/i);
  // - a full 4-item kit (2 owned + 2 new), not a single daily-scent reply
  for (const name of ["Aventus", "Gabrielle", "Tam Dao", "Philosykos"]) {
    assert.match(finalText, new RegExp(name, "i"), `expected the kit to name ${name}`);
  }

  // The delegation backstop fired: the loop nudged the re-ask turn instead of
  // shipping it as the answer.
  const completedEvent = t3.events.find((e) => e.type === "completed");
  assert.ok(completedEvent, "expected a completed event");
  assert.doesNotMatch(finalText, /fresher or warmer/i);
});

test("regression script: a failed/timeout turn still keeps the derived mission state for the next turn", async () => {
  // B5: the route persists deriveBeamSessionState BEFORE running the loop, so a
  // failed turn does not lose the user's just-stated mission. We prove the state
  // derivation is stable across a turn whose model call fails — the merged state
  // the route would have saved still carries the full mission into turn 2.
  const t1State = deriveBeamSessionState(
    undefined,
    "Trip to Tokyo, two to pack and two new ones, August, artsy",
  );
  assert.equal(t1State.mission?.intent, "travel_kit");
  assert.equal(t1State.slots.month, "August");

  // The loop fails this turn (model unconfigured) — onComplete never fires, so a
  // store keyed on onComplete would lose everything. The route avoids that by
  // saving t1State up front; here we assert that the SAME state, fed as prior
  // state to the next turn, still carries the mission forward intact.
  let completed: string | undefined;
  await runBeamAgent({
    ctx,
    userMessage: "Trip to Tokyo, two to pack and two new ones, August, artsy",
    sessionState: t1State,
    tools: [],
    emit: () => {},
    isModelConfigured: () => false, // forces a model_unavailable failure
    callModel: async () => {
      throw new Error("should not be called");
    },
    onComplete: (t) => (completed = t),
  });
  assert.equal(completed, undefined, "a failed turn never calls onComplete");

  // Next turn builds on the up-front-saved state (route's persist-before-run).
  const t2State = deriveBeamSessionState(t1State, "Idk you tell me");
  assert.equal(t2State.slots.month, "August");
  assert.equal(t2State.slots.vibe, "artsy");
  assert.equal(t2State.mission?.ownedCount, 2);
  assert.equal(t2State.mission?.newCount, 2);
  assert.equal(t2State.userDelegatedChoice, true);
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
