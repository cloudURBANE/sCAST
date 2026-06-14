/**
 * Pure unit tests for the OpenRouter adapter — translation only, no network.
 *
 * Runs with Node's built-in test runner, no workspace deps required:
 *   node --experimental-strip-types --test src/beam-agent/openRouterProvider.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test } from "./openRouterProvider.ts";
import type { ClaudeCallInput, ClaudeMessage } from "./types.ts";

const { toOpenAiMessages, toOpenAiTools, openAiResponseToClaude } = __test;

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

test("openAiResponseToClaude tolerates malformed tool-call arguments", () => {
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
  // No text block when content is null; bad JSON args degrade to {}.
  assert.equal(claude.content.length, 1);
  assert.deepEqual(claude.content[0], { type: "tool_use", id: "c", name: "beam_get_wardrobe", input: {} });
});

test("openAiResponseToClaude maps finish reasons", () => {
  assert.equal(openAiResponseToClaude({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] }).stop_reason, "end_turn");
  assert.equal(openAiResponseToClaude({ choices: [{ finish_reason: "length", message: { content: "hi" } }] }).stop_reason, "max_tokens");
  assert.equal(openAiResponseToClaude({ choices: [{ finish_reason: null, message: { content: "hi" } }] }).stop_reason, null);
});
