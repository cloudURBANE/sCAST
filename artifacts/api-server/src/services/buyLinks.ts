import { db } from "@workspace/db";
import { affiliateLinksTable, userFragrancesTable } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  buildFragranceQuery,
  buyLinkResponse,
  classifyAffiliateLinkFreshness,
  DEFAULT_BUY_LINK_CACHE_TTL_MS,
  isShareHidden,
  parseBatchIds,
  partitionAffiliateLinksByFreshness,
  payloadFragranceId,
  resolveFallbackBuyLink,
  resolvePublicBuyLinkFromCachedLinks as resolvePublicBuyLinkFromCachedLinksCore,
} from "./buyLinksCore";
import type { AffiliateLinkObservation, BuyLinkEnv, BuyLinkResponse } from "./buyLinksCore";
import { createRakutenProvider, rakutenEnvReady } from "./rakutenProvider";

export type UserFragranceRow = typeof userFragrancesTable.$inferSelect;
export type AffiliateLinkRow = typeof affiliateLinksTable.$inferSelect;
export { buyLinkResponse, isShareHidden, parseBatchIds, payloadFragranceId } from "./buyLinksCore";
export type { BuyLinkResponse, BuyLinkStatus } from "./buyLinksCore";

type BuyLinkResolveOptions = {
  allowLiveRakuten: boolean;
};

function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function findFragranceRow(userId: string, id: string) {
  if (isUuidish(id)) {
    const byDbId = await db
      .select()
      .from(userFragrancesTable)
      .where(sql`${userFragrancesTable.id} = ${id} AND ${userFragrancesTable.userId} = ${userId}`)
      .limit(1);

    if (byDbId[0]) return byDbId[0];
  }

  const byPayloadId = await db
    .select()
    .from(userFragrancesTable)
    .where(sql`${userFragrancesTable.userId} = ${userId} AND ${userFragrancesTable.fragranceData}->>'id' = ${id}`)
    .limit(1);

  return byPayloadId[0] ?? null;
}

export async function findFragranceRowsForUser(userId: string): Promise<UserFragranceRow[]> {
  return db.select().from(userFragrancesTable).where(eq(userFragrancesTable.userId, userId));
}

function amazonAffiliateEnabled(): boolean {
  return process.env.AMAZON_AFFILIATE_ENABLED?.trim().toLowerCase() === "true";
}

function amazonAssociateTag(): string | undefined {
  return process.env.AMAZON_ASSOCIATE_TAG?.trim() || undefined;
}

function amazonMarketplace(): string | undefined {
  return process.env.AMAZON_MARKETPLACE?.trim() || undefined;
}

function currentBuyLinkEnv(): BuyLinkEnv {
  return {
    amazonAffiliateEnabled: amazonAffiliateEnabled(),
    amazonAssociateTag: amazonAssociateTag(),
    amazonMarketplace: amazonMarketplace(),
    rakutenEnvReady: rakutenEnvReady(),
  };
}

