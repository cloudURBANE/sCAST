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
  boundedToolTimeoutMs,
  missionToolResultError,
  runBeamAgent,
  toolFitsMission,
  toolInputForMission,
  type BeamRunSummary,
} from "./beamAgentLoop.ts";
import { invalidArgsMarker } from "./beamToolCore.ts";
import { deriveBeamSessionState, inferPendingSlotFromAssistant } from "./missionState.ts";
import type {
  BeamCard,
  BeamRunContext,
  BeamRunEvent,
  BeamSessionState,
  BeamToolDefinition,
  ClaudeCallInput,
  ClaudeResponse,
} from "./types.ts";

const ctx: BeamRunContext = { runId: "run_1", sessionId: "s_1", tenantId: "t_1", userId: "u_1" };

test("tool waits are capped by the remaining run budget", () => {
  assert.equal(boundedToolTimeoutMs(30_000), 20_000);
  assert.equal(boundedToolTimeoutMs(7_500), 7_500);
  assert.equal(boundedToolTimeoutMs(-10), 1);
});

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

test("a mid-loop provider timeout with grounded evidence degrades gracefully, not agent_error", async () => {
  // A search-heavy runaway emits only tool calls (no inline prose), so the loop's
  // `lastText` stays empty. A provider TimeoutError on the next turn used to
  // re-throw into a generic `agent_error` dead-end even though the run held grounded
  // fragrances. It must instead close gracefully (honest fallback / grounded draft).
  const events: BeamRunEvent[] = [];
  const toolCalls: { input: unknown }[] = [];
  let summary: BeamRunSummary | undefined;
  let calls = 0;
  const callModel = async (): Promise<ClaudeResponse> => {
    calls++;
    if (calls === 1) {
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }] };
    }
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };

  await runBeamAgent({
    ctx,
    userMessage: "find me something impossible",
    tools: [wardrobeTool(toolCalls)],
    emit: (event) => events.push(event),
    isModelConfigured: () => true,
    callModel,
    onSummary: (value) => (summary = value),
  });

  assert.equal(events.some((e) => e.type === "failed" && e.code === "agent_error"), false);
  const completed = events.find((e) => e.type === "completed");
  assert.ok(completed && completed.type === "completed" && completed.response.trim().length > 0);
  assert.equal(summary?.outcome, "completed");
});

