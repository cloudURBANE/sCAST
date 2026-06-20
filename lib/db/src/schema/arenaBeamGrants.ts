import {
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

export const arenaBeamGrantsTable = pgTable(
  "arena_beam_grants",
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
    fragranceId: text("fragrance_id").notNull(),
    runId: text("run_id").notNull(),
    beamPower: integer("beam_power").notNull(),
    gameScore: integer("game_score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("arena_beam_grants_tenant_fragrance_idx").on(table.tenantId, table.fragranceId),
    index("arena_beam_grants_tenant_post_idx").on(table.tenantId, table.postId),
    index("arena_beam_grants_user_idx").on(table.userId),
    uniqueIndex("arena_beam_grants_user_post_run_unique_idx").on(
      table.userId,
      table.postId,
      table.runId,
    ),
  ],
);

export type ArenaBeamGrant = typeof arenaBeamGrantsTable.$inferSelect;
export type NewArenaBeamGrant = typeof arenaBeamGrantsTable.$inferInsert;
