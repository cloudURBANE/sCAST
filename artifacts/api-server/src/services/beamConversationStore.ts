import { db } from "@workspace/db";
import { beamConversationsTable, beamMessagesTable } from "@workspace/db/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { BeamRunContext } from "../beam-agent/types.ts";
import {
  buildTurnRows,
  deriveConversationTitle,
  normalizeHistoryRows,
  MAX_HISTORY_TURNS,
  type ConversationTurn,
} from "./beamConversationCore.ts";

/**
 * Beam Agent — durable transcript persistence (W-11).
 *
 * The hot path for beam chat memory is Redis with a 1h TTL (`beamSessionStore.ts`);
 * this is the DURABLE backing store so a transcript survives TTL expiry, a Redis
 * flush, or a process restart, and can be reloaded to continue or display a thread.
 *
 * Writes are best-effort and NEVER affect the run or its SSE stream, mirroring
 * `beamAnswerLog` / `apiUsageLedger`: a missing table (the deploy doesn't run
 * `drizzle migrate` automatically) or any DB fault is caught and swallowed. Reads
 * fail closed to `[]`. Everything is scoped by `user_id` (+ `tenant_id`).
 */

function isTableMissingError(err: unknown): boolean {
  const value = err as { code?: unknown; message?: unknown } | null;
  return (
    value?.code === "42P01" ||
    (typeof value?.message === "string" &&
      /relation ["']?beam_(conversations|messages)["']? does not exist/i.test(value.message))
  );
}

export type PersistBeamTurnInput = {
  ctx: BeamRunContext;
  userMessage: string;
  assistantText: string;
};

/**
 * Persist one user/assistant exchange to the durable transcript store.
 *
 * Upserts the per-session conversation header (first user turn becomes its title),
 * then appends the two message rows at the next free `seq`. The route serializes
 * turns per session (one active run per session + a Redis lock), so the
 * read-max-seq → insert here is not racing a concurrent turn for the same session.
 *
 * Best-effort: returns silently on a missing table or any fault. Never throws.
 */
export async function persistBeamConversationTurn(input: PersistBeamTurnInput): Promise<void> {
  const { ctx, userMessage, assistantText } = input;
  if (!ctx.userId || !ctx.sessionId) return;
  const now = new Date();
  try {
    // 1) Upsert the conversation header. The first turn's message seeds the title;
    //    later turns leave it untouched (first-message-wins) and just bump the
    //    activity timestamps.
    const [conversation] = await db
      .insert(beamConversationsTable)
      .values({
        tenantId: ctx.tenantId ?? null,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        title: deriveConversationTitle(userMessage),
        updatedAt: now,
        lastMessageAt: now,
      })
      .onConflictDoUpdate({
        target: [beamConversationsTable.userId, beamConversationsTable.sessionId],
        set: { updatedAt: now, lastMessageAt: now },
      })
      .returning({ id: beamConversationsTable.id });

    if (!conversation) return;

    // 2) Next free seq for this conversation (turns are serialized per session).
    const [last] = await db
      .select({ seq: beamMessagesTable.seq })
      .from(beamMessagesTable)
      .where(eq(beamMessagesTable.conversationId, conversation.id))
      .orderBy(desc(beamMessagesTable.seq))
      .limit(1);
    const baseSeq = (last?.seq ?? -1) + 1;

    // 3) Append the user + assistant rows.
    const rows = buildTurnRows(userMessage, assistantText, baseSeq).map((row) => ({
      conversationId: conversation.id,
      tenantId: ctx.tenantId ?? null,
      userId: ctx.userId,
      role: row.role,
      content: row.content,
      seq: row.seq,
      createdAt: now,
    }));
    await db.insert(beamMessagesTable).values(rows);
  } catch (err) {
    if (isTableMissingError(err)) return;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[beamConversationStore] failed to persist conversation turn",
    );
  }
}

/**
 * Reload the durable transcript for a session, scoped to its owner. Returns the
 * most recent `MAX_HISTORY_TURNS` as ordered `{ role, content }` turns, or `[]`
 * when there is no stored conversation, the table is missing, or any fault occurs.
 */
export async function loadBeamConversationHistory(params: {
  userId: string;
  sessionId: string;
  limit?: number;
}): Promise<ConversationTurn[]> {
  const { userId, sessionId } = params;
  if (!userId || !sessionId) return [];
  const limit = params.limit ?? MAX_HISTORY_TURNS;
  try {
    const [conversation] = await db
      .select({ id: beamConversationsTable.id })
      .from(beamConversationsTable)
      .where(and(eq(beamConversationsTable.userId, userId), eq(beamConversationsTable.sessionId, sessionId)))
      .limit(1);
    if (!conversation) return [];

    const rows = await db
      .select({
        role: beamMessagesTable.role,
        content: beamMessagesTable.content,
        seq: beamMessagesTable.seq,
        createdAt: beamMessagesTable.createdAt,
      })
      .from(beamMessagesTable)
      .where(eq(beamMessagesTable.conversationId, conversation.id))
      // Newest first + a bound so a very long thread can't load unbounded; the
      // core re-sorts ascending and keeps the last `limit`.
      .orderBy(desc(beamMessagesTable.seq), desc(beamMessagesTable.createdAt))
      .limit(limit * 2);
    return normalizeHistoryRows(rows, limit);
  } catch (err) {
    if (isTableMissingError(err)) return [];
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[beamConversationStore] failed to load conversation history",
    );
    return [];
  }
}
