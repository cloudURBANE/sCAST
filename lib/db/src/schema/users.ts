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
    // LEGACY (S2): sessions moved to user_tokens (hash-only, one row per login —
    // see userTokens.ts). Migration 0002 backfilled every row's session there and
    // SCRUBBED this column with fresh random UUIDs, so the stored value no longer
    // corresponds to any live credential. All four token columns below are dead
    // data kept only so a pre-S2 instance survives the rolling deploy (its
    // projections still select them); drop them in a follow-up contraction
    // migration once no deployed code references them.
    token: uuid("token").notNull().defaultRandom(),
    tokenHash: text("token_hash"),
    tokenIssuedAt: timestamp("token_issued_at"),
    tokenLastUsedAt: timestamp("token_last_used_at"),
    oauthProvider: text("oauth_provider"),
    oauthSubject: text("oauth_subject"),
    pictureUrl: text("picture_url"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("users_tenant_email_unique").on(table.tenantId, table.email),
    // Bearer-token auth looks the user up by token on EVERY authenticated
    // request (middlewares/auth.ts), so this column must be indexed.
    index("users_token_idx").on(table.token),
    // Auth now looks up by token_hash first (plaintext token is the fallback),
    // so the hash column carries the hot per-request lookup and must be indexed.
    index("users_token_hash_idx").on(table.tokenHash),
    // OAuth login resolves an existing account by (provider, subject).
    index("users_oauth_subject_idx").on(table.oauthProvider, table.oauthSubject),
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

