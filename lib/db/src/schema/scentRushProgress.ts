import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, real, timestamp, uniqueIndex, uuid, text } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const scentRushProgressTable = pgTable(
  "scent_rush_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
    userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    fragranceId: text("fragrance_id").notNull(),
    level: integer("level").notNull(),
    bestScore: integer("best_score").notNull().default(0),
    bestPerformance: real("best_performance").notNull().default(0),
    beamPower: integer("beam_power").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("scent_rush_progress_level_check", sql`${table.level} between 1 and 3`),
    check("scent_rush_progress_best_score_check", sql`${table.bestScore} >= 0`),
    check("scent_rush_progress_best_performance_check", sql`${table.bestPerformance} between 0 and 1`),
    check("scent_rush_progress_beam_power_check", sql`${table.beamPower} between 0 and 5`),
    uniqueIndex("scent_rush_progress_user_fragrance_level_unique_idx").on(
      table.tenantId,
      table.userId,
      table.fragranceId,
      table.level,
    ),
    index("scent_rush_progress_fragrance_idx").on(table.tenantId, table.fragranceId),
  ],
);

export type ScentRushProgress = typeof scentRushProgressTable.$inferSelect;
