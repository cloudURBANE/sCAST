import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { communityPostsTable } from "./communityPosts";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const communityVotesTable = pgTable(
  "community_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    postId: uuid("post_id")
      .notNull()
      .references(() => communityPostsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    choice: text("choice").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("community_votes_user_post_unique_idx").on(table.userId, table.postId),
    index("community_votes_post_idx").on(table.postId),
  ],
);

export type CommunityVote = typeof communityVotesTable.$inferSelect;
export type NewCommunityVote = typeof communityVotesTable.$inferInsert;