test("completion waits for transcript persistence before publishing the terminal event", async () => {
  const events: BeamRunEvent[] = [];
  let release!: () => void;
  const persisted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = runBeamAgent({
    ctx,
    userMessage: "hello",
    tools: [],
    emit: (event) => events.push(event),
    isModelConfigured: () => true,
    callModel: async () => text("Hello back."),
    onComplete: async () => persisted,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.some((event) => event.type === "completed"), false);
  release();
  await run;
  assert.equal(events.some((event) => event.type === "completed"), true);
});

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
  // The completed event now also carries the durable answer id (= the run id) so
  // the client can tag the answer for feedback.
  assert.deepEqual(completedEvent, { type: "completed", response: "Wear Aventus today.", answerLogId: "run_1" });

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

test("exhausting the tool-call budget still composes a grounded answer instead of failing", async () => {
  const events: BeamRunEvent[] = [];
  const toolCalls: { input: unknown }[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  // A catalog tool that always returns a grounded fragrance.
  const catalogTool: BeamToolDefinition = {
    name: "beam_search_catalog",
    description: "Search the catalog",
    inputSchema: { type: "object", properties: {} },
    handler: async (input) => {
      toolCalls.push({ input });
      return { items: [{ name: "Aventus", brand: "Creed" }] };
    },
  };

  // The model never stops calling tools, so the loop runs out of turns (maxTurns:
  // 2) without ever entering the voluntary-answer branch. The 3rd scripted reply
  // is the forced closing synthesis the exhaustion fix triggers from the grounded
  // evidence — previously this run failed with max_turns and showed nothing.
  const { callModel } = scriptedModel([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "beam_search_catalog", input: { query: "fresh" } }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_2", name: "beam_search_catalog", input: { query: "woody" } }] },
    text("Aventus by Creed is a great pick."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "Recommend a couple new fragrances, you pick.",
    tools: [catalogTool],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    maxTurns: 2,
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(completed, "Aventus by Creed is a great pick.");
  assert.ok(events.some((e) => e.type === "completed"));
  assert.equal(events.some((e) => e.type === "failed"), false);
  assert.ok(summary);
  assert.equal(summary.outcome, "completed");
  assert.equal(summary.failureCode, undefined);
  assert.equal(summary.usedSynthesis, true);
  assert.equal(summary.turns, 2);
  assert.ok((summary.groundedNames ?? 0) >= 1);
  assert.equal(toolCalls.length, 2);
});

test("a grounded turn that only trips a soft conversation-flow gate is delivered, not hard-failed", async () => {
  // Reproduces the dominant live failure: the run gathers grounded evidence but the
  // closing draft trips ONLY pending_slot_abandoned (a flow gate). Previously this
  // hard-failed with quality_gate_failed after burning the budget; it must now ship
  // the grounded answer instead of showing the user a terminal error.
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const { callModel } = scriptedModel([
    // turn 1: retrieve evidence (grounds Aventus)
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} }] },
    // turn 2: orchestration hands off to synthesis
    text("draft"),
    // synthesis: a non-question that names no grounded pick -> abandons the pending slot
    text("Noted — I'll take it from here."),
    // repair: still soft-failing (no fewer violations), so the original draft stays
    text("Got it, leaving it with me."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "something for the office",
    tools: [wardrobeTool([])],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    // The agent asked for 'direction' last turn; this message did not answer it.
    sessionState: { slots: { occasion: "work" }, pendingSlot: "direction", pendingSlotUnanswered: true },
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(events.some((e) => e.type === "failed"), false);
  assert.ok(events.some((e) => e.type === "completed"));
  assert.equal(completed, "Noted — I'll take it from here.");
  assert.equal(summary?.outcome, "completed");
  // Telemetry keeps the overridden soft violation for visibility.
  assert.ok(summary?.qualityViolations.includes("pending_slot_abandoned"), JSON.stringify(summary?.qualityViolations));
});

test("a new-only travel-kit synthesis is pinned to unowned picks (owned vault bottles excluded)", async () => {
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;
  const synthCalls: ClaudeCallInput[] = [];

  // wardrobe grounds an OWNED bottle; catalog grounds two UNOWNED candidates.
  const wardrobe: BeamToolDefinition = {
    name: "beam_get_wardrobe",
    description: "wardrobe",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ items: [{ name: "Aventus", brand: "Creed" }] }),
  };
  const catalog: BeamToolDefinition = {
    name: "beam_search_catalog",
    description: "catalog",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      items: [
        { name: "Wulong Cha", brand: "Nishane", owned: false },
        { name: "Tygar", brand: "Bvlgari", owned: false },
      ],
    }),
  };

  // The model keeps searching until maxTurns is exhausted, then the forced
  // synthesis composes the kit. The 3rd reply names exactly the two unowned picks.
  const responses: ClaudeResponse[] = [
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "w", name: "beam_get_wardrobe", input: {} },
        { type: "tool_use", id: "c1", name: "beam_search_catalog", input: { query: "tea" } },
      ],
    },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "c2", name: "beam_search_catalog", input: { query: "citrus" } }] },
    text("For Tokyo in August: Wulong Cha by Nishane and Tygar by Bvlgari — two fresh new picks."),
  ];
  let i = 0;
  const callModel = async (input: ClaudeCallInput): Promise<ClaudeResponse> => {
    if (input.tools.length === 0) synthCalls.push(input);
    const next = responses[i++];
    if (!next) throw new Error(`callModel over-called (${i})`);
    return next;
  };

  await runBeamAgent({
    ctx,
    userMessage: "pick two new for tokyo, you choose",
    tools: [wardrobe, catalog],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    maxTurns: 2,
    sessionState: {
      slots: { destination: "Tokyo", month: "August", direction: "fresh" },
      mission: { intent: "travel_kit", newCount: 2, destination: "Tokyo", month: "August" },
    },
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  // The forced synthesis fulfilled the new-only kit and passed the gate.
  assert.equal(summary?.outcome, "completed");
  assert.equal(summary?.usedSynthesis, true);
  assert.deepEqual(summary?.qualityViolations, []);
  assert.match(completed ?? "", /Wulong Cha/);

  // The synthesis allowlist clause listed the unowned picks and EXCLUDED the owned
  // vault bottle — the heart of the fix (the bottle still appears in the tool
  // transcript, so assert specifically against the "name ONLY these" clause).
  assert.ok(synthCalls.length >= 1);
  const blob = JSON.stringify(synthCalls[0].messages);
  const clause = blob.match(/You may name ONLY these fragrances[^.]*\./);
  assert.ok(clause, "allowlist clause present in synthesis instruction");
  assert.match(clause![0], /Wulong Cha/);
  assert.ok(!clause![0].includes("Aventus"), "owned vault bottle must be excluded from the allowlist");
});

