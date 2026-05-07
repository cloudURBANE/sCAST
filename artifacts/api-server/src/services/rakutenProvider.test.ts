import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeRakutenProducts,
  parseRakutenProductSearchXml,
  sanitizeRakutenSearchTerm,
  type RakutenProduct,
} from "./rakutenProvider.ts";

test("sanitizeRakutenSearchTerm removes Product Search unsupported characters", () => {
  assert.equal(sanitizeRakutenSearchTerm("YSL - cologne & vanilla (men)"), "YSL cologne vanilla men");
});

test("parseRakutenProductSearchXml normalizes XML products", () => {
  const products = parseRakutenProductSearchXml(
    `<result>
      <TotalMatches>1</TotalMatches>
      <TotalPages>1</TotalPages>
      <PageNumber>1</PageNumber>
      <item>
        <mid>123</mid>
        <merchantname>Fragrance Retailer</merchantname>
        <linkid>abc</linkid>
        <sku>SKU-1</sku>
        <productname>Dior Sauvage Eau de Parfum</productname>
        <category>
          <primary>Beauty</primary>
          <secondary>Fragrance~~Men</secondary>
        </category>
        <price currency="USD">120.00</price>
        <saleprice currency="USD">99.99</saleprice>
        <linkurl>https://example.com/dior-sauvage</linkurl>
        <imageurl>https://example.com/dior-sauvage.jpg</imageurl>
      </item>
    </result>`,
    "Dior Sauvage",
  );

  assert.equal(products.length, 1);
  assert.equal(products[0]?.advertiserId, "123");
  assert.equal(products[0]?.advertiserName, "Fragrance Retailer");
  assert.equal(products[0]?.title, "Dior Sauvage Eau de Parfum");
  assert.equal(products[0]?.categoryPrimary, "Beauty");
  assert.equal(products[0]?.categorySecondary, "Fragrance~~Men");
  assert.equal(products[0]?.salePrice, "99.99");
  assert.equal(products[0]?.currency, "USD");
  assert.equal(products[0]?.affiliateUrl, null);
  assert.ok((products[0]?.matchScore ?? 0) > 0.5);
});

test("dedupeRakutenProducts removes repeated advertiser SKU products", () => {
  const product: RakutenProduct = {
    provider: "rakuten",
    advertiserId: "123",
    advertiserName: "Retailer",
    productLinkId: "link-1",
    sku: "SKU-1",
    title: "Perfume",
    brand: null,
    categoryPrimary: null,
    categorySecondary: null,
    price: "100",
    salePrice: null,
    currency: "USD",
    destinationUrl: "https://example.com/a",
    imageUrl: null,
    matchScore: 0.8,
    affiliateUrl: null,
    affiliateUnavailableReason: null,
  };

  assert.equal(dedupeRakutenProducts([product, { ...product, productLinkId: "link-2" }]).length, 1);
});
