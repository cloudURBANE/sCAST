import { relations } from "drizzle-orm";
import { index, pgTable, uuid, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

export const userSettingsTable = pgTable(
  "user_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
    // Public display name the user chooses for the community feed. Nullable: when
    // unset the UI falls back to a non-identifying alias rather than leaking the
    // email. Per-tenant uniqueness is enforced at the application layer (the PUT
    // /me/profile handler) — a case-insensitive check, not a DB constraint, so
    // `drizzle-kit push` stays trivially additive and migration-lag tolerant.
    username: text("username"),
    shareHideImages: boolean("share_hide_images").notNull().default(false),
    // Durable onboarding progress. Lives here (not on `users`) so auth identity
    // (`users.id` / `users.token`) stays untouched while user-facing progress
    // sits with the rest of their preferences. Once true, the dashboard shows
    // the discover state and never re-shows the "add 3" flow — even if the
    // wardrobe is still hydrating, returns empty, or a poll is in flight.
    wardrobeOnboardingCompleted: boolean("wardrobe_onboarding_completed").notNull().default(false),
    wardrobeOnboardingCompletedAt: timestamp("wardrobe_onboarding_completed_at"),
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