test("the budget is still failed when nothing was grounded to compose from", async () => {
  let summary: BeamRunSummary | undefined;
  const events: BeamRunEvent[] = [];
  // A tool that grounds nothing (empty result), so exhaustion has no evidence to
  // synthesize from and must still fail honestly rather than inventing an answer.
  const emptyTool: BeamToolDefinition = {
    name: "beam_search_catalog",
    description: "Search the catalog",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ items: [] }),
  };
  const { callModel } = scriptedModel([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "beam_search_catalog", input: {} }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_2", name: "beam_search_catalog", input: {} }] },
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "find me something",
    tools: [emptyTool],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    maxTurns: 2,
    onSummary: (s) => (summary = s),
  });

  assert.ok(events.some((e) => e.type === "failed" && e.code === "max_turns"));
  assert.equal(summary?.outcome, "failed");
  assert.equal(summary?.failureCode, "max_turns");
  assert.equal(summary?.usedSynthesis, false);
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

test("a tool-free clarifying turn that fails the gate is repaired into a clean re-ask, not hard-failed", async () => {
  // The exact dead-end the prior pass shipped: a clarifying (tool-free) turn whose
  // question trips a gate twice used to skip the usedTools-gated repair and hard
  // fail with quality_gate_failed. It must now recover via a clarify-repair pass.
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const { callModel, seen } = scriptedModel([
    // turn 0: abandons the pending vibe question (asks budget) -> cue gate fails -> STATE_NUDGE
    text("What's your budget?\n```cues\nUnder $100\nUnder $200\n```"),
    // turn 1: still abandons -> falls through to finish() tool-free (the old dead-end)
    text("So really, what's your budget?\n```cues\nUnder $150\nNo limit\n```"),
    // turn 2: the clarify-repair pass re-asks the vibe slot cleanly -> passes the gate
    text("Got it. What vibe are you after for Tokyo?\n```cues\nArtsy and quiet\nBold and modern\n```"),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "hmm",
    sessionState: { slots: { destination: "Tokyo" }, pendingSlot: "vibe", pendingSlotUnanswered: true },
    tools: [wardrobeTool([])],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(events.some((e) => e.type === "failed"), false, "a clarifying turn must not hard-fail");
  assert.ok(events.some((e) => e.type === "completed"), "the repaired clarifying turn ships");
  assert.match(String(completed), /vibe/i);
  assert.equal(summary?.qualityGatePassed, true);
  // The repair pass was tool-free and carried the clarify (not synthesis) instruction.
  const repairCall = seen[seen.length - 1];
  assert.equal(repairCall.tools.length, 0);
  const folded = repairCall.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("\n");
  assert.match(folded, /have NOT retrieved any fragrances/i);
  assert.doesNotMatch(folded, /You may name ONLY these fragrances/i);
});

test("a tool-free clarifying turn recovers via a deterministic safe re-ask when repair also fails", async () => {
  // Repair itself produces another abandoning question, so the deterministic
  // gate-safe fallback (buildSafeClarification) must keep the session alive rather
  // than surfacing quality_gate_failed.
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const { callModel } = scriptedModel([
    text("What's your budget?\n```cues\nUnder $100\nUnder $200\n```"), // turn 0 -> cue gate fails -> STATE_NUDGE
    text("Seriously — your budget?\n```cues\nCheap\nExpensive\n```"), // turn 1 -> finish() tool-free
    text("Still, what's the budget?\n```cues\nLow\nHigh\n```"), // turn 2 repair -> still abandons vibe -> fails
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "hmm",
    sessionState: { slots: { destination: "Tokyo" }, pendingSlot: "vibe", pendingSlotUnanswered: true },
    tools: [wardrobeTool([])],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(events.some((e) => e.type === "failed"), false, "the safe fallback prevents a hard fail");
  assert.ok(events.some((e) => e.type === "completed"));
  // The deterministic fallback re-asks the pending vibe slot and carries tap chips.
  assert.match(String(completed), /vibe/i);
  assert.ok(events.some((e) => e.type === "suggestions"));
  assert.equal(summary?.qualityGatePassed, true);
});

test("a tool-grounded turn that jumps ahead on a not-yet-owed new-only kit recovers via a safe re-ask, not an empty dead-end", async () => {
  // FAILURE #2 from the live delegation stress run. The user asked for a 2-new
  // travel kit but gave NO scent direction, so the turn is NOT yet owed a
  // recommendation (missionReadyForFulfillment is false). The model jumped ahead,
  // pulled tools, and its synthesis (and repair) named an OWNED vault bottle in a
  // new-only mission -> owned_pick_in_new_only_mission, a HARD gate. Because the
  // turn used tools (clarifyingTurn is false) the clarify net never ran, and
  // because it isn't owed a pick the commit fallback returned null -> the run used
  // to dead-end on quality_gate_failed and ship the user nothing. It must instead
  // recover with the deterministic safe re-ask for the one missing slot (direction).
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const catalog: BeamToolDefinition = {
    name: "beam_search_catalog",
    description: "catalog",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ items: [{ name: "Wulong Cha", brand: "Nishane", owned: false }] }),
  };

  const { callModel } = scriptedModel([
    // turn 0: grounds an OWNED bottle (wardrobe) + an unowned candidate (catalog)
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "w", name: "beam_get_wardrobe", input: {} },
        { type: "tool_use", id: "c", name: "beam_search_catalog", input: { query: "fresh" } },
      ],
    },
    // turn 1: orchestration hands off to synthesis
    text("draft"),
    // synthesis: names the OWNED vault bottle in a new-only kit -> owned_pick_in_new_only_mission
    text("For Tokyo in June, pack Aventus by Creed — a clean, confident travel pick."),
    // repair: still names the owned bottle, so it doesn't reduce violations
    text("Honestly, Aventus by Creed is the one to take to Tokyo."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: "I'm going to Tokyo in June and want a small travel kit, 2 new fragrances.",
    tools: [wardrobeTool([]), catalog],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    // A new-only kit with destination + month but NO direction yet: not owed a pick.
    sessionState: {
      slots: { destination: "Tokyo", month: "June" },
      mission: { intent: "travel_kit", newCount: 2, destination: "Tokyo", month: "June" },
    },
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(events.some((e) => e.type === "failed"), false, "the not-yet-owed kit turn must not hard-fail");
  assert.ok(events.some((e) => e.type === "completed"), "it ships a recovered answer");
  // The deterministic recovery re-asks the one genuinely missing slot (direction)…
  assert.match(String(completed), /direction/i);
  // …never the owned bottle that tripped the gate, and never an invented pick.
  assert.doesNotMatch(String(completed), /Aventus/i);
  assert.ok(events.some((e) => e.type === "suggestions"), "the re-ask carries tap chips");
  assert.equal(summary?.qualityGatePassed, true);
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

test("live regression: the final orchestration turn is reserved for the required travel-kit deliverable", async () => {
  const state = deriveBeamSessionState(
    undefined,
    "Plan a Tokyo August kit with exactly two from my wardrobe and exactly two new ones. Surprise me.",
  );
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let call = 0;

  const tools: BeamToolDefinition[] = [
    {
      name: "beam_score_candidates",
      description: "Rank owned bottles",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({
        recommendation: { canonicalName: "Sauvage Elixir", brand: "Dior", owned: true },
        picks: [
          { canonicalName: "Sauvage Elixir", brand: "Dior", owned: true },
          { canonicalName: "Egoiste Platinum", brand: "Chanel", owned: true },
        ],
      }),
    },
    {
      name: "beam_search_catalog",
      description: "Find new bottles",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({
        items: [
          { canonicalName: "Viking", brand: "Creed", owned: false },
          { canonicalName: "Wulong Cha", brand: "Nishane", owned: false },
        ],
      }),
    },
    {
      name: "beam_present_travel_kit",
      description: "Present the final kit",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({
        resolved: true,
        ownedCount: 2,
        newCount: 2,
        owned: [
          { name: "Sauvage Elixir", brand: "Dior" },
          { name: "Egoiste Platinum", brand: "Chanel" },
        ],
        newProposed: [
          { name: "Viking", brand: "Creed" },
          { name: "Wulong Cha", brand: "Nishane" },
        ],
        card: {
          kind: "travel_kit",
          ownedPicks: [
            { name: "Sauvage Elixir", brand: "Dior", notes: [], accords: [], owned: true },
            { name: "Egoiste Platinum", brand: "Chanel", notes: [], accords: [], owned: true },
          ],
          newPicks: [
            { name: "Viking", brand: "Creed", notes: [], accords: [] },
            { name: "Wulong Cha", brand: "Nishane", notes: [], accords: [] },
          ],
        },
      }),
      clientEvent: (result) => {
        const card = (result as { card?: BeamCard }).card;
        return card ? { type: "card", card } : null;
      },
    },
  ];

  const callModel = async (input: ClaudeCallInput): Promise<ClaudeResponse> => {
    call++;
    if (call === 1) {
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "score", name: "beam_score_candidates", input: {} }] };
    }
    if (call === 2) {
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "search", name: "beam_search_catalog", input: {} }] };
    }
    if (call === 3) {
      const reserved = input.tools.length === 1 && input.tools[0]?.name === "beam_present_travel_kit";
      return reserved
        ? {
            stop_reason: "tool_use",
            content: [{
              type: "tool_use",
              id: "present",
              name: "beam_present_travel_kit",
              input: {
                owned: [{ name: "Sauvage Elixir" }, { name: "Egoiste Platinum" }],
                newPicks: [{ name: "Viking" }, { name: "Wulong Cha" }],
              },
            }],
          }
        : { stop_reason: "tool_use", content: [{ type: "tool_use", id: "search-again", name: "beam_search_catalog", input: {} }] };
    }
    if (call === 4) {
      return text(
        "Pack Sauvage Elixir and Egoiste Platinum from your vault. Line up Viking and Wulong Cha as the two new picks.",
      );
    }
    return text("Pack Sauvage Elixir and Egoiste Platinum.");
  };

  await runBeamAgent({
    ctx,
    userMessage:
      "Plan a Tokyo August kit with exactly two from my wardrobe and exactly two new ones. Surprise me.",
    sessionState: state,
    tools,
    emit: (event) => events.push(event),
    isModelConfigured: () => true,
    callModel,
    maxTurns: 3,
    onComplete: (response) => (completed = response),
  });

  assert.match(String(completed), /Viking/i);
  assert.ok(
    events.some((event) => event.type === "card" && event.card.kind === "travel_kit"),
    "the exact-count travel-kit card must be emitted before completion",
  );
  assert.equal(events.some((event) => event.type === "failed"), false);
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

