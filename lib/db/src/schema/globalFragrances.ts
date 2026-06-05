import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const globalFragrancesTable = pgTable(
  "global_fragrances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lookupKey: text("lookup_key").notNull().unique(),
    name: text("name").notNull(),
    brand: text("brand").notNull(),
    profileData: jsonb("profile_data").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("global_fragrances_search_trgm_idx").using(
      "gin",
      sql`lower(${table.brand} || ' ' || ${table.name}) gin_trgm_ops`,
    ),
    index("global_fragrances_lookup_key_trgm_idx").using(
      "gin",
      sql`lower(${table.lookupKey}) gin_trgm_ops`,
    ),
    index("global_fragrances_brand_trgm_idx").using(
      "gin",
      sql`lower(${table.brand}) gin_trgm_ops`,
    ),
  ],
);

export type GlobalFragrance = typeof globalFragrancesTable.$inferSelect;
