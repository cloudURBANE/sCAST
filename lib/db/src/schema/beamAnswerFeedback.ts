import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { beamAnswerLogTable } from "./beamAnswerLog";

/**
 * Beam Agent — user feedback on a delivered answer.
 *
 * One row per user verdict ("this answer was bad") tied to the durable
 * `beam_answer_log` row it concerns. A downvote + reason code, joined back to the
 * full input/candidate/answer record, is the raw material for a regression test
 * (audit §3.2 steps 3-5). Today only the downvote path has a UI; the schema
 * allows `up` too so a future thumbs-up reuses it without a migration.
 *
 * `answer_log_id` references `beam_answer_log.id` (the run id). The reference is
 * declared but the route validates existence itself and fails with a clear error
 * for an unknown id — feedback never attaches to nothing.
 *
 * Additive table; same `drizzle push` caveat as `beam_answer_log`.
 */
export const beamAnswerFeedbackTable = pgTable(
  "beam_answer_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The answer this verdict concerns. References the run-id PK of the log.
    answerLogId: text("answer_log_id")
      .notNull()
      .references(() => beamAnswerLogTable.id, { onDelete: "cascade" }),

    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),

    // "down" (the shipped UI) or "up" (reserved). Validated server-side.
    rating: text("rating").notNull().default("down"),
    // A single specific reason code from a fixed vocabulary (see the route).
    reasonCode: text("reason_code"),
    // Optional free-text detail, capped server-side. No PII expectations.
    detail: text("detail"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    answerLogIdx: index("beam_answer_feedback_answer_log_idx").on(table.answerLogId),
    createdAtIdx: index("beam_answer_feedback_created_at_idx").on(table.createdAt),
    userIdx: index("beam_answer_feedback_user_idx").on(table.userId),
  }),
);

export type BeamAnswerFeedback = typeof beamAnswerFeedbackTable.$inferSelect;
export type NewBeamAnswerFeedback = typeof beamAnswerFeedbackTable.$inferInsert;