test("deterministic loop backtests fulfill the Dallas and Tokyo freeform missions without re-asking", async () => {
  const scenarios = [
    {
      message: "I'm going to a rooftop party in Dallas tonight. It's hot and humid. I want something clean, attractive, and not too loud. I already own Dior Homme Sport Very Cool and Creed Himalaya. Pick one from my collection and one new fragrance to try.",
      owned: [{ canonicalName: "Dior Homme Sport Very Cool", brand: "Dior", owned: true, score: 91 }],
      fresh: [{ canonicalName: "Molecule 01 + Mandarin", brand: "Escentric Molecules", owned: false }],
      answer: "Wear Dior Homme Sport Very Cool from your vault for the humid Dallas rooftop. New to try: Molecule 01 + Mandarin — clean, airy, and restrained enough for the party.",
      expectedSlots: /occasion=party.*direction=lighter\/fresh.*projection=moderate.*impression=attractive/i,
    },
    {
      message: "I'm planning a Tokyo trip in August. I need two fragrances to take with me and two new ones not in my collection. I want clean, modern, airy, slightly woody scents that work in humidity.",
      owned: [
        { canonicalName: "Creed Himalaya", brand: "Creed", owned: true, score: 90 },
        { canonicalName: "Dior Homme Sport Very Cool", brand: "Dior", owned: true, score: 86 },
      ],
      fresh: [
        { canonicalName: "Wulong Cha", brand: "Nishane", owned: false },
        { canonicalName: "Molecule 01", brand: "Escentric Molecules", owned: false },
      ],
      answer: "Pack Creed Himalaya and Dior Homme Sport Very Cool from your vault. New for Tokyo: Wulong Cha and Molecule 01 — clean, airy woods that suit August humidity.",
      expectedSlots: /month=August.*destination=Tokyo.*vibe=modern.*direction=lighter\/fresh, woody/i,
    },
  ];

  for (const scenario of scenarios) {
    const state = deriveBeamSessionState(undefined, scenario.message);
    const toolInputs: Array<{ tool: string; input: unknown }> = [];
    const tools: BeamToolDefinition[] = [
      {
        name: "beam_score_candidates",
        description: "Rank owned vault bottles",
        inputSchema: { type: "object", properties: {} },
        handler: async (input) => {
          toolInputs.push({ tool: "score", input });
          return { recommendation: scenario.owned[0], picks: scenario.owned };
        },
      },
      {
        name: "beam_search_catalog",
        description: "Search descriptive catalog profiles",
        inputSchema: { type: "object", properties: {} },
        handler: async (input) => {
          toolInputs.push({ tool: "search", input });
          return { items: scenario.fresh };
        },
      },
    ];
    const { callModel, seen } = scriptedModel([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "owned", name: "beam_score_candidates", input: {} }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "new", name: "beam_search_catalog", input: { query: "clean modern airy woody hot humid", excludeOwned: false } }] },
      text("draft"),
      text(scenario.answer),
    ]);
    let completed: string | undefined;
    await runBeamAgent({
      ctx,
      userMessage: scenario.message,
      sessionState: state,
      tools,
      emit: () => {},
      isModelConfigured: () => true,
      callModel,
      onComplete: (value) => (completed = value),
    });

    assert.equal(completed, scenario.answer);
    assert.match(seen[0]?.system ?? "", scenario.expectedSlots);
    assert.equal(toolInputs.length, 2);
    assert.deepEqual(toolInputs[1]?.input, {
      query: "clean modern airy woody hot humid",
      excludeOwned: true,
    });
    assert.doesNotMatch(completed ?? "", /what|which|where|when|prefer/i);
  }
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

