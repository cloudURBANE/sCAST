import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

/**
 * Beam Agent — durable per-turn answer log.
 *
 * One row per completed Beam answer turn. It exists so that (a) a user can
 * report a bad answer and the report points at a REAL, reproducible record, and
 * (b) each downvote can become a deterministic regression fixture (the full
 * input → candidates → answer is captured). See
 * docs/beam-agent/15-deep-audit-and-feedback-loop-2026-06-20.md §3.2 step 1.
 *
 * The primary key is the run id already minted by `beamAgentRoutes` (`run_<uuid>`),
 * so it is a TEXT pk, not a generated uuid. `beam_answer_feedback.answer_log_id`
 * references it.
 *
 * Retention is short by design (`expires_at`, ~30 days): this is a diagnostic
 * record, not a transcript store. Nothing secret is written — no tokens, no raw
 * tool arguments, no system prompt. `user_id` is the real FK (scoped, deletable);
 * the answer text and candidates are the same grounded data the user already saw.
 *
 * Additive table. The deploy pipeline does not run `drizzle push`, so writes
 * no-op (best-effort, caught) until `pnpm --filter @workspace/db run push` is run
 * once against the target DB. See the db-schema-safety skill.
 */
export const beamAnswerLogTable = pgTable(
  "beam_answer_log",
  {
    // = the run id minted in beamAgentRoutes (`run_<uuid>`). The `completed` SSE
    // event returns this as `answerLogId` so the client can tag the answer.
    id: text("id").primaryKey(),

    tenantId: uuid("tenant_id").references(() => tenantsTable.id),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    // Conversation/session id (`beam_<uuid>`); groups turns, not unique per turn.
    sessionId: text("session_id"),

    // The user's turn (trimmed, capped server-side) and the structured slots +
    // mission derived from it — enough to replay the input deterministically.
    userMessage: text("user_message").notNull(),
    derivedState: jsonb("derived_state"),

    // Cost-lane provenance (already in the run summary).
    lane: text("lane"),
    orchestrationModel: text("orchestration_model"),
    synthesisModel: text("synthesis_model"),

    // The fragrances the tools actually returned this run (names + brand +
    // owned), NOT just a count — this is what makes a downvote reproducible.
    groundedCandidates: jsonb("grounded_candidates").notNull().default([]),

    // The composed answer the user saw.
    finalAnswer: text("final_answer").notNull().default(""),

    // Deterministic gate verdict + the soft-flow override flag (audit A6).
    gatePassed: boolean("gate_passed").notNull().default(true),
    gateViolations: jsonb("gate_violations").notNull().default([]),
    shippedWithSoftViolations: boolean("shipped_with_soft_violations").notNull().default(false),

    // Coarse run outcome / failure code for triage.
    outcome: text("outcome"),
    failureCode: text("failure_code"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => ({
    userCreatedIdx: index("beam_answer_log_user_created_idx").on(table.userId, table.createdAt),
    createdAtIdx: index("beam_answer_log_created_at_idx").on(table.createdAt),
    expiresAtIdx: index("beam_answer_log_expires_at_idx").on(table.expiresAt),
  }),
);

export type BeamAnswerLog = typeof beamAnswerLogTable.$inferSelect;
export type NewBeamAnswerLog = typeof beamAnswerLogTable.$inferInsert;
