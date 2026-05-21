import assert from "node:assert/strict";
import test from "node:test";
import { publicShareBuyLinkEndpoint } from "./shareLinks.ts";

test("public share buy-link endpoint encodes share refs and fragrance ids", () => {
  assert.equal(
    publicShareBuyLinkEndpoint("@alex", "catalog:Maison Francis Kurkdjian::Baccarat Rouge 540"),
    "/api/share/%40alex/fragrances/catalog%3AMaison%20Francis%20Kurkdjian%3A%3ABaccarat%20Rouge%20540/buy-link",
  );
});