test("unexpected provider errors never expose raw internals in client events", async () => {
  const events: BeamRunEvent[] = [];
  await runBeamAgent({
    ctx,
    userMessage: "help",
    tools: [],
    emit: (event) => events.push(event),
    isModelConfigured: () => true,
    callModel: async () => {
      throw new Error("upstream 401 key=sk-secret internal-host.example");
    },
  });

  const failed = events.find((event) => event.type === "failed");
  assert.equal(failed?.type, "failed");
  assert.equal((failed as { code: string }).code, "agent_error");
  assert.equal((failed as { message: string }).message, "Beam could not complete this request. Please try again.");
  assert.doesNotMatch((failed as { message: string }).message, /sk-secret|internal-host|401/i);
});

/** A vault scorer that always grounds Aventus — reused by the occasion E2E runs. */
function aventusScoreTool(): BeamToolDefinition {
  return {
    name: "beam_score_candidates",
    description: "Rank the vault",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      recommendation: { canonicalName: "Aventus", brand: "Creed", score: 90 },
      picks: [{ canonicalName: "Aventus", brand: "Creed", score: 90 }],
      scoredFor: { locationLabel: null, usedOverride: false },
    }),
  };
}

test("end-to-end occasion run: a plainly-stated occasion is threaded into the prompt and a pick ships", async () => {
  // Full-loop run (only the provider is faked) over the newly-captured occasion
  // path: "dinner party" must reach the system prompt as occasion=dinner, and the
  // run must complete with a grounded pick instead of re-asking the occasion.
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const message = "What should I wear to a dinner party this weekend?";
  const state = deriveBeamSessionState(undefined, message);
  assert.equal(state.slots.occasion, "dinner");

  const { callModel, seen } = scriptedModel([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "beam_score_candidates", input: {} }] },
    text("draft"),
    text("For the dinner party, reach for Aventus by Creed — bright and confident without crowding the room."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: message,
    sessionState: state,
    tools: [aventusScoreTool()],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(summary?.outcome, "completed");
  assert.equal(events.some((e) => e.type === "failed"), false);
  assert.match(seen[0].system, /Known so far: .*occasion=dinner/i);
  assert.match(String(completed), /Aventus/);
});

