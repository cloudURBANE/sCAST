import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const apiUsageLedgerTable = pgTable(
  "api_usage_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),

    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    model: text("model").notNull(),

    size: text("size"),
    quality: text("quality"),
    imageCount: integer("image_count").notNull().default(1),

    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),

    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),

    status: text("status").notNull(),
    failureReason: text("failure_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index("api_usage_ledger_created_at_idx").on(table.createdAt),
    providerOperationIdx: index("api_usage_ledger_provider_operation_idx").on(
      table.provider,
      table.operation,
    ),
    userIdIdx: index("api_usage_ledger_user_id_idx").on(table.userId),
  }),
);

export type ApiUsageLedger = typeof apiUsageLedgerTable.$inferSelect;
export type NewApiUsageLedger = typeof apiUsageLedgerTable.$inferInsert;
