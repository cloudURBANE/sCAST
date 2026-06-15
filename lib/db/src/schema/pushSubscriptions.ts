import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

/**
 * Web Push subscriptions, one row per browser/device a user has opted in from.
 *
 * Additive and migration-lag tolerant by design: routes that read this table
 * (routes/push.ts) tolerate it not existing yet (Postgres 42P01) so a deploy
 * never 500s the push endpoints before `drizzle-kit push` lands the table.
 *
 * `endpoint` is the push-service URL from `PushSubscription.toJSON()` and is
 * globally unique per subscription — uniqueness lets re-subscribes upsert
 * instead of duplicating, and lets the sender prune `endpoint`s the push
 * service reports as gone (404/410).
 */
export const pushSubscriptionsTable = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    // Encryption material from PushSubscription.toJSON().keys.
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("push_subscriptions_tenant_user_idx").on(table.tenantId, table.userId)],
);

export const pushSubscriptionsRelations = relations(pushSubscriptionsTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [pushSubscriptionsTable.userId],
    references: [usersTable.id],
  }),
  tenant: one(tenantsTable, {
    fields: [pushSubscriptionsTable.tenantId],
    references: [tenantsTable.id],
  }),
}));

export type PushSubscriptionRow = typeof pushSubscriptionsTable.$inferSelect;
