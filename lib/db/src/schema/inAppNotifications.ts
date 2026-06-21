import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

/**
 * In-app notifications persisted in PostgreSQL.
 *
 * Each push notification dispatched via `sendCategoryPushToUser` writes a
 * mirror row here so the user's Notification Center shows a full history,
 * including items received on other devices or while offline.
 *
 * Additive and migration-lag tolerant by design: API routes that read this
 * table tolerate it not existing yet (Postgres 42P01) so a deploy never 500s
 * the notification endpoints before `drizzle-kit push` lands the table.
 *
 * Categories mirror PushCategory: "weather", "community", "curation", plus a
 * generic "system" default for non-push administrative notices.
 */
export const inAppNotificationsTable = pgTable(
  "in_app_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    url: text("url"),
    category: text("category").notNull().default("system"),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("in_app_notifications_tenant_user_idx").on(
      table.tenantId,
      table.userId,
    ),
  ],
);

export const inAppNotificationsRelations = relations(
  inAppNotificationsTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [inAppNotificationsTable.userId],
      references: [usersTable.id],
    }),
    tenant: one(tenantsTable, {
      fields: [inAppNotificationsTable.tenantId],
      references: [tenantsTable.id],
    }),
  }),
);

export type InAppNotificationRow =
  typeof inAppNotificationsTable.$inferSelect;
