import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userFragrancesTable = pgTable("user_fragrances", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  fragranceData: jsonb("fragrance_data").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UserFragrance = typeof userFragrancesTable.$inferSelect;
