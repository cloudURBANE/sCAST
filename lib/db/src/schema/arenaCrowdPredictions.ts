import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { communityPostsTable } from "./communityPosts";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

// One row per scored "Crowd vs You" read. Idempotent per (user, battle): the
// UNIQUE(user_id, post_id) constraint means a battle can only ever be scored
// once, so the daily set is a fixed, replayable queue (no re-rolls, no
// double-scoring). `streak_after` snapshots the streak value immediately after
// this read so best-streak/accuracy reads stay O(1) instead of scanning every
// prior row in order.
export const arenaCrowdPredictionsTable = pgTable(
  "arena_crowd_predictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => communityPostsTable.id, { onDelete: "cascade" }),
    // Tap 1: who the user bet the crowd is backing.
    predictedChoice: text("predicted_choice").notNull(),
    // Tap 2: the user's real own-pick, also written to community_votes.
    ownPick: text("own_pick").notNull(),
    // The live leader when the read was submitted. Null = no clear leader (push).
    leaderAtReveal: text("leader_at_reveal"),
    tallyTotalAtReveal: integer("tally_total_at_reveal").notNull(),
    wasCorrect: boolean("was_correct").notNull(),
    // Streak value immediately after this read (O(1) reads, replayable).
    streakAfter: integer("streak_after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("arena_crowd_predictions_user_post_unique_idx").on(table.userId, table.postId),
    index("arena_crowd_predictions_post_idx").on(table.postId),
    index("arena_crowd_predictions_user_idx").on(table.userId),
  ],
);

export type ArenaCrowdPrediction = typeof arenaCrowdPredictionsTable.$inferSelect;
export type NewArenaCrowdPrediction = typeof arenaCrowdPredictionsTable.$inferInsert;
