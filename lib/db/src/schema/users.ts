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
    // SHA-256 hash of `token` (production-readiness C1). Auth looks the user up
    // by this hash first so the live credential is never stored in plaintext;
    // the plaintext `token` column stays for one release as a dual-read fallback
    // and is backfilled + dropped by a later operator step. Nullable until the
    // backfill lands: rows minted before this column (or via the DB `token`
    // default) get their hash stamped on next login — see routes/oauth.ts
    // stampTokenSecurity.
    tokenHash: text("token_hash"),
    // Token lifetime tracking (production-readiness C2). NULL = unknown (legacy
    // row) and never expires on that axis until stamped on next login.
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

