import {
  buildAmazonAffiliateUrl,
  buildAmazonSearchUrl,
  isAmazonProductUrl,
} from "../server/affiliate/providers/amazon/amazonAffiliateUrl.ts";
import { resolveFragranceIdentity } from "./fragranceNameResolver.ts";

export type BuyLinkStatus = "active" | "unavailable";
export type BuyLinkResponse = {
  provider: string;
  network?: string;
  buyUrl: string | null;
  status: BuyLinkStatus;
  affiliateApplied?: boolean;
  affiliateUnavailableReason?: string;
  reason?: string;
};

export type PublicFragranceLike = {
  id: string;
  fragranceData: unknown;
};

export type CachedAffiliateLinkLike = {
  id: string;
  provider: string;
  status: string;
  fetchedAt?: Date | string | null;
  lastVerifiedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

/**
 * Default time-to-live for a cached affiliate buy-link row before it is treated
 * as stale on public pages. Affiliate destination/landing URLs rot (advertiser
 * drops, deep links expire), so a cached row that has not been re-verified within
 * this window is no longer served as "active" and falls through to the fallback
 * search link instead.
 */
export const DEFAULT_BUY_LINK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AffiliateLinkFreshnessReason = "fresh" | "expired" | "unknown_age";

export type AffiliateLinkFreshness = {
  /** Whether the link may still be served to public visitors. */
  fresh: boolean;
  reason: AffiliateLinkFreshnessReason;
  /** Age in ms relative to the reference timestamp, or null when undateable. */
  ageMs: number | null;
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Most-recent timestamp that proves the row is still good: an explicit
 * verification beats the original fetch, which beats the row's creation time.
 */
export function affiliateLinkReferenceDate(link: CachedAffiliateLinkLike): Date | null {
  return toDate(link.lastVerifiedAt) ?? toDate(link.fetchedAt) ?? toDate(link.createdAt);
}

export function classifyAffiliateLinkFreshness(
  link: CachedAffiliateLinkLike,
  now: Date = new Date(),
  ttlMs: number = DEFAULT_BUY_LINK_CACHE_TTL_MS,
): AffiliateLinkFreshness {
  const reference = affiliateLinkReferenceDate(link);
  if (!reference) {
    // No timestamp on the row (e.g. legacy rows predating the freshness columns).
    // Keep it servable so we do not silently drop working links, but surface it
    // so monitoring can find rows whose age we cannot prove.
    return { fresh: true, reason: "unknown_age", ageMs: null };
  }
  const ageMs = now.getTime() - reference.getTime();
  if (Number.isFinite(ttlMs) && ttlMs > 0 && ageMs > ttlMs) {
    return { fresh: false, reason: "expired", ageMs };
  }
  return { fresh: true, reason: "fresh", ageMs };
}

export type AffiliateLinkObservation<T extends CachedAffiliateLinkLike> = {
  link: T;
  reason: AffiliateLinkFreshnessReason;
  ageMs: number | null;
};

export type PartitionedAffiliateLinks<T extends CachedAffiliateLinkLike> = {
  /** Links that may still be served (fresh or undateable). */
  servable: T[];
  /** Non-fresh links (expired or undateable) collected for monitoring. */
  observations: AffiliateLinkObservation<T>[];
};

export function partitionAffiliateLinksByFreshness<T extends CachedAffiliateLinkLike>(
  links: T[],
  now: Date = new Date(),
  ttlMs: number = DEFAULT_BUY_LINK_CACHE_TTL_MS,
): PartitionedAffiliateLinks<T> {
  const servable: T[] = [];
  const observations: AffiliateLinkObservation<T>[] = [];
  for (const link of links) {
    const freshness = classifyAffiliateLinkFreshness(link, now, ttlMs);
    if (freshness.fresh) servable.push(link);
    if (freshness.reason !== "fresh") {
      observations.push({ link, reason: freshness.reason, ageMs: freshness.ageMs });
    }
  }
  return { servable, observations };
}

export type BuyLinkEnv = {
  amazonAffiliateEnabled?: boolean;
  amazonAssociateTag?: string;
  amazonMarketplace?: string;
  rakutenEnvReady?: boolean;
};

type BuyLinkResponseOptions = {
  buyUrl?: string | null;
  affiliateApplied?: boolean;
  affiliateUnavailableReason?: string;
  network?: string;
};

export function buyLinkResponse(
  provider: string,
  status: BuyLinkStatus,
  affiliateLinkId?: string,
  reason?: string,
  options: BuyLinkResponseOptions = {},
): BuyLinkResponse {
  return {
    provider,
    ...(options.network ? { network: options.network } : {}),
    buyUrl: options.buyUrl ?? (status === "active" && affiliateLinkId ? `/go/affiliate/${affiliateLinkId}` : null),
    status,
    ...(typeof options.affiliateApplied === "boolean" ? { affiliateApplied: options.affiliateApplied } : {}),
    ...(options.affiliateUnavailableReason
      ? { affiliateUnavailableReason: options.affiliateUnavailableReason }
      : {}),
    ...(reason ? { reason } : {}),
  };
}

export function isShareHidden(fragrance: PublicFragranceLike): boolean {
  const data = fragrance.fragranceData;
  return Boolean(data && typeof data === "object" && (data as Record<string, unknown>).shareHidden);
}

export function parseBatchIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 96) break;
  }
  return ids;
}

