import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const globalFragrancesTable = pgTable("global_fragrances", {
  id: uuid("id").primaryKey().defaultRandom(),
  lookupKey: text("lookup_key").notNull().unique(),
  name: text("name").notNull(),
  brand: text("brand").notNull(),
  profileData: jsonb("profile_data").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type GlobalFragrance = typeof globalFragrancesTable.$inferSelect;
