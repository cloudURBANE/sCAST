import {
  date,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

// Denormalized hot-path stats for the "Crowd vs You" Beam Streak. One row per
// (tenant, user). Kept alongside arena_crowd_predictions.streak_after so the
// mode header/result can show current streak, best streak, and accuracy without
// scanning every prediction row. `last_played_on` (calendar date) drives the
// "skip a day breaks the streak" rule.
export const arenaCrowdStatsTable = pgTable(
  "arena_crowd_stats",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    currentStreak: integer("current_streak").notNull().default(0),
    bestStreak: integer("best_streak").notNull().default(0),
    totalReads: integer("total_reads").notNull().default(0),
    correctReads: integer("correct_reads").notNull().default(0),
    lastPlayedOn: date("last_played_on"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
);

export type ArenaCrowdStats = typeof arenaCrowdStatsTable.$inferSelect;
export type NewArenaCrowdStats = typeof arenaCrowdStatsTable.$inferInsert;
