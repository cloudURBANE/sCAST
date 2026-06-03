import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAffiliateLinkFreshness,
  DEFAULT_BUY_LINK_CACHE_TTL_MS,
  parseBatchIds,
  partitionAffiliateLinksByFreshness,
  resolvePublicBuyLinkFromCachedLinks,
  type CachedAffiliateLinkLike,
  type PublicFragranceLike,
} from "./buyLinksCore.ts";

const FRAGRANCE_ID = "00000000-0000-0000-0000-000000000001";
const RAKUTEN_LINK_ID = "00000000-0000-0000-0000-000000000101";
const CJ_LINK_ID = "00000000-0000-0000-0000-000000000201";

const NOW = new Date("2026-06-03T00:00:00.000Z");
const FRESH_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000); // 1 day old
const EXPIRED_AT = new Date(NOW.getTime() - DEFAULT_BUY_LINK_CACHE_TTL_MS - 1000); // just past TTL

function fragranceRow(fragranceData: Record<string, unknown>): PublicFragranceLike {
  return {
    id: FRAGRANCE_ID,
    fragranceData,
  };
}

function affiliateLink(
  provider: "rakuten" | "cj",
  id: string,
  extra: Partial<CachedAffiliateLinkLike> = {},
): CachedAffiliateLinkLike {
  return {
    id,
    provider,
    status: "active",
    ...extra,
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

test("classifyAffiliateLinkFreshness treats recently verified rows as fresh", () => {
  const freshness = classifyAffiliateLinkFreshness(
    affiliateLink("rakuten", RAKUTEN_LINK_ID, { lastVerifiedAt: FRESH_AT }),
    NOW,
  );

  assert.equal(freshness.fresh, true);
  assert.equal(freshness.reason, "fresh");
});

test("classifyAffiliateLinkFreshness flags rows past the TTL as expired", () => {
  const freshness = classifyAffiliateLinkFreshness(
    affiliateLink("rakuten", RAKUTEN_LINK_ID, { fetchedAt: EXPIRED_AT }),
    NOW,
  );

  assert.equal(freshness.fresh, false);
  assert.equal(freshness.reason, "expired");
  assert.ok((freshness.ageMs ?? 0) > DEFAULT_BUY_LINK_CACHE_TTL_MS);
});

test("classifyAffiliateLinkFreshness keeps undateable rows servable but flags unknown age", () => {
  const freshness = classifyAffiliateLinkFreshness(affiliateLink("cj", CJ_LINK_ID), NOW);

  assert.equal(freshness.fresh, true);
  assert.equal(freshness.reason, "unknown_age");
  assert.equal(freshness.ageMs, null);
});

test("partitionAffiliateLinksByFreshness drops expired rows and reports observations", () => {
  const links = [
    affiliateLink("rakuten", RAKUTEN_LINK_ID, { lastVerifiedAt: EXPIRED_AT }),
    affiliateLink("cj", CJ_LINK_ID, { lastVerifiedAt: FRESH_AT }),
    affiliateLink("rakuten", "00000000-0000-0000-0000-000000000102"),
  ];

  const { servable, observations } = partitionAffiliateLinksByFreshness(links, NOW);

  assert.deepEqual(
    servable.map((link) => link.id),
    [CJ_LINK_ID, "00000000-0000-0000-0000-000000000102"],
  );
  assert.deepEqual(
    observations.map((obs) => [obs.link.id, obs.reason]),
    [
      [RAKUTEN_LINK_ID, "expired"],
      ["00000000-0000-0000-0000-000000000102", "unknown_age"],
    ],
  );
});

test("public buy-link resolution skips an expired cached Rakuten row and falls back", () => {
  const result = resolvePublicBuyLinkFromCachedLinks(
    fragranceRow({
      id: "payload-id",
      brand: "Le Labo",
      name: "Santal 33",
      retailers: [{ url: "https://www.amazon.com/dp/B000EXAMPLE?psc=1" }],
    }),
    [affiliateLink("rakuten", RAKUTEN_LINK_ID, { lastVerifiedAt: EXPIRED_AT })],
    { amazonAffiliateEnabled: true, amazonAssociateTag: "mytag-20" },
    { now: NOW },
  );

  assert.deepEqual(result, {
    provider: "amazon",
    network: "amazon",
    buyUrl: "https://www.amazon.com/dp/B000EXAMPLE?psc=1&tag=mytag-20",
    status: "active",
    affiliateApplied: true,
  });
});

test("public buy-link resolution still serves a fresh cached Rakuten row", () => {
  const result = resolvePublicBuyLinkFromCachedLinks(
    fragranceRow({ id: "payload-id", brand: "Le Labo", name: "Santal 33" }),
    [affiliateLink("rakuten", RAKUTEN_LINK_ID, { lastVerifiedAt: FRESH_AT })],
    {},
    { now: NOW },
  );

  assert.deepEqual(result, {
    provider: "rakuten",
    buyUrl: `/go/affiliate/${RAKUTEN_LINK_ID}`,
    status: "active",
  });
});
