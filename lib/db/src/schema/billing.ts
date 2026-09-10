import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

export const billingAccountsTable = pgTable(
  "billing_accounts",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id),
    customerId: text("customer_id"),
    subscriptionId: text("subscription_id"),
    status: text("status").notNull().default("none"),
    accessUntil: timestamp("access_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("billing_customer_unique").on(t.customerId)],
);

export const billingEventsTable = pgTable("billing_events", {
  eventId: text("event_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Global scope is shared across tenants; user scope includes tenant and user IDs.
// Integer microdollars avoid floating-point budget comparisons.
export const launchUsageTable = pgTable(
  "launch_usage",
  {
    month: text("month").notNull(),
    scope: text("scope").notNull(),
    feature: text("feature").notNull(),
    calls: integer("calls").notNull().default(0),
    reservedMicrousd: integer("reserved_microusd").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.month, t.scope, t.feature] })],
);
