import assert from "node:assert/strict";
import test from "node:test";
import { publicShareBuyLinkEndpoint, publicShareBuyLinksEndpoint } from "./shareLinks.ts";

test("public share buy-link endpoint encodes share refs and fragrance ids", () => {
  assert.equal(
    publicShareBuyLinkEndpoint("@alex", "catalog:Maison Francis Kurkdjian::Baccarat Rouge 540"),
    "/api/share/%40alex/fragrances/catalog%3AMaison%20Francis%20Kurkdjian%3A%3ABaccarat%20Rouge%20540/buy-link",
  );
});

test("public share batch buy-link endpoint encodes share refs and repeated ids", () => {
  assert.equal(
    publicShareBuyLinksEndpoint("@alex", [
      "first-id",
      "catalog:Maison Francis Kurkdjian::Baccarat Rouge 540",
    ]),
    "/api/share/%40alex/buy-links?ids=first-id&ids=catalog%3AMaison+Francis+Kurkdjian%3A%3ABaccarat+Rouge+540",
  );
});
