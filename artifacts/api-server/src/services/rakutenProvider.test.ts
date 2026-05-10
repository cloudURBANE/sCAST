import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import {
  createRakutenTokenKey,
  dedupeRakutenProducts,
  parseRakutenProductSearchXml,
  RakutenAdvertisingProvider,
  rakutenEnvReady,
  sanitizeRakutenSearchTerm,
  type RakutenProduct,
} from "./rakutenProvider.ts";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

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

test("createRakutenTokenKey base64 encodes client credentials as a bearer token-key", () => {
  assert.equal(createRakutenTokenKey("client-id", "client-secret"), "Bearer Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=");
});

test("rakutenEnvReady accepts OAuth credentials", () => {
  const original = {
    clientId: process.env.RAKUTEN_ADVERTISING_CLIENT_ID,
    clientSecret: process.env.RAKUTEN_ADVERTISING_CLIENT_SECRET,
    sid: process.env.RAKUTEN_ADVERTISING_SID,
    accessToken: process.env.RAKUTEN_ADVERTISING_ACCESS_TOKEN,
    apiAccessToken: process.env.RAKUTEN_API_ACCESS_TOKEN,
  };

  try {
    delete process.env.RAKUTEN_ADVERTISING_ACCESS_TOKEN;
    delete process.env.RAKUTEN_API_ACCESS_TOKEN;
    process.env.RAKUTEN_ADVERTISING_CLIENT_ID = "client-id";
    process.env.RAKUTEN_ADVERTISING_CLIENT_SECRET = "client-secret";
    process.env.RAKUTEN_ADVERTISING_SID = "123";

    assert.equal(rakutenEnvReady(), true);
  } finally {
    restoreEnv("RAKUTEN_ADVERTISING_CLIENT_ID", original.clientId);
    restoreEnv("RAKUTEN_ADVERTISING_CLIENT_SECRET", original.clientSecret);
    restoreEnv("RAKUTEN_ADVERTISING_SID", original.sid);
    restoreEnv("RAKUTEN_ADVERTISING_ACCESS_TOKEN", original.accessToken);
    restoreEnv("RAKUTEN_API_ACCESS_TOKEN", original.apiAccessToken);
  }
});

test("RakutenAdvertisingProvider fetches and caches OAuth access tokens for Product Search", async () => {
  const originalPost = axios.post;
  const originalGet = axios.get;
  let tokenRequests = 0;
  let searchRequests = 0;

  try {
    (axios.post as any) = async (url: string, data: any, config: any) => {
      tokenRequests += 1;
      assert.equal(url, "https://rakuten.example/token");
      assert.equal(data, "scope=123");
      assert.equal(config.headers.Authorization, "Bearer Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=");
      assert.equal(config.headers["content-type"], "application/x-www-form-urlencoded");
      return {
        status: 200,
        data: {
          access_token: "live-access-token",
          expires_in: 3600,
          refresh_token: "refresh-token",
          token_type: "Bearer",
        },
      };
    };

    (axios.get as any) = async (url: string, config: any) => {
      searchRequests += 1;
      assert.equal(config.headers.Authorization, "Bearer live-access-token");
      assert.match(url, /^https:\/\/rakuten\.example\/productsearch\/1\.0\?/);
      return {
        status: 200,
        data: `<result>
          <item>
            <mid>123</mid>
            <merchantname>Fragrance Retailer</merchantname>
            <productname>Dior Sauvage</productname>
            <linkurl>https://example.com/dior-sauvage</linkurl>
          </item>
        </result>`,
      };
    };

    const provider = new RakutenAdvertisingProvider({
      baseUrl: "https://rakuten.example",
      clientId: "client-id",
      clientSecret: "client-secret",
      sid: "123",
    });

    await provider.searchProducts({ keyword: "Dior Sauvage", max: 1 });
    await provider.searchProducts({ keyword: "Dior Sauvage", max: 1 });

    assert.equal(tokenRequests, 1);
    assert.equal(searchRequests, 2);
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
  }
});
