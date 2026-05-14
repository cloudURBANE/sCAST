import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Durable enrichment request queue.
 *
 * Pass 1 scope: this table is the persistence foundation only. There is no
 * worker, no claim/complete/fail endpoints, and no production endpoint
 * automatically enqueues into it yet — the repo does not currently expose a
 * stable "source coverage / incomplete result" contract to trigger on. A later
 * pass wires `enqueueEnrichmentJob(...)` once that signal exists.
 */
export const enrichmentJobsTable = pgTable(
  "enrichment_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Canonical idempotency key. One row per job_key — repeated requests for the
    // same fragrance upsert this row instead of creating duplicates.
    jobKey: text("job_key").notNull(),
    jobType: text("job_type").notNull().default("detail_only"),

    // Identity inputs captured at request time.
    query: text("query"),
    normalizedQuery: text("normalized_query"),
    name: text("name"),
    house: text("house"),
    year: integer("year"),
    bnUrl: text("bn_url"),
    fgUrl: text("fg_url"),
    sourceId: text("source_id"),

    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    requestedCount: integer("requested_count").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastRequestedAt: timestamp("last_requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Worker lifecycle columns — present so Pass 2 needs no migration, unused in Pass 1.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    ignoredAt: timestamp("ignored_at", { withTimezone: true }),
    lastError: text("last_error"),

    metadataJson: jsonb("metadata_json"),
  },
  (table) => ({
    jobKeyUnique: uniqueIndex("enrichment_jobs_job_key_unique_idx").on(table.jobKey),
    statusIdx: index("enrichment_jobs_status_idx").on(table.status),
    fgUrlIdx: index("enrichment_jobs_fg_url_idx").on(table.fgUrl),
    statusPriorityIdx: index("enrichment_jobs_status_priority_idx").on(
      table.status,
      table.priority,
    ),
  }),
);

export type EnrichmentJob = typeof enrichmentJobsTable.$inferSelect;
export type NewEnrichmentJob = typeof enrichmentJobsTable.$inferInsert;
