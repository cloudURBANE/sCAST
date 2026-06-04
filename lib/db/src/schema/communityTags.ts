import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { communityPostsTable } from "./communityPosts";
import { tenantsTable } from "./tenants";

export const communityTagsTable = pgTable(
  "community_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    postId: uuid("post_id")
      .notNull()
      .references(() => communityPostsTable.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("community_tags_tag_idx").on(table.tag),
    index("community_tags_post_idx").on(table.postId),
  ],
);

export type CommunityTag = typeof communityTagsTable.$inferSelect;
export type NewCommunityTag = typeof communityTagsTable.$inferInsert;
