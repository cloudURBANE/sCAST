import { relations } from "drizzle-orm";
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { userFragrancesTable } from "./userFragrances";
import { userSettingsTable } from "./userSettings";
import { apiUsageLedgerTable } from "./apiUsageLedger";

export const tenantsTable = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const tenantsRelations = relations(tenantsTable, ({ many }) => ({
  users: many(usersTable),
  userFragrances: many(userFragrancesTable),
  userSettings: many(userSettingsTable),
  apiUsageLedgers: many(apiUsageLedgerTable),
}));

export type Tenant = typeof tenantsTable.$inferSelect;
export type InsertTenant = typeof tenantsTable.$inferInsert;