export function payloadFragranceId(fragrance: PublicFragranceLike): string | null {
  const data = fragrance.fragranceData;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildFragranceQuery(fragrance: PublicFragranceLike): string {
  const data =
    fragrance.fragranceData && typeof fragrance.fragranceData === "object" && !Array.isArray(fragrance.fragranceData)
      ? fragrance.fragranceData as Record<string, unknown>
      : {};
  const product = data.product && typeof data.product === "object" && !Array.isArray(data.product)
    ? data.product as Record<string, unknown>
    : {};
  const brand = cleanText(data.brand) || cleanText(data.house) || cleanText(product.brand);
  const name = cleanText(data.name) || cleanText(product.name);
  const identity = brand && name ? resolveFragranceIdentity(brand, name) : null;
  return [identity?.brand || brand, identity?.name || name].filter(Boolean).join(" ").trim();
}

function findAmazonProductUrl(value: unknown): string | null {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();

  while (stack.length > 0 && seen.size < 200) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (typeof current === "string") {
      const trimmed = current.trim();
      if (trimmed && isAmazonProductUrl(trimmed)) return trimmed;
      continue;
    }

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (typeof current === "object") {
      stack.push(...Object.values(current as Record<string, unknown>));
    }
  }

  return null;
}

function cachedProviderLink<T extends CachedAffiliateLinkLike>(cachedLinks: T[], provider: string): T | null {
  return cachedLinks.find((link) => link.provider === provider && link.status === "active") ?? null;
}

function cjBuyLinkResponse(link: CachedAffiliateLinkLike): BuyLinkResponse {
  return {
    provider: "cj",
    buyUrl: `/go/cj/${link.id}`,
    status: "active",
  };
}

export function resolveFallbackBuyLink(
  fragrance: PublicFragranceLike,
  fallbackReason: string | undefined,
  env: BuyLinkEnv = {},
): BuyLinkResponse {
  const originalAmazonUrl = findAmazonProductUrl(fragrance.fragranceData);
  if (originalAmazonUrl) {
    const amazon = buildAmazonAffiliateUrl({
      productUrl: originalAmazonUrl,
      associateTag: env.amazonAssociateTag,
      enabled: env.amazonAffiliateEnabled,
    });

    return buyLinkResponse("amazon", "active", undefined, amazon.reason, {
      network: "amazon",
      buyUrl: amazon.url,
      affiliateApplied: amazon.affiliateApplied,
      affiliateUnavailableReason: amazon.reason,
    });
  }

  const searchQuery = buildFragranceQuery(fragrance);
  const amazonSearch = buildAmazonSearchUrl({
    query: searchQuery,
    marketplace: env.amazonMarketplace,
    associateTag: env.amazonAssociateTag,
    enabled: env.amazonAffiliateEnabled,
  });
  if (amazonSearch) {
    return buyLinkResponse("amazon", "active", undefined, "AMAZON_SEARCH_FALLBACK", {
      network: "amazon",
      buyUrl: amazonSearch.url,
      affiliateApplied: amazonSearch.affiliateApplied,
      affiliateUnavailableReason: amazonSearch.reason,
    });
  }

  return buyLinkResponse(
    "rakuten",
    "unavailable",
    undefined,
    fallbackReason ?? (env.rakutenEnvReady ? "EMPTY_FRAGRANCE_QUERY" : "RAKUTEN_CREDENTIALS_MISSING"),
  );
}

export type BuyLinkFreshnessOptions = {
  now?: Date;
  ttlMs?: number;
};

export function resolvePublicBuyLinkFromCachedLinks<T extends CachedAffiliateLinkLike>(
  fragrance: PublicFragranceLike,
  cachedLinks: T[] = [],
  env: BuyLinkEnv = {},
  freshness: BuyLinkFreshnessOptions = {},
): BuyLinkResponse {
  const { servable } = partitionAffiliateLinksByFreshness(
    cachedLinks,
    freshness.now ?? new Date(),
    freshness.ttlMs ?? DEFAULT_BUY_LINK_CACHE_TTL_MS,
  );

  const cachedRakuten = cachedProviderLink(servable, "rakuten");
  if (cachedRakuten) {
    return buyLinkResponse("rakuten", "active", cachedRakuten.id);
  }

  const cachedCj = cachedProviderLink(servable, "cj");
  if (cachedCj) {
    return cjBuyLinkResponse(cachedCj);
  }

  return resolveFallbackBuyLink(fragrance, "BUY_LINK_NOT_CACHED", env);
}
