import { index, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { communityPostsTable } from "./communityPosts";
import { tenantsTable } from "./tenants";

export const communityPostFragrancesTable = pgTable(
  "community_post_fragrances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    postId: uuid("post_id")
      .notNull()
      .references(() => communityPostsTable.id, { onDelete: "cascade" }),
    fragrance: jsonb("fragrance").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("community_post_fragrances_post_position_idx").on(table.postId, table.position),
  ],
);

export type CommunityPostFragrance = typeof communityPostFragrancesTable.$inferSelect;
export type NewCommunityPostFragrance = typeof communityPostFragrancesTable.$inferInsert;
