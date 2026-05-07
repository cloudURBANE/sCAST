import assert from "node:assert/strict";
import test from "node:test";
import { buildAmazonAffiliateUrl } from "./amazonAffiliateUrl.ts";

test("buildAmazonAffiliateUrl adds tag to Amazon URL without query params", () => {
  const result = buildAmazonAffiliateUrl({
    productUrl: "https://www.amazon.com/dp/B000EXAMPLE",
    associateTag: "mytag-20",
    enabled: true,
  });

  assert.equal(result.url, "https://www.amazon.com/dp/B000EXAMPLE?tag=mytag-20");
  assert.equal(result.affiliateApplied, true);
});

test("buildAmazonAffiliateUrl appends tag to Amazon URL with query params", () => {
  const result = buildAmazonAffiliateUrl({
    productUrl: "https://www.amazon.com/dp/B000EXAMPLE?psc=1",
    associateTag: "mytag-20",
    enabled: true,
  });

  assert.equal(result.url, "https://www.amazon.com/dp/B000EXAMPLE?psc=1&tag=mytag-20");
  assert.equal(result.affiliateApplied, true);
});

test("buildAmazonAffiliateUrl replaces existing Amazon tag", () => {
  const result = buildAmazonAffiliateUrl({
    productUrl: "https://www.amazon.com/dp/B000EXAMPLE?tag=oldtag-20&psc=1",
    associateTag: "mytag-20",
    enabled: true,
  });

  assert.equal(result.url, "https://www.amazon.com/dp/B000EXAMPLE?tag=mytag-20&psc=1");
  assert.equal(result.affiliateApplied, true);
});

test("buildAmazonAffiliateUrl returns original URL when disabled or tag is missing", () => {
  const productUrl = "https://www.amazon.com/dp/B000EXAMPLE";

  assert.deepEqual(buildAmazonAffiliateUrl({ productUrl, associateTag: "mytag-20", enabled: false }), {
    url: productUrl,
    affiliateApplied: false,
    reason: "AMAZON_AFFILIATE_ENABLED is not true. Showing original Amazon link.",
  });

  assert.deepEqual(buildAmazonAffiliateUrl({ productUrl, enabled: true }), {
    url: productUrl,
    affiliateApplied: false,
    reason: "Missing AMAZON_ASSOCIATE_TAG. Showing original Amazon link.",
  });
});

test("buildAmazonAffiliateUrl leaves invalid and non-Amazon URLs untouched", () => {
  assert.equal(
    buildAmazonAffiliateUrl({ productUrl: "not a url", associateTag: "mytag-20", enabled: true }).url,
    "not a url",
  );
  assert.equal(
    buildAmazonAffiliateUrl({
      productUrl: "https://example.com/dp/B000EXAMPLE",
      associateTag: "mytag-20",
      enabled: true,
    }).url,
    "https://example.com/dp/B000EXAMPLE",
  );
});
