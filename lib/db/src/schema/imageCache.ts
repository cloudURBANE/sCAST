import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const imageCacheTable = pgTable(
  "image_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    fragranceId: text("fragrance_id"),
    lookupKey: text("lookup_key"),

    sourceProvider: text("source_provider").notNull().default("serper"),
    sourceUrl: text("source_url").notNull(),
    sourceUrlHash: text("source_url_hash").notNull(),
    searchQueryHash: text("search_query_hash"),
    pipelineVersion: text("pipeline_version").notNull(),

    contentHash: text("content_hash"),
    perceptualHash: text("perceptual_hash"),
    storageProvider: text("storage_provider").notNull(),
    storagePath: text("storage_path").notNull(),
    publicUrl: text("public_url"),

    mimeType: text("mime_type"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: integer("size_bytes"),

    // Orientation Engine metadata (services/orientationEngine.ts). All nullable:
    // legacy rows predate normalization, and the non-normalized passthrough path
    // leaves them null. `boundingBox` stores the detected bottle box normalized
    // to the original image as { x, y, width, height } in [0,1].
    originalWidth: integer("original_width"),
    originalHeight: integer("original_height"),
    boundingBox: jsonb("bounding_box"),
    aspectRatio: doublePrecision("aspect_ratio"),
    orientationVersion: text("orientation_version"),
    baselineAlignment: doublePrecision("baseline_alignment"),

    backgroundRemoved: boolean("background_removed").notNull().default(false),
    removeBgStatus: text("remove_bg_status"),
    removeBgReason: text("remove_bg_reason"),
    processingStatus: text("processing_status").notNull().default("ready"),
    failureReason: text("failure_reason"),

    hitCount: integer("hit_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Cache identity includes the background-removal variant so a bg-removed
    // (transparent) result and a no-bg (white-background) result for the SAME
    // source URL + pipeline version live in SEPARATE rows. Without the
    // `background_removed` dimension the two variants shared one row and could
    // clobber each other on upsert (a bg-removed reprocess overwriting the no-bg
    // row, or vice versa), and a negative-cache "failed" row for one variant
    // suppressed retries for the other.
    //
    // Provider-split uniqueness (image-pipeline H1/H3 — source-hash cache
    // poisoning): a Serper search for two DIFFERENT fragrances can return the
    // SAME image URL, which hashes to the same `source_url_hash`. Under a single
    // (source_url_hash, pipeline_version, background_removed) key those two
    // fragrances collapse to ONE row, so they cross-serve each other's bottle and
    // each upsert rebinds the row's `lookup_key` (last writer wins). To keep each
    // fragrance's Serper-sourced row isolated, SERPER rows add `lookup_key` to the
    // key. MANUAL / reimagine / openai rows keep PURE-BYTES dedup (no lookup_key)
    // because a manually supplied or generated source URL is fragrance-specific by
    // construction and SHOULD coalesce across callers. Two partial indexes (split
    // on source_provider) so each upsert targets the right one via targetWhere.
    sourcePipelineBgSerperUnique: uniqueIndex("image_cache_source_pipeline_bg_serper_unique_idx")
      .on(table.sourceUrlHash, table.pipelineVersion, table.backgroundRemoved, table.lookupKey)
      .where(sql`${table.sourceProvider} = 'serper'`),
    sourcePipelineBgNonSerperUnique: uniqueIndex("image_cache_source_pipeline_bg_nonserper_unique_idx")
      .on(table.sourceUrlHash, table.pipelineVersion, table.backgroundRemoved)
      .where(sql`${table.sourceProvider} <> 'serper'`),
    lookupKeyIdx: index("image_cache_lookup_key_idx").on(table.lookupKey),
    userIdIdx: index("image_cache_user_id_idx").on(table.userId),
    sourceUrlHashIdx: index("image_cache_source_url_hash_idx").on(table.sourceUrlHash),
    contentHashIdx: index("image_cache_content_hash_idx").on(table.contentHash),
    searchQueryHashIdx: index("image_cache_search_query_hash_idx").on(table.searchQueryHash),
    statusIdx: index("image_cache_processing_status_idx").on(table.processingStatus),
  }),
);

export type ImageCache = typeof imageCacheTable.$inferSelect;
export type NewImageCache = typeof imageCacheTable.$inferInsert;
