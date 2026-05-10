const AMAZON_HOSTNAMES = new Set(["amazon.com", "www.amazon.com", "smile.amazon.com"]);
const DEFAULT_AMAZON_MARKETPLACE = "amazon.com";

export function isAmazonProductUrl(productUrl: string): boolean {
  try {
    const url = new URL(productUrl);
    return (url.protocol === "https:" || url.protocol === "http:") && AMAZON_HOSTNAMES.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function buildAmazonAffiliateUrl(input: {
  productUrl: string;
  associateTag?: string;
  enabled?: boolean;
}): {
  url: string;
  affiliateApplied: boolean;
  reason?: string;
} {
  let url: URL;
  try {
    url = new URL(input.productUrl);
  } catch {
    return {
      url: input.productUrl,
      affiliateApplied: false,
      reason: "Invalid Amazon product URL. Showing original product link.",
    };
  }

  if (!isAmazonProductUrl(input.productUrl)) {
    return {
      url: input.productUrl,
      affiliateApplied: false,
      reason: "Non-Amazon URL. Showing original product link.",
    };
  }

  if (input.enabled !== true) {
    return {
      url: input.productUrl,
      affiliateApplied: false,
      reason: "AMAZON_AFFILIATE_ENABLED is not true. Showing original Amazon link.",
    };
  }

  const associateTag = input.associateTag?.trim();
  if (!associateTag) {
    return {
      url: input.productUrl,
      affiliateApplied: false,
      reason: "Missing AMAZON_ASSOCIATE_TAG. Showing original Amazon link.",
    };
  }

  url.searchParams.set("tag", associateTag);
  return {
    url: url.toString(),
    affiliateApplied: true,
  };
}

function normalizeAmazonMarketplace(value?: string): string {
  const raw = value?.trim().toLowerCase() || DEFAULT_AMAZON_MARKETPLACE;
  const withoutScheme = raw.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const host = withoutScheme.split("/")[0] || DEFAULT_AMAZON_MARKETPLACE;
  return /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host : DEFAULT_AMAZON_MARKETPLACE;
}

export function buildAmazonSearchUrl(input: {
  query: string;
  marketplace?: string;
  associateTag?: string;
  enabled?: boolean;
}): {
  url: string;
  affiliateApplied: boolean;
  reason?: string;
} | null {
  const query = input.query.trim();
  if (!query) return null;

  const marketplace = normalizeAmazonMarketplace(input.marketplace);
  const url = new URL(`https://www.${marketplace}/s`);
  url.searchParams.set("k", query);

  const associateTag = input.associateTag?.trim();
  if (input.enabled === true && associateTag) {
    url.searchParams.set("tag", associateTag);
    return { url: url.toString(), affiliateApplied: true };
  }

  return {
    url: url.toString(),
    affiliateApplied: false,
    reason: associateTag
      ? "AMAZON_AFFILIATE_ENABLED is not true. Showing Amazon search link."
      : "Missing AMAZON_ASSOCIATE_TAG. Showing Amazon search link.",
  };
}
