import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * AI-rewritten review comment cache.
 *
 * Scraped reviews from the external fragrance engine are distilled by an LLM
 * into a small set of short, original, website-appropriate comments. Generation
 * costs an API call per fragrance, so the result is persisted here and reused
 * for every later view of the same fragrance.
 *
 * Kept as a dedicated table (not a column on `global_fragrances`) because most
 * viewed fragrances never get a catalog row — writing review-only rows into
 * `global_fragrances` would pollute catalog search.
 *
 * `sourceHash` is a hash of the raw review text the comments were derived from;
 * when the upstream reviews change materially the hash differs and the cache
 * entry is regenerated instead of served stale.
 */
export const fragranceReviewSummariesTable = pgTable("fragrance_review_summaries", {
  // Canonical `brand::name` lower-cased key — same convention as makeLookupKey().
  lookupKey: text("lookup_key").primaryKey(),
  // Array of short rewritten comment strings.
  comments: jsonb("comments").notNull(),
  // Hash of the raw source reviews these comments were generated from.
  sourceHash: text("source_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FragranceReviewSummary = typeof fragranceReviewSummariesTable.$inferSelect;
export type NewFragranceReviewSummary = typeof fragranceReviewSummariesTable.$inferInsert;
