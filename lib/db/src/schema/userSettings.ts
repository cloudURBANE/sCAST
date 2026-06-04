import { relations } from "drizzle-orm";
import { index, pgTable, uuid, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

export const userSettingsTable = pgTable(
  "user_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
    shareHideImages: boolean("share_hide_images").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("user_settings_tenant_user_idx").on(table.tenantId, table.userId)],
);

export const userSettingsRelations = relations(userSettingsTable, ({ one }) => ({
  tenant: one(tenantsTable, {
    fields: [userSettingsTable.tenantId],
    references: [tenantsTable.id],
  }),
}));

export type UserSettings = typeof userSettingsTable.$inferSelect;

