import { relations } from "drizzle-orm";
import { index, pgTable, uuid, boolean, integer, text, timestamp, doublePrecision } from "drizzle-orm/pg-core";
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
    // User-approved weather location. Coordinates are captured only after an
    // explicit browser geolocation request and are used to avoid IP fallback
    // jumps between sessions/devices.
    weatherLatitude: doublePrecision("weather_latitude"),
    weatherLongitude: doublePrecision("weather_longitude"),
    weatherLocationLabel: text("weather_location_label"),
    weatherLocationUpdatedAt: timestamp("weather_location_updated_at"),
    // Durable onboarding progress. Lives here (not on `users`) so auth identity
    // (`users.id` / `users.token`) stays untouched while user-facing progress
    // sits with the rest of their preferences. Once true, the dashboard shows
    // the discover state and never re-shows the "add 3" flow — even if the
    // wardrobe is still hydrating, returns empty, or a poll is in flight.
    wardrobeOnboardingCompleted: boolean("wardrobe_onboarding_completed").notNull().default(false),
    wardrobeOnboardingCompletedAt: timestamp("wardrobe_onboarding_completed_at"),
    // Per-category Web Push opt-ins. Both default true so an existing subscriber
    // keeps getting what they already agreed to; the per-category send path
    // (pushService.sendCategoryPushToUser) reads these before dispatching.
    notifyWeather: boolean("notify_weather").notNull().default(true),
    notifyCommunity: boolean("notify_community").notNull().default(true),
    // Beam curation: fired when an agent-recommended fragrance that wasn't in our
    // catalog finishes enriching, so the user can add it on return. Defaults true
    // like the others. NOTE: this column is additive — a deploy does NOT run
    // `drizzle-kit push` automatically, so until `pnpm --filter @workspace/db run
    // push` is applied this column won't exist in the live DB; the push-preference
    // reads in pushService.ts catch 42703 and degrade to "on" so sends still work.
    notifyCuration: boolean("notify_curation").notNull().default(true),
    // Server-authoritative app-icon badge count. The App Badge API exposes ONE
    // number per installed icon, so it lives per-user (not per-subscription):
    // each eligible push increments it, opening the app clears it to 0. Source of
    // truth here keeps multiple devices in sync — the next push to any device
    // carries the updated number.
    notificationBadgeCount: integer("notification_badge_count").notNull().default(0),
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

