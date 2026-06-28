import { relations, sql } from "drizzle-orm";
import { index, uniqueIndex, pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

export const userFragrancesTable = pgTable(
  "user_fragrances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    fragranceData: jsonb("fragrance_data").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Bumped on every write so GET /api/wardrobe can compute a cheap version key
    // (count + max(updated_at)) and answer the background poll with 304 instead
    // of re-pulling the full wardrobe. defaultNow() covers inserts; $onUpdate
    // makes Drizzle inject a fresh timestamp into every ORM .update().set() —
    // all writes to this table go through the ORM (no raw SQL UPDATE), so the
    // key is reliable. See routes/wardrobe.ts GET handler.
    updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index("user_fragrances_user_id_idx").on(table.userId),
    index("user_fragrances_tenant_user_idx").on(table.tenantId, table.userId),
    // Tenant-scoped, newest-first feed query (community.ts filters by tenant_id
    // and orders by created_at desc). The (tenant_id, user_id) index above can't
    // serve that ordering, so the feed otherwise falls back to a heap sort.
    index("user_fragrances_tenant_created_at_idx").on(
      table.tenantId,
      table.createdAt.desc(),
    ),
    // WS-5: one wardrobe row per (user, client fragrance id). The add route is
    // idempotent (re-adds merge instead of duplicating) and this index is the DB
    // backstop. Applied via migrations/0002 (dedup existing rows first); a blind
    // `drizzle-kit push` is guarded — see CLAUDE.md / db-schema-safety.
    uniqueIndex("user_fragrances_user_client_id_unique_idx").on(
      table.userId,
      sql`(${table.fragranceData}->>'id')`,
    ),
  ],
);

export const userFragrancesRelations = relations(userFragrancesTable, ({ one }) => ({
  tenant: one(tenantsTable, {
    fields: [userFragrancesTable.tenantId],
    references: [tenantsTable.id],
  }),
}));

export type UserFragrance = typeof userFragrancesTable.$inferSelect;

