import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { beamConversationsTable } from "./conversations";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

/**
 * Beam Agent — durable transcript message (W-11).
 *
 * One row per user/assistant turn inside a `beam_conversations` thread. `tenant_id`
 * and `user_id` are denormalized off the parent so a scoped read/delete needs no
 * join and stays fast. `seq` is a monotonic per-conversation order so two rows
 * sharing a `created_at` tick keep a deterministic sequence on reload.
 *
 * Named `beam_messages` (not the generic `messages`) for the same shared-DB
 * collision reason as the parent table. Additive + best-effort — see
 * `beam_conversations` / `beamConversationStore.ts`.
 */
export const beamMessagesTable = pgTable(
  "beam_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => beamConversationsTable.id, { onDelete: "cascade" }),
    // Denormalized owner for scoped reads/deletes without a join.
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    // 'user' | 'assistant'.
    role: text("role").notNull(),
    content: text("content").notNull(),
    // Monotonic per-conversation ordering; the stable sort key on reload.
    seq: integer("seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationSeqIdx: index("beam_messages_conversation_seq_idx").on(table.conversationId, table.seq),
  }),
);

export const insertBeamMessageSchema = createInsertSchema(beamMessagesTable).omit({
  id: true,
  createdAt: true,
});

export type BeamMessage = typeof beamMessagesTable.$inferSelect;
export type NewBeamMessage = typeof beamMessagesTable.$inferInsert;
export type InsertBeamMessage = z.infer<typeof insertBeamMessageSchema>;
