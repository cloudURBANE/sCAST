import { pgTable, uuid, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userSettingsTable = pgTable("user_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  shareHideImages: boolean("share_hide_images").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type UserSettings = typeof userSettingsTable.$inferSelect;
