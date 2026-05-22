import { relations, sql } from "drizzle-orm";
import { index, pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    email: text("email").notNull().unique(),
    token: uuid("token").notNull().defaultRandom(),
    oauthProvider: text("oauth_provider"),
    oauthSubject: text("oauth_subject"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
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

