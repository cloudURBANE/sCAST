const AMAZON_HOSTNAMES = new Set(["amazon.com", "www.amazon.com", "smile.amazon.com"]);

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
