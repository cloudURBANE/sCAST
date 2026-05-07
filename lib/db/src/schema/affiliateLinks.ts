import { index, integer, numeric, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userFragrancesTable } from "./userFragrances";

export const affiliateLinksTable = pgTable(
  "affiliate_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fragranceId: uuid("fragrance_id").notNull().references(() => userFragrancesTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("cj"),
    advertiserId: text("advertiser_id"),
    advertiserName: text("advertiser_name"),
    productTitle: text("product_title"),
    productBrand: text("product_brand"),
    destinationUrl: text("destination_url"),
    affiliateUrl: text("affiliate_url").notNull(),
    imageUrl: text("image_url"),
    price: numeric("price"),
    currency: text("currency"),
    matchScore: real("match_score"),
    status: text("status").notNull().default("active"),
    fetchedAt: timestamp("fetched_at"),
    lastVerifiedAt: timestamp("last_verified_at"),
    clickCount: integer("click_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("affiliate_links_fragrance_provider_idx").on(table.fragranceId, table.provider),
    index("affiliate_links_status_idx").on(table.status),
  ],
);

export type AffiliateLink = typeof affiliateLinksTable.$inferSelect;
