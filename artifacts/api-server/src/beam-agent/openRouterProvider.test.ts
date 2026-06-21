/**
 * Pure unit tests for the OpenRouter adapter — translation only, no network.
 *
 * Runs with Node's built-in test runner, no workspace deps required:
 *   node --experimental-strip-types --test src/beam-agent/openRouterProvider.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, modelSupportsCaching, premiumOrchestrationModel } from "./openRouterProvider.ts";
import { readInvalidArgs } from "./beamToolCore.ts";
import type { ClaudeCallInput, ClaudeMessage } from "./types.ts";

const { toOpenAiMessages, toOpenAiTools, openAiResponseToClaude } = __test;

test("modelSupportsCaching matches Anthropic slugs only", () => {
  assert.equal(modelSupportsCaching("anthropic/claude-sonnet-4.6"), true);
  assert.equal(modelSupportsCaching("claude-haiku-4-5"), true);
  assert.equal(modelSupportsCaching("google/gemma-4-31b-it:free"), false);
  assert.equal(modelSupportsCaching(undefined), false);
});

test("toOpenAiMessages keeps system as a plain string by default", () => {
  const out = toOpenAiMessages("SYS", [{ role: "user", content: "hi" }]);
  assert.deepEqual(out[0], { role: "system", content: "SYS" });
});

test("toOpenAiMessages marks the system prompt as a cache breakpoint when caching", () => {
  const out = toOpenAiMessages("SYS", [{ role: "user", content: "hi" }], true);
  assert.deepEqual(out[0], {
    role: "system",
    content: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }],
  });
});

test("toOpenAiMessages marks the last user turn as a cache breakpoint when caching", () => {
  const messages: ClaudeMessage[] = [
    { role: "user", content: "plan a trip kit" },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "beam_search_catalog", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"items":[]}' }] },
    // The folded synthesis instruction lands as a trailing user turn.
    { role: "user", content: "Write the final recommendation." },
  ];
  const out = toOpenAiMessages("SYS", messages, true);
  const last = out[out.length - 1] as { role: string; content: unknown };
  assert.equal(last.role, "user");
  // The whole prefix (system + tool results) caches up to this breakpoint.
  assert.deepEqual(last.content, [
    { type: "text", text: "Write the final recommendation.", cache_control: { type: "ephemeral" } },
  ]);
});

test("toOpenAiMessages leaves user turns as plain strings when NOT caching", () => {
  const messages: ClaudeMessage[] = [{ role: "user", content: "Write the final recommendation." }];
  const out = toOpenAiMessages("SYS", messages, false);
  const last = out[out.length - 1] as { role: string; content: unknown };
  assert.equal(last.role, "user");
  assert.equal(last.content, "Write the final recommendation.");
});

test("premiumOrchestrationModel never returns the synthesis (strong) slug", () => {
  const prevPremium = process.env.BEAM_AGENT_MODEL_PREMIUM;
  const prevStrong = process.env.BEAM_AGENT_MODEL_STRONG;
  delete process.env.BEAM_AGENT_MODEL_PREMIUM;
  process.env.BEAM_AGENT_MODEL_STRONG = "anthropic/claude-sonnet-4.6";
  try {
    // Premium orchestration must stay on its own cheap tier even when the strong
    // synthesis slug is overridden to an expensive Anthropic model.
    assert.equal(premiumOrchestrationModel(), "google/gemma-4-31b-it:free");
  } finally {
    if (prevPremium === undefined) delete process.env.BEAM_AGENT_MODEL_PREMIUM;
    else process.env.BEAM_AGENT_MODEL_PREMIUM = prevPremium;
    if (prevStrong === undefined) delete process.env.BEAM_AGENT_MODEL_STRONG;
    else process.env.BEAM_AGENT_MODEL_STRONG = prevStrong;
  }
});

test("toOpenAiTools maps the Anthropic tool shape to OpenAI function tools", () => {
  const tools: ClaudeCallInput["tools"] = [
    {
      name: "beam_search_catalog",
      description: "Search the catalog",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  ];
  const out = toOpenAiTools(tools);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "function");
  assert.equal(out[0].function.name, "beam_search_catalog");
  assert.equal(out[0].function.description, "Search the catalog");
  assert.deepEqual(out[0].function.parameters, tools[0].input_schema);
});

test("toOpenAiMessages prepends system and passes a plain string user turn", () => {
  const out = toOpenAiMessages("SYS", [{ role: "user", content: "hi there" }]);
  assert.deepEqual(out[0], { role: "system", content: "SYS" });
  assert.deepEqual(out[1], { role: "user", content: "hi there" });
});

test("toOpenAiMessages converts assistant tool_use blocks into tool_calls", () => {
  const messages: ClaudeMessage[] = [
    { role: "user", content: "what's in my vault?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "call_1", name: "beam_get_wardrobe", input: { limit: 5 } },
      ],
    },
  ];
  const out = toOpenAiMessages("SYS", messages);
  const assistant = out[2] as { role: string; content: string | null; tool_calls?: unknown[] };
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "Let me check.");
  assert.deepEqual(assistant.tool_calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "beam_get_wardrobe", arguments: JSON.stringify({ limit: 5 }) },
    },
  ]);
});

test("toOpenAiMessages expands tool_result blocks into separate tool messages", () => {
  const messages: ClaudeMessage[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: '{"items":[]}' },
        { type: "tool_result", tool_use_id: "call_2", content: "boom", is_error: true },
      ],
    },
  ];
  const out = toOpenAiMessages("SYS", messages);
  assert.deepEqual(out[1], { role: "tool", tool_call_id: "call_1", content: '{"items":[]}' });
  assert.deepEqual(out[2], { role: "tool", tool_call_id: "call_2", content: "ERROR: boom" });
});

test("assistant turn with no text serializes content as null", () => {
  const messages: ClaudeMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "c", name: "beam_get_wardrobe", input: {} }] },
  ];
  const assistant = toOpenAiMessages("SYS", messages)[1] as { content: string | null };
  assert.equal(assistant.content, null);
});

test("openAiResponseToClaude builds text + tool_use content blocks", () => {
  const claude = openAiResponseToClaude({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "Working on it",
          tool_calls: [
            { id: "call_9", type: "function", function: { name: "beam_score_candidates", arguments: '{"x":1}' } },
          ],
        },
      },
    ],
  });
  assert.equal(claude.stop_reason, "tool_use");
  assert.deepEqual(claude.content[0], { type: "text", text: "Working on it" });
  assert.deepEqual(claude.content[1], {
    type: "tool_use",
    id: "call_9",
    name: "beam_score_candidates",
    input: { x: 1 },
  });
});

test("openAiResponseToClaude marks malformed tool-call arguments instead of silently dropping them", () => {
  const claude = openAiResponseToClaude({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{ id: "c", type: "function", function: { name: "beam_get_wardrobe", arguments: "{not json" } }],
        },
      },
    ],
  });
  // No text block when content is null; bad JSON args carry the invalid-args
  // marker so the loop returns an explicit tool error and the model retries.
  assert.equal(claude.content.length, 1);
  const block = claude.content[0] as { type: string; id: string; name: string; input: Record<string, unknown> };
  assert.equal(block.type, "tool_use");
  assert.equal(block.name, "beam_get_wardrobe");
  assert.equal(readInvalidArgs(block.input), "{not json");
});

test("openAiResponseToClaude surfaces token usage for cost accounting", () => {
  const claude = openAiResponseToClaude({
    choices: [{ finish_reason: "stop", message: { content: "hi" } }],
    usage: { prompt_tokens: 123, completion_tokens: 45 },
  });
  assert.deepEqual(claude.usage, { inputTokens: 123, outputTokens: 45 });
});

test("openAiResponseToClaude maps finish reasons", () => {
  assert.equal(openAiResponseToClaude({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] }).stop_reason, "end_turn");
  assert.equal(openAiResponseToClaude({ choices: [{ finish_reason: "length", message: { content: "hi" } }] }).stop_reason, "max_tokens");
  assert.equal(openAiResponseToClaude({ choices: [{ finish_reason: null, message: { content: "hi" } }] }).stop_reason, null);
});
