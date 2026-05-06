import {
  boolean,
  index,
  integer,
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

    backgroundRemoved: boolean("background_removed").notNull().default(false),
    processingStatus: text("processing_status").notNull().default("ready"),
    failureReason: text("failure_reason"),

    hitCount: integer("hit_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourcePipelineUnique: uniqueIndex("image_cache_source_pipeline_unique_idx").on(
      table.sourceUrlHash,
      table.pipelineVersion,
    ),
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
