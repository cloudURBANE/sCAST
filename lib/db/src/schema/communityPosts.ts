import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const communityPostTypeEnum = pgEnum("community_post_type", [
  "question",
  "sotd",
  "battle",
  "worth_it",
]);

export const communityPostsTable = pgTable(
  "community_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    postType: communityPostTypeEnum("post_type").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("community_posts_tenant_created_at_idx").on(table.tenantId, table.createdAt),
    index("community_posts_post_type_idx").on(table.postType),
    index("community_posts_user_id_idx").on(table.userId),
  ],
);

export type CommunityPost = typeof communityPostsTable.$inferSelect;
export type NewCommunityPost = typeof communityPostsTable.$inferInsert;
export type CommunityPostType = (typeof communityPostTypeEnum.enumValues)[number];