test("end-to-end occasion run: re-asking a KNOWN occasion is gated and repaired into a committed pick", async () => {
  // Exercises the closed gate hole through the whole loop: synthesis re-asks the
  // already-known occasion, the redundant_clarification gate trips, and the single
  // repair pass (fed the broken rule) ships a committed grounded recommendation
  // instead of dead-ending on the redundant question.
  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;

  const message = "Recommend something for a wedding I'm attending.";
  const state = deriveBeamSessionState(undefined, message);
  assert.equal(state.slots.occasion, "wedding");

  const { callModel, seen } = scriptedModel([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "beam_score_candidates", input: {} }] },
    text("draft"),
    // synthesis re-asks the known occasion -> redundant_clarification
    text("Happy to help — what's the occasion you're dressing for?"),
    // repair pass commits to the grounded pick
    text("For the wedding, wear Aventus by Creed — polished and celebratory."),
  ]);

  await runBeamAgent({
    ctx,
    userMessage: message,
    sessionState: state,
    tools: [aventusScoreTool()],
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    synthesisModel: "strong-model",
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(events.some((e) => e.type === "failed"), false);
  assert.equal(completed, "For the wedding, wear Aventus by Creed — polished and celebratory.");
  assert.equal(summary?.qualityGatePassed, true);
  assert.equal(summary?.modelCalls, 4); // tool + draft + synthesis + one repair
  // The repair instruction fed the redundant-clarification fix (now naming occasion) back.
  const repairCall = seen[seen.length - 1];
  const folded = repairCall.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("\n");
  assert.match(folded, /Do NOT ask for month, destination, occasion/i);
});

