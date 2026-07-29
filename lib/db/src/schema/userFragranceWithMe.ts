import { relations } from "drizzle-orm";
import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { userFragrancesTable } from "./userFragrances";
import { usersTable } from "./users";

/**
 * The user's durable "With Me" subset.
 *
 * Membership references the canonical owned row, so a fragrance can never be
 * available without being owned and deleting it from the vault cascades the
 * membership automatically. Tenant/user columns keep every read defensively
 * scoped at the same boundary as user_fragrances.
 */
export const userFragranceWithMeTable = pgTable(
  "user_fragrance_with_me",
  {
    userFragranceId: uuid("user_fragrance_id")
      .primaryKey()
      .references(() => userFragrancesTable.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("user_fragrance_with_me_tenant_user_idx").on(table.tenantId, table.userId)],
);

export const userFragranceWithMeRelations = relations(userFragranceWithMeTable, ({ one }) => ({
  fragrance: one(userFragrancesTable, {
    fields: [userFragranceWithMeTable.userFragranceId],
    references: [userFragrancesTable.id],
  }),
  tenant: one(tenantsTable, {
    fields: [userFragranceWithMeTable.tenantId],
    references: [tenantsTable.id],
  }),
  user: one(usersTable, {
    fields: [userFragranceWithMeTable.userId],
    references: [usersTable.id],
  }),
}));

export type UserFragranceWithMe = typeof userFragranceWithMeTable.$inferSelect;
