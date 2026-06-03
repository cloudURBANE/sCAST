import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBatchIds,
  resolvePublicBuyLinkFromCachedLinks,
  type CachedAffiliateLinkLike,
  type PublicFragranceLike,
} from "./buyLinksCore.ts";

const FRAGRANCE_ID = "00000000-0000-0000-0000-000000000001";
const RAKUTEN_LINK_ID = "00000000-0000-0000-0000-000000000101";
const CJ_LINK_ID = "00000000-0000-0000-0000-000000000201";

function fragranceRow(fragranceData: Record<string, unknown>): PublicFragranceLike {
  return {
    id: FRAGRANCE_ID,
    fragranceData,
  };
}

function affiliateLink(provider: "rakuten" | "cj", id: string): CachedAffiliateLinkLike {
  return {
    id,
    provider,
    status: "active",
  };
}

test("parseBatchIds trims, dedupes, and caps requested public ids", () => {
  const ids = parseBatchIds([
    " row-1 ",
    "row-1",
    "",
    ...Array.from({ length: 110 }, (_, index) => `row-${index + 2}`),
  ]);

  assert.equal(ids.length, 96);
  assert.deepEqual(ids.slice(0, 3), ["row-1", "row-2", "row-3"]);
});

test("public buy-link resolution prefers cached Rakuten before other fallbacks", () => {
  const result = resolvePublicBuyLinkFromCachedLinks(
    fragranceRow({
      id: "payload-id",
      brand: "Le Labo",
      name: "Santal 33",
      source: "https://www.amazon.com/dp/B000EXAMPLE",
    }),
    [affiliateLink("cj", CJ_LINK_ID), affiliateLink("rakuten", RAKUTEN_LINK_ID)],
  );

  assert.deepEqual(result, {
    provider: "rakuten",
    buyUrl: `/go/affiliate/${RAKUTEN_LINK_ID}`,
    status: "active",
  });
});

test("public buy-link resolution uses cached CJ when Rakuten is not cached", () => {
  const result = resolvePublicBuyLinkFromCachedLinks(
    fragranceRow({ id: "payload-id", brand: "Le Labo", name: "Santal 33" }),
    [affiliateLink("cj", CJ_LINK_ID)],
  );

  assert.deepEqual(result, {
    provider: "cj",
    buyUrl: `/go/cj/${CJ_LINK_ID}`,
    status: "active",
  });
});

test("public buy-link resolution falls back to Amazon product URLs without live Rakuten lookup", () => {
  const result = resolvePublicBuyLinkFromCachedLinks(
    fragranceRow({
      id: "payload-id",
      brand: "Le Labo",
      name: "Santal 33",
      retailers: [{ url: "https://www.amazon.com/dp/B000EXAMPLE?psc=1" }],
    }),
    [],
    { amazonAffiliateEnabled: true, amazonAssociateTag: "mytag-20" },
  );

  assert.deepEqual(result, {
    provider: "amazon",
    network: "amazon",
    buyUrl: "https://www.amazon.com/dp/B000EXAMPLE?psc=1&tag=mytag-20",
    status: "active",
    affiliateApplied: true,
  });
});
