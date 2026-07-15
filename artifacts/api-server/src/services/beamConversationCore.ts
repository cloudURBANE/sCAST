/**
 * Beam Agent — durable transcript store, pure core (W-11).
 *
 * Framework/DB-free shaping helpers so the title derivation, content capping, and
 * reload ordering are unit-testable without a live Postgres. The thin DB wrapper
 * that actually reads/writes `beam_conversations` / `beam_messages` lives in
 * `beamConversationStore.ts` and delegates all shaping here.
 */

export type ConversationRole = "user" | "assistant";

export type ConversationTurn = { role: ConversationRole; content: string };

/** A persisted message row, as read back for reload (only the fields we order on). */
export type StoredMessageRow = {
  role: string;
  content: string;
  seq: number | null;
  createdAt: Date | string | null;
};

/** Cap a single stored message so a runaway draft can't bloat a row. */
export const MAX_MESSAGE_CHARS = 8000;
/** Cap the title derived from the first user turn. */
export const TITLE_MAX_CHARS = 80;
/**
 * Most-recent turns returned on reload. Matches the Redis session cap
 * (`MAX_SESSION_TURNS` = 16) so the durable path and the hot path agree on how
 * much history the agent sees.
 */
export const MAX_HISTORY_TURNS = 16;

/** Trim + collapse internal whitespace/newlines and cap length. */
export function capMessageContent(text: string, max: number = MAX_MESSAGE_CHARS): string {
  return String(text ?? "").slice(0, max);
}

/**
 * A short, single-line title from the first user message. Empty/whitespace input
 * yields "" so the caller/UI can fall back to a generic label.
 */
export function deriveConversationTitle(firstUserMessage: string): string {
  const collapsed = String(firstUserMessage ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed;
  // Cut on a word boundary when there is one reasonably close to the cap.
  const hardCut = collapsed.slice(0, TITLE_MAX_CHARS);
  const lastSpace = hardCut.lastIndexOf(" ");
  const body = lastSpace >= TITLE_MAX_CHARS - 16 ? hardCut.slice(0, lastSpace) : hardCut;
  return `${body.trimEnd()}…`;
}

/** The two message rows (user then assistant) for one exchange, given the next free seq. */
export function buildTurnRows(
  userMessage: string,
  assistantText: string,
  baseSeq: number,
): Array<{ role: ConversationRole; content: string; seq: number }> {
  return [
    { role: "user", content: capMessageContent(userMessage), seq: baseSeq },
    { role: "assistant", content: capMessageContent(assistantText), seq: baseSeq + 1 },
  ];
}

function toMillis(value: Date | string | null): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * Ordered `{ role, content }` turns from stored rows: sort by `seq` then
 * `created_at` (the tie-break when two rows share a seq), drop rows with an
 * unusable role, and keep only the most recent `MAX_HISTORY_TURNS`.
 */
export function normalizeHistoryRows(
  rows: readonly StoredMessageRow[],
  limit: number = MAX_HISTORY_TURNS,
): ConversationTurn[] {
  const ordered = [...rows].sort((a, b) => {
    const seqA = a.seq ?? 0;
    const seqB = b.seq ?? 0;
    if (seqA !== seqB) return seqA - seqB;
    return toMillis(a.createdAt) - toMillis(b.createdAt);
  });
  const turns: ConversationTurn[] = [];
  for (const row of ordered) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    if (typeof row.content !== "string" || row.content.length === 0) continue;
    turns.push({ role: row.role, content: row.content });
  }
  return turns.length > limit ? turns.slice(-limit) : turns;
}
