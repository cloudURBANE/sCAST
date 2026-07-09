import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Bearer-token sessions (production-readiness S2, finishing C1). The plaintext
// credential is handed to the client exactly once at mint time (OAuth callback)
// and only its SHA-256 hash is ever at rest — a DB dump is no longer an
// account-takeover artifact. One row per login lets each device hold its own
// session (the legacy single `users.token` forced every login to share/rotate
// one credential); logout deletes ALL of a user's rows, preserving the
// sign-out-everywhere semantics of the old column rotation.
export const userTokensTable = pgTable(
  "user_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // SHA-256 hex of the bearer token (see lib/tokenAuth.ts hashToken — SHA-256,
    // not a slow KDF, is correct for a 122-bit random UUID). Unique: the hash IS
    // the lookup key on every authenticated request.
    tokenHash: text("token_hash").notNull(),
    // Token lifetime tracking (C2): absolute TTL from issued_at, idle TTL from
    // last_used_at. NOT NULL here (unlike the legacy users columns) — every
    // session row is stamped at mint, so the expiry policy covers the whole
    // population (closes readiness gap S9).
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (table) => [
    unique("user_tokens_token_hash_unique").on(table.tokenHash),
    // Logout and account deletion sweep by user.
    index("user_tokens_user_id_idx").on(table.userId),
  ],
);

export const userTokensRelations = relations(userTokensTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [userTokensTable.userId],
    references: [usersTable.id],
  }),
}));

export type UserTokenRow = typeof userTokensTable.$inferSelect;
