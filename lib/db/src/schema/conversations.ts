import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

/**
 * Beam Agent — durable conversation header (W-11).
 *
 * One row per (user, beam session): the client re-sends `sessionId` (`beam_<uuid>`)
 * to continue a thread, so a session maps to exactly one conversation. This is the
 * durable backing store for the beam chat transcript, which otherwise lives only in
 * Redis with a 1h TTL (`beamSessionStore.ts`) and is lost on TTL expiry or restart.
 *
 * Named `beam_conversations` (not the generic `conversations`) on purpose: the live
 * DATABASE_URL can point at a SHARED Supabase project whose `public` schema holds
 * other apps' tables, so every table we own carries a `beam_`/app-specific prefix to
 * avoid colliding with a foreign `conversations` table. See drizzle.config.ts.
 *
 * Additive table. The deploy pipeline does NOT run `drizzle push`/`migrate`
 * automatically, so writes no-op (best-effort, caught as 42P01) until the migration
 * is applied. Scoped by `tenant_id` + `user_id` (FK, deletable). No secrets stored.
 */
export const beamConversationsTable = pgTable(
  "beam_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The beam session id (`beam_<uuid>`) that groups the turns.
    sessionId: text("session_id").notNull(),
    // Short human label (derived from the first user turn); shown in a future
    // conversation list. Defaults to empty so an unset thread renders a fallback.
    title: text("title").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (table) => ({
    // One conversation per (user, session); the upsert target on turn append.
    userSessionIdx: uniqueIndex("beam_conversations_user_session_idx").on(table.userId, table.sessionId),
    // Recent-first listing for a user.
    userUpdatedIdx: index("beam_conversations_user_updated_idx").on(table.userId, table.updatedAt),
  }),
);

export const insertBeamConversationSchema = createInsertSchema(beamConversationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type BeamConversation = typeof beamConversationsTable.$inferSelect;
export type NewBeamConversation = typeof beamConversationsTable.$inferInsert;
export type InsertBeamConversation = z.infer<typeof insertBeamConversationSchema>;
