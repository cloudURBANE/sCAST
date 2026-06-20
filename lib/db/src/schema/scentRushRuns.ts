import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const scentRushRunsTable = pgTable(
  "scent_rush_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
    userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    fragranceId: text("fragrance_id").notNull(),
    level: integer("level").notNull(),
    seed: integer("seed").notNull(),
    manifestVersion: integer("manifest_version").notNull(),
    manifest: jsonb("manifest").notNull(),
    eventPlan: jsonb("event_plan").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    eventDigest: text("event_digest"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("scent_rush_runs_level_check", sql`${table.level} between 1 and 3`),
    index("scent_rush_runs_user_created_idx").on(table.tenantId, table.userId, table.createdAt),
    index("scent_rush_runs_expiry_idx").on(table.expiresAt),
  ],
);

export type ScentRushRun = typeof scentRushRunsTable.$inferSelect;
