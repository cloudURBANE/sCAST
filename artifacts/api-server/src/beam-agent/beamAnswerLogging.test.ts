/**
 * Tests for the durable-answer-log prerequisite + prompt unification:
 *   - the `completed` event carries the durable answer id (= the run id),
 *   - the run summary exposes the grounded candidate list + final answer text the
 *     route persists to `beam_answer_log`,
 *   - the LIVE system prompt actually includes the hermes-beam safety/ontology
 *     rules (audit A1 — so the production path can't silently drift away again).
 *
 *   node --experimental-strip-types --test src/beam-agent/beamAnswerLogging.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBeamAgent, type BeamRunSummary } from "./beamAgentLoop.ts";
import type { BeamRunContext, BeamRunEvent, ClaudeCallInput, ClaudeResponse } from "./types.ts";

const ctx: BeamRunContext = { runId: "run_log_1", sessionId: "s_1", tenantId: "t_1", userId: "u_1" };
const text = (t: string): ClaudeResponse => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });

test("completed event carries the durable answer id and the summary carries the persisted record", async () => {
  const events: BeamRunEvent[] = [];
  let summary: BeamRunSummary | undefined;

  await runBeamAgent({
    ctx,
    userMessage: "hey there",
    tools: [],
    emit: (event) => events.push(event),
    isModelConfigured: () => true,
    callModel: async () => text("Hello — what are you in the mood for?"),
    onSummary: (value) => (summary = value),
  });

  const completed = events.find((e) => e.type === "completed");
  assert.ok(completed && completed.type === "completed");
  if (completed?.type !== "completed") return;
  assert.equal(completed.answerLogId, "run_log_1");
  assert.equal(completed.response.trim().length > 0, true);

  // The summary carries exactly what the route writes to beam_answer_log.
  assert.equal(summary?.finalAnswer, completed.response);
  assert.deepEqual(summary?.groundedFragranceList, []);
  assert.equal(summary?.shippedWithSoftViolations, false);
});

test("the live system prompt includes the hermes-beam safety/ontology rules", async () => {
  const seen: ClaudeCallInput[] = [];
  const callModel = async (input: ClaudeCallInput): Promise<ClaudeResponse> => {
    seen.push(input);
    return text("Tell me the occasion and I'll line up a pick.");
  };

  await runBeamAgent({
    ctx,
    userMessage: "hi",
    tools: [],
    emit: () => {},
    isModelConfigured: () => true,
    callModel,
  });

  const system = seen[0]?.system ?? "";
  // Base concierge prompt is still present...
  assert.match(system, /Beam Agent for ScentBeam/);
  // ...AND the hermes-beam rules that were previously never loaded on this path.
  assert.match(system, /Stay in domain/i);
  assert.match(system, /ingredient-safety/i);
  assert.match(system, /untrusted/i);
  assert.match(system, /Clone.*dupe.*inspired-by|inspired-by/i);
});