function buyLinkCacheTtlMs(): number {
  const raw = Number(process.env.BUY_LINK_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUY_LINK_CACHE_TTL_MS;
}

export type BuyLinkFreshnessStats = {
  /** Cached rows skipped because they aged past the TTL. */
  expired: number;
  /** Cached rows served but missing freshness timestamps (legacy/in-flight rows). */
  unknownAge: number;
  /** ISO timestamp of the most recent non-fresh observation, or null. */
  lastStaleAt: string | null;
};

const buyLinkFreshnessStats: BuyLinkFreshnessStats = {
  expired: 0,
  unknownAge: 0,
  lastStaleAt: null,
};

export function getBuyLinkFreshnessStats(): BuyLinkFreshnessStats {
  return { ...buyLinkFreshnessStats };
}

export function resetBuyLinkFreshnessStats(): void {
  buyLinkFreshnessStats.expired = 0;
  buyLinkFreshnessStats.unknownAge = 0;
  buyLinkFreshnessStats.lastStaleAt = null;
}

/**
 * Surface stale affiliate cache rows for monitoring. Expired rows are logged at
 * warn level (they were dropped from public responses and need re-verification);
 * undateable rows are logged at info level so operators can backfill timestamps.
 */
function recordAffiliateLinkObservations(
  observations: AffiliateLinkObservation<AffiliateLinkRow>[],
): void {
  if (observations.length === 0) return;

  const expired = observations.filter((obs) => obs.reason === "expired");
  const unknownAge = observations.filter((obs) => obs.reason === "unknown_age");

  buyLinkFreshnessStats.expired += expired.length;
  buyLinkFreshnessStats.unknownAge += unknownAge.length;
  buyLinkFreshnessStats.lastStaleAt = new Date().toISOString();

  if (expired.length > 0) {
    logger.warn(
      {
        event: "affiliate_link_stale",
        count: expired.length,
        links: expired.slice(0, 20).map((obs) => ({
          affiliateLinkId: obs.link.id,
          fragranceId: obs.link.fragranceId,
          provider: obs.link.provider,
          ageMs: obs.ageMs,
        })),
      },
      "expired affiliate buy-link cache rows skipped",
    );
  }

  if (unknownAge.length > 0) {
    logger.info(
      {
        event: "affiliate_link_unknown_age",
        count: unknownAge.length,
      },
      "affiliate buy-link cache rows missing freshness timestamps",
    );
  }
}

async function findCachedAffiliateLink(fragranceId: string, provider: string) {
  const rows = await db
    .select()
    .from(affiliateLinksTable)
    .where(sql`${affiliateLinksTable.fragranceId} = ${fragranceId} and ${affiliateLinksTable.provider} = ${provider} and ${affiliateLinksTable.status} = 'active'`)
    .limit(1);

  return rows[0] ?? null;
}

async function findCachedAffiliateLinkSafe(fragranceId: string, provider: string) {
  try {
    return await findCachedAffiliateLink(fragranceId, provider);
  } catch (err) {
    logger.warn({ err, fragranceId, provider }, "affiliate link cache lookup failed");
    return null;
  }
}

async function findCachedAffiliateLinksForFragranceIds(fragranceIds: string[]) {
  const linksByFragranceId = new Map<string, AffiliateLinkRow[]>();
  const uniqueIds = Array.from(new Set(fragranceIds.filter(Boolean)));
  if (uniqueIds.length === 0) return linksByFragranceId;

  try {
    const links = await db
      .select()
      .from(affiliateLinksTable)
      .where(
        and(
          inArray(affiliateLinksTable.fragranceId, uniqueIds),
          inArray(affiliateLinksTable.provider, ["rakuten", "cj"]),
          eq(affiliateLinksTable.status, "active"),
        ),
      );

    for (const link of links) {
      const current = linksByFragranceId.get(link.fragranceId) ?? [];
      current.push(link);
      linksByFragranceId.set(link.fragranceId, current);
    }
  } catch (err) {
    logger.warn({ err, count: uniqueIds.length }, "affiliate link batch cache lookup failed");
  }

  return linksByFragranceId;
}

export function resolvePublicBuyLinkFromCachedLinks(
  fragrance: UserFragranceRow,
  cachedLinks: AffiliateLinkRow[] = [],
): BuyLinkResponse {
  return resolvePublicBuyLinkFromCachedLinksCore(fragrance, cachedLinks, currentBuyLinkEnv());
}

export async function resolveBuyLinkForFragrance(
  fragrance: UserFragranceRow,
  options: BuyLinkResolveOptions,
): Promise<BuyLinkResponse> {
  let fallbackReason: string | undefined = options.allowLiveRakuten ? undefined : "BUY_LINK_NOT_CACHED";
  const ttlMs = buyLinkCacheTtlMs();

  const cachedRakuten = await findCachedAffiliateLinkSafe(fragrance.id, "rakuten");
  if (cachedRakuten) {
    const freshness = classifyAffiliateLinkFreshness(cachedRakuten, new Date(), ttlMs);
    if (freshness.fresh) {
      return buyLinkResponse("rakuten", "active", cachedRakuten.id);
    }
    recordAffiliateLinkObservations([
      { link: cachedRakuten, reason: freshness.reason, ageMs: freshness.ageMs },
    ]);
  }

  if (options.allowLiveRakuten && rakutenEnvReady()) {
    const query = buildFragranceQuery(fragrance);
    if (query) {
      const rakuten = createRakutenProvider();
      const result = await rakuten.resolveBuyLink({ query });

      if (result.status === "active") {
        const product = result.product;
        let created: typeof affiliateLinksTable.$inferSelect | undefined;
        try {
          [created] = await db
            .insert(affiliateLinksTable)
            .values({
              fragranceId: fragrance.id,
              provider: "rakuten",
              advertiserId: product.advertiserId,
              advertiserName: product.advertiserName,
              productTitle: product.title,
              productBrand: product.brand,
              destinationUrl: product.destinationUrl,
              affiliateUrl: product.affiliateUrl,
              imageUrl: product.imageUrl,
              price: product.salePrice ?? product.price,
              currency: product.currency,
              matchScore: product.matchScore,
              status: "active",
              fetchedAt: new Date(),
              lastVerifiedAt: new Date(),
            })
            .returning();
        } catch (err) {
          logger.warn({ err, fragranceId: fragrance.id }, "[rakuten] active buy-link cache insert failed");
        }

        if (created) {
          return buyLinkResponse("rakuten", "active", created.id);
        }

        return buyLinkResponse("rakuten", "active", undefined, "AFFILIATE_LINK_CACHE_BYPASSED", {
          network: "rakuten",
          buyUrl: product.affiliateUrl,
          affiliateApplied: true,
        });
      }

      logger.info({ fragranceId: fragrance.id, reason: result.reason }, "[rakuten] buy-link unavailable");
      fallbackReason = result.reason;
    }
  }

  const cachedCj = await findCachedAffiliateLinkSafe(fragrance.id, "cj");
  if (cachedCj) {
    const { servable, observations } = partitionAffiliateLinksByFreshness([cachedCj], new Date(), ttlMs);
    recordAffiliateLinkObservations(observations);
    if (servable.length > 0) {
      return resolvePublicBuyLinkFromCachedLinksCore(fragrance, servable, currentBuyLinkEnv());
    }
  }

  return resolveFallbackBuyLink(fragrance, fallbackReason, currentBuyLinkEnv());
}

export async function resolvePublicBuyLinksForRows(
  rows: UserFragranceRow[],
  requestedIds?: string[],
): Promise<Record<string, BuyLinkResponse>> {
  const visibleRows = rows.filter((row) => !isShareHidden(row));
  const rowsByPublicId = new Map<string, UserFragranceRow>();

  for (const row of visibleRows) {
    rowsByPublicId.set(row.id, row);
    const payloadId = payloadFragranceId(row);
    if (payloadId) rowsByPublicId.set(payloadId, row);
  }

  const outputIds = requestedIds?.length ? requestedIds : visibleRows.map((row) => row.id);
  const rowsNeedingLinks = Array.from(
    new Map(
      outputIds
        .map((id) => rowsByPublicId.get(id))
        .filter((row): row is UserFragranceRow => Boolean(row))
        .map((row) => [row.id, row] as const),
    ).values(),
  );
  const cachedLinksByFragranceId = await findCachedAffiliateLinksForFragranceIds(
    rowsNeedingLinks.map((row) => row.id),
  );

  const now = new Date();
  const ttlMs = buyLinkCacheTtlMs();
  const servableByFragranceId = new Map<string, AffiliateLinkRow[]>();
  const observations: AffiliateLinkObservation<AffiliateLinkRow>[] = [];
  for (const [fragranceId, links] of cachedLinksByFragranceId) {
    const partition = partitionAffiliateLinksByFreshness(links, now, ttlMs);
    servableByFragranceId.set(fragranceId, partition.servable);
    observations.push(...partition.observations);
  }
  recordAffiliateLinkObservations(observations);

  return Object.fromEntries(
    outputIds.map((id) => {
      const fragrance = rowsByPublicId.get(id);
      if (!fragrance) {
        return [id, buyLinkResponse("rakuten", "unavailable", undefined, "FRAGRANCE_NOT_FOUND")] as const;
      }

      return [
        id,
        resolvePublicBuyLinkFromCachedLinks(fragrance, servableByFragranceId.get(fragrance.id) ?? []),
      ] as const;
    }),
  );
}
