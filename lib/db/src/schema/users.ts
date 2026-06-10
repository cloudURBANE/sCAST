import { relations, sql } from "drizzle-orm";
import { index, pgTable, unique, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable at the DB level so `drizzle-kit push` never fails on pre-tenant
    // rows; the app backfills it on startup (ensureTenantBaseline) and stamps it
    // on every write. Per-tenant unique below — NOT globally unique, so the same
    // person may hold a separate account on each tenant.
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    email: text("email").notNull(),
    token: uuid("token").notNull().defaultRandom(),
    oauthProvider: text("oauth_provider"),
    oauthSubject: text("oauth_subject"),
    pictureUrl: text("picture_url"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("users_tenant_email_unique").on(table.tenantId, table.email),
    index("users_share_handle_idx").on(
      sql`coalesce(nullif(regexp_replace(regexp_replace(lower(split_part(${table.email}, '@', 1)), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), ''), 'user')`,
    ),
  ],
);

export const usersRelations = relations(usersTable, ({ one }) => ({
  tenant: one(tenantsTable, {
    fields: [usersTable.tenantId],
    references: [tenantsTable.id],
  }),
}));

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, token: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

