/**
 * Pure unit tests for the Beam Agent tool/runtime helpers.
 *
 * Runs with Node's built-in test runner, no workspace deps required:
 *   node --experimental-strip-types --test src/beam-agent/beamToolCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEAM_LIMITS,
  asString,
  clampLimit,
  cleanStringList,
  extractText,
  extractToolUses,
  packetFromFlatProfile,
  packetFromOwnedItem,
  packetFromWardrobeRow,
  redactEventForClient,
  summarizeToolResult,
  toClaudeTools,
} from "./beamToolCore.ts";
import type { BeamToolDefinition, ClaudeContentBlock } from "./types.ts";

test("clampLimit enforces server ceiling and floor", () => {
  assert.equal(clampLimit(1000, BEAM_LIMITS.maxCatalogResults), BEAM_LIMITS.maxCatalogResults);
  assert.equal(clampLimit(0, 12), 1);
  assert.equal(clampLimit(-5, 12), 1);
  assert.equal(clampLimit(5, 12), 5);
  assert.equal(clampLimit("nope", 12, 3), 3);
  assert.equal(clampLimit(undefined, 12, 7), 7);
});

test("asString trims and rejects non-strings/empties", () => {
  assert.equal(asString("  hi  "), "hi");
  assert.equal(asString("   "), undefined);
  assert.equal(asString(42), undefined);
  assert.equal(asString(null), undefined);
});

test("cleanStringList dedupes case-insensitively, trims, and caps", () => {
  assert.deepEqual(cleanStringList(["Vanilla", "vanilla", " Amber ", 5, ""]), ["Vanilla", "Amber"]);
  assert.deepEqual(cleanStringList("not-an-array"), []);
  assert.equal(cleanStringList(Array.from({ length: 100 }, (_, i) => `n${i}`), 24).length, 24);
});

test("extractToolUses / extractText split a Claude content array", () => {
  const content: ClaudeContentBlock[] = [
    { type: "text", text: "Let me check. " },
    { type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} },
    { type: "text", text: "One moment." },
  ];
  const uses = extractToolUses(content);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].name, "beam_get_wardrobe");
  assert.equal(extractText(content), "Let me check. One moment.");
});

test("redactEventForClient passes safe events and never leaks unknown types", () => {
  assert.deepEqual(
    redactEventForClient({ type: "tool_started", tool: "beam_search_catalog" }),
    { type: "tool_started", tool: "beam_search_catalog" },
  );
  assert.deepEqual(
    redactEventForClient({ type: "failed", code: "max_turns", message: "budget reached" }),
    { type: "failed", code: "max_turns", message: "budget reached" },
  );
  // An unexpected/internal event shape collapses to a generic status.
  const sneaky = { type: "debug", secret: "DB_PASSWORD" } as unknown as Parameters<typeof redactEventForClient>[0];
  assert.deepEqual(redactEventForClient(sneaky), { type: "status", label: "Working" });
});

test("summarizeToolResult produces safe one-liners", () => {
  assert.equal(summarizeToolResult("beam_search_catalog", { items: [1, 2, 3] }), "3 result(s)");
  assert.equal(summarizeToolResult("beam_score_candidates", { recommendation: { canonicalName: "Aventus" } }), "picked Aventus");
  assert.equal(summarizeToolResult("beam_score_candidates", { recommendation: null }), "no match");
  assert.equal(summarizeToolResult("x", "whatever"), "done");
});

test("packetFromOwnedItem marks ownership and merges traits", () => {
  const packet = packetFromOwnedItem({
    id: "frag-1",
    name: "Sauvage",
    brand: "Dior",
    families: ["fresh"],
    accords: ["pepper", "fresh"],
    longevity: 7,
    sillage: "strong",
  });
  assert.equal(packet.owned, true);
  assert.equal(packet.fragranceId, "frag-1");
  assert.deepEqual(packet.accords, ["fresh", "pepper"]);
  assert.equal(packet.performance.longevity, 7);
  assert.equal(packet.performance.projection, "strong");
  assert.deepEqual(packet.missingFields, []);
});

test("packetFromFlatProfile defends against thin/untrusted records", () => {
  const thin = packetFromFlatProfile("g-1", {}, false);
  assert.equal(thin.owned, false);
  assert.deepEqual(thin.missingFields.sort(), ["accords", "brand", "name", "notes"]);
  assert.ok(thin.sourceConfidence < 0.9);

  const full = packetFromFlatProfile(
    "g-2",
    { name: "Aventus", brand: "Creed", accords: ["fruity", "smoky"], pyramid: { top: ["pineapple"], base: ["musk"] } },
    false,
  );
  assert.equal(full.canonicalName, "Aventus");
  assert.equal(full.brand, "Creed");
  assert.deepEqual(full.notes.top, ["pineapple"]);
  assert.equal(full.missingFields.length, 0);
  assert.equal(full.sourceConfidence, 0.9);
});

test("packetFromWardrobeRow preserves the note pyramid from the raw row", () => {
  const packet = packetFromWardrobeRow("row-9", {
    id: "frag-9",
    name: "Aventus",
    brand: "Creed",
    accords: ["fruity"],
    pyramid: { top: ["pineapple"], heart: ["birch"], base: ["musk", "musk"] },
    longevity: 8,
    sillage: "strong",
  });
  assert.ok(packet);
  assert.equal(packet!.owned, true);
  assert.equal(packet!.fragranceId, "frag-9");
  assert.deepEqual(packet!.notes, { top: ["pineapple"], middle: ["birch"], base: ["musk"] });
  assert.deepEqual(packet!.accords, ["fruity"]);
  assert.equal(packet!.performance.longevity, 8);
  assert.equal(packet!.performance.projection, "strong");
  assert.deepEqual(packet!.missingFields, []);
});

test("packetFromWardrobeRow returns null without a name and flags thin rows", () => {
  assert.equal(packetFromWardrobeRow("row-x", { brand: "Creed" }), null);
  assert.equal(packetFromWardrobeRow("row-x", null), null);

  const thin = packetFromWardrobeRow("row-y", { name: "Mystery Juice" });
  assert.ok(thin);
  assert.equal(thin!.canonicalName, "Mystery Juice");
  assert.deepEqual(thin!.missingFields.sort(), ["accords", "notes"]);
  assert.ok(thin!.sourceConfidence < 0.95);
});

test("toClaudeTools maps name/description/input_schema", () => {
  const defs: BeamToolDefinition[] = [
    {
      name: "beam_get_wardrobe",
      description: "List the user's vault.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ items: [] }),
    },
  ];
  const tools = toClaudeTools(defs);
  assert.equal(tools[0].name, "beam_get_wardrobe");
  assert.equal(tools[0].description, "List the user's vault.");
  assert.deepEqual(tools[0].input_schema, { type: "object", properties: {} });
});