test("presenting a complete travel kit marks the mission kitPresented for refinement", async () => {
  // A present-travel-kit tool that resolves the exact 2+2 lanes and surfaces a card.
  const kitTool: BeamToolDefinition = {
    name: "beam_present_travel_kit",
    description: "Lay out the owned + new picks as a board",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      ownedCount: 2,
      newCount: 2,
      owned: [
        { canonicalName: "Aventus", brand: "Creed" },
        { canonicalName: "Gabrielle", brand: "Chanel" },
      ],
      newProposed: [
        { canonicalName: "Tam Dao", brand: "Diptyque" },
        { canonicalName: "Philosykos", brand: "Diptyque" },
      ],
    }),
    clientEvent: (result) => {
      const r = result as { owned: unknown[]; newProposed: unknown[] };
      return {
        type: "card",
        card: {
          kind: "travel_kit",
          ownedPicks: [
            { name: "Aventus", brand: "Creed", accords: ["fruity"], owned: true },
            { name: "Gabrielle", brand: "Chanel", accords: ["floral"], owned: true },
          ],
          newPicks: [
            { name: "Tam Dao", brand: "Diptyque", notes: [], accords: ["woody"] },
            { name: "Philosykos", brand: "Diptyque", notes: [], accords: ["green"] },
          ],
        },
      };
    },
  };

  // A ready 2+2 travel mission, not yet presented.
  const sessionState: BeamSessionState = {
    slots: { destination: "Tokyo", month: "August", direction: "woody" },
    mission: { intent: "travel_kit", ownedCount: 2, newCount: 2, destination: "Tokyo", month: "August" },
  };

  const { callModel } = scriptedModel([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_kit", name: "beam_present_travel_kit", input: {} }] },
    text("draft kit"),
    text("From your vault, pack Aventus and Gabrielle. New: Tam Dao and Philosykos — all fit an artsy Tokyo August."),
  ]);

  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;
  await runBeamAgent({
    ctx,
    userMessage: "Build my Tokyo kit",
    tools: [kitTool],
    sessionState,
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(summary?.outcome, "completed", JSON.stringify(summary));
  assert.ok(events.some((e) => e.type === "card" && e.card.kind === "travel_kit"));
  assert.ok(completed && /Aventus/.test(completed));
  // The mission is now flagged so the route persists "kit presented" and the next
  // turn is treated as a refinement (the prose count gate is relaxed there).
  assert.equal(sessionState.mission?.kitPresented, true);
});

