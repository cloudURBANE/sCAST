import { sql } from "drizzle-orm";
import { index, pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userFragrancesTable = pgTable(
  "user_fragrances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    fragranceData: jsonb("fragrance_data").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("user_fragrances_user_id_idx").on(table.userId),
    index("user_fragrances_user_client_id_idx").on(
      table.userId,
      sql`(${table.fragranceData}->>'id')`,
    ),
  ],
);

export type UserFragrance = typeof userFragrancesTable.$inferSelect;
