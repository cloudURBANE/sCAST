/**
 * Pure-core tests for the durable beam transcript store (W-11).
 *   node --experimental-strip-types --test src/services/beamConversationCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurnRows,
  capMessageContent,
  deriveConversationTitle,
  normalizeHistoryRows,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
  TITLE_MAX_CHARS,
  type StoredMessageRow,
} from "./beamConversationCore.ts";

test("deriveConversationTitle collapses whitespace and returns a short single line", () => {
  assert.equal(deriveConversationTitle("  something   fresh\nfor summer  "), "something fresh for summer");
});

test("deriveConversationTitle returns empty for blank input (UI falls back to a label)", () => {
  assert.equal(deriveConversationTitle("   \n\t "), "");
  assert.equal(deriveConversationTitle(""), "");
});

test("deriveConversationTitle caps long input on a word boundary with an ellipsis", () => {
  const long = "recommend me a warm woody winter fragrance that projects well but is not too loud for the office please";
  const title = deriveConversationTitle(long);
  assert.ok(title.length <= TITLE_MAX_CHARS + 1, `title too long: ${title.length}`);
  assert.ok(title.endsWith("…"));
  assert.ok(!title.includes("  "));
});

test("capMessageContent bounds runaway content", () => {
  const huge = "x".repeat(MAX_MESSAGE_CHARS + 500);
  assert.equal(capMessageContent(huge).length, MAX_MESSAGE_CHARS);
  assert.equal(capMessageContent("short"), "short");
});

test("buildTurnRows emits user then assistant at consecutive seqs", () => {
  const rows = buildTurnRows("hi there", "hello — what's the occasion?", 4);
  assert.deepEqual(
    rows.map((r) => [r.role, r.seq]),
    [
      ["user", 4],
      ["assistant", 5],
    ],
  );
  assert.equal(rows[0].content, "hi there");
  assert.equal(rows[1].content, "hello — what's the occasion?");
});

test("normalizeHistoryRows orders by seq then created_at and drops junk rows", () => {
  const rows: StoredMessageRow[] = [
    { role: "assistant", content: "second-assistant", seq: 3, createdAt: "2026-01-01T00:00:03Z" },
    { role: "user", content: "first-user", seq: 0, createdAt: "2026-01-01T00:00:00Z" },
    { role: "assistant", content: "first-assistant", seq: 1, createdAt: "2026-01-01T00:00:01Z" },
    { role: "user", content: "second-user", seq: 2, createdAt: "2026-01-01T00:00:02Z" },
    { role: "system", content: "should be dropped", seq: 4, createdAt: "2026-01-01T00:00:04Z" },
    { role: "user", content: "", seq: 5, createdAt: "2026-01-01T00:00:05Z" },
  ];
  assert.deepEqual(normalizeHistoryRows(rows), [
    { role: "user", content: "first-user" },
    { role: "assistant", content: "first-assistant" },
    { role: "user", content: "second-user" },
    { role: "assistant", content: "second-assistant" },
  ]);
});

test("normalizeHistoryRows falls back to created_at when seq ties", () => {
  const rows: StoredMessageRow[] = [
    { role: "assistant", content: "later", seq: 0, createdAt: "2026-01-01T00:00:02Z" },
    { role: "user", content: "earlier", seq: 0, createdAt: "2026-01-01T00:00:01Z" },
  ];
  assert.deepEqual(normalizeHistoryRows(rows), [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "later" },
  ]);
});

test("normalizeHistoryRows keeps only the most recent MAX_HISTORY_TURNS", () => {
  const rows: StoredMessageRow[] = Array.from({ length: MAX_HISTORY_TURNS + 6 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `turn-${i}`,
    seq: i,
    createdAt: null,
  }));
  const turns = normalizeHistoryRows(rows);
  assert.equal(turns.length, MAX_HISTORY_TURNS);
  // The oldest 6 are dropped; the newest survives.
  assert.equal(turns[0].content, "turn-6");
  assert.equal(turns.at(-1)?.content, `turn-${MAX_HISTORY_TURNS + 5}`);
});
