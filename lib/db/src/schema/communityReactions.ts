import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const communityReactionTargetTypeEnum = pgEnum("community_reaction_target_type", [
  "post",
  "comment",
]);

export const communityReactionsTable = pgTable(
  "community_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    targetType: communityReactionTargetTypeEnum("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    reaction: text("reaction").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("community_reactions_user_target_reaction_unique_idx").on(
      table.userId,
      table.targetType,
      table.targetId,
      table.reaction,
    ),
    index("community_reactions_target_idx").on(table.tenantId, table.targetType, table.targetId),
  ],
);

export type CommunityReaction = typeof communityReactionsTable.$inferSelect;
export type NewCommunityReaction = typeof communityReactionsTable.$inferInsert;
export type CommunityReactionTargetType = (typeof communityReactionTargetTypeEnum.enumValues)[number];
