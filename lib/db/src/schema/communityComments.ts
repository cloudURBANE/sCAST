import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { communityPostsTable } from "./communityPosts";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const communityCommentsTable = pgTable(
  "community_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    postId: uuid("post_id")
      .notNull()
      .references(() => communityPostsTable.id, { onDelete: "cascade" }),
    parentCommentId: uuid("parent_comment_id"),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("community_comments_post_created_at_idx").on(table.postId, table.createdAt),
  ],
);

export type CommunityComment = typeof communityCommentsTable.$inferSelect;
export type NewCommunityComment = typeof communityCommentsTable.$inferInsert;
