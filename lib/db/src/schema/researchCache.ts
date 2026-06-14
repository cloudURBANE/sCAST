import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Beam Agent — live research cache.
 *
 * Persisted results of the Beam research lane (freshness-gated OpenRouter web
 * search). Cheap live search is run once per normalized query and reused until
 * it expires, so one user's research improves answers for everyone and the
 * OpenRouter spend stays bounded.
 *
 * GLOBAL ON PURPOSE: rows are public web facts (prices, availability, notes),
 * not per-user data, so there is no `tenant_id`/`user_id` here — the cache is
 * shared across tenants. Nothing user-private is ever written to this table.
 *
 * Additive table. The deploy pipeline does not run `drizzle push`, so this 500s
 * until `pnpm --filter @workspace/db run push` is run once against the target DB.
 * See docs/beam-agent/08-live-research-lane.md and the db-schema-safety skill.
 */
export const beamResearchCacheTable = pgTable(
  "beam_research_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Idempotency key: lower-cased, collapsed-whitespace query + entity type.
    // One row per (normalized_query, entity_type) — re-running upserts it.
    normalizedQuery: text("normalized_query").notNull(),
    entityType: text("entity_type").notNull().default("general"),

    // Which lane produced this (single_source_check | standard_research | …).
    mode: text("mode").notNull(),

    // The short synthesized fact the agent consumes, plus the evidence behind it.
    synthesizedFact: text("synthesized_fact").notNull(),
    // [{ url, title, excerpt, sourceType, retrievedAt }]
    sources: jsonb("sources").notNull().default([]),
    confidence: real("confidence"),

    // Provenance + cost telemetry (matches api_usage_ledger granularity).
    model: text("model"),
    engine: text("engine"),
    costUsd: real("cost_usd").notNull().default(0),

    hitCount: integer("hit_count").notNull().default(0),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    // TTL is entity-type dependent (price ~hours, notes ~weeks) — set on write.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    queryEntityUnique: uniqueIndex("beam_research_cache_query_entity_unique_idx").on(
      table.normalizedQuery,
      table.entityType,
    ),
    expiresAtIdx: index("beam_research_cache_expires_at_idx").on(table.expiresAt),
    entityTypeIdx: index("beam_research_cache_entity_type_idx").on(table.entityType),
  }),
);

export type BeamResearchCache = typeof beamResearchCacheTable.$inferSelect;
export type NewBeamResearchCache = typeof beamResearchCacheTable.$inferInsert;