test("live regression: a delegated tool-grounded turn whose synthesis names no pick commits to the grounded picks instead of failing empty", async () => {
  // Found by the live OpenRouter QA harness on the Tokyo -> "You decide - surprise
  // me." transcript: the model searched (grounding two unowned candidates), but the
  // synthesis AND its single repair pass both came back without naming a grounded
  // pick. The owed-recommendation gate (recommendation_without_grounded_pick) then
  // hard-failed the run, so the user saw an EMPTY answer on a turn they had
  // explicitly delegated. A tool-grounded turn the user is owed a pick on must
  // never dead-end: when synthesis can't name one, the loop commits deterministically
  // to the grounded candidates (the mirror of buildSafeClarification for ask-turns).
  const searchTool: BeamToolDefinition = {
    name: "beam_search_catalog",
    description: "Search the catalog",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    handler: async () => ({
      count: 2,
      items: [
        { canonicalName: "Wulong Cha", brand: "Nishane", owned: false, accords: ["green", "tea"] },
        { canonicalName: "Greenley", brand: "Parfums de Marly", owned: false, accords: ["green", "fresh"] },
      ],
    }),
  };

  // A hedge that names no grounded fragrance and asks nothing — exactly the
  // gate-failing shape the live synthesis + repair produced.
  const HEDGE = "These are all solid options for your trip.";
  const { callModel } = scriptedModel([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_s", name: "beam_search_catalog", input: { query: "tokyo fresh" } }] },
    text(HEDGE), // orchestration draft
    text(HEDGE), // synthesis
    text(HEDGE), // repair
  ]);

  const sessionState: BeamSessionState = {
    slots: { destination: "Tokyo", month: "June", direction: "fresh" },
    mission: {
      intent: "travel_kit",
      ownedCount: 0,
      newCount: 2,
      destination: "Tokyo",
      month: "June",
      userDelegatedChoice: true,
      kitPresented: true,
    },
    userDelegatedChoice: true,
  };

  const events: BeamRunEvent[] = [];
  let completed: string | undefined;
  let summary: BeamRunSummary | undefined;
  await runBeamAgent({
    ctx,
    userMessage: "You decide — surprise me.",
    tools: [searchTool],
    sessionState,
    emit: (e) => events.push(e),
    isModelConfigured: () => true,
    callModel,
    onComplete: (t) => (completed = t),
    onSummary: (s) => (summary = s),
  });

  assert.equal(
    events.some((e) => e.type === "failed"),
    false,
    "delegated turn must not hard-fail: " + JSON.stringify(events.filter((e) => e.type === "failed")),
  );
  assert.equal(summary?.outcome, "completed", JSON.stringify(summary));
  assert.ok(completed && completed.trim().length > 0, "expected a non-empty committed answer");
  assert.match(completed!, /Wulong Cha|Greenley/, completed);
});
