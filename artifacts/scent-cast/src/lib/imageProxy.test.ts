import assert from "node:assert/strict";
import test from "node:test";
import { isProcessedStorageImageUrl, proxiedImageUrl } from "./imageProxy.ts";

test("processed image objects render directly from API origin, even in packshot mode", () => {
  const url = proxiedImageUrl(
    "/api/image-objects/images/processed/brand/bottle.webp?v=abc123",
    { apiBaseUrl: "http://localhost:3002", packshot: true },
  );

  assert.equal(
    url,
    "http://localhost:3002/api/image-objects/images/processed/brand/bottle.webp?v=abc123",
  );
  assert.equal(url.includes("/api/image-proxy"), false);
});

test("processed Supabase CDN URLs route through the same-origin proxy by default (no trim re-encode)", () => {
  const raw =
    "https://abc.supabase.co/storage/v1/object/public/images/images/processed/brand/slug/hash-v3.webp?v=v3";
  const url = proxiedImageUrl(raw, { apiBaseUrl: "https://api.example.com", packshot: true });

  // Default (VITE_IMAGE_DIRECT_CDN unset): processed objects go through the proxy,
  // which reads them with the server's storage credentials. v= is preserved and
  // trim is NOT appended (processed transparent WebPs must not be JPEG-trimmed).
  assert.equal(
    url,
    "https://api.example.com/api/image-proxy?url=" + encodeURIComponent(raw) + "&v=v3",
  );
});

test("processed Firebase alt=media URLs (percent-encoded path) route through the proxy by default", () => {
  const raw =
    "https://firebasestorage.googleapis.com/v0/b/my-bucket/o/images%2Fprocessed%2Fbrand%2Fslug%2Fhash-v3.webp?alt=media&token=abc";
  const url = proxiedImageUrl(raw, { apiBaseUrl: "https://api.example.com", packshot: true });

  assert.equal(url, "https://api.example.com/api/image-proxy?url=" + encodeURIComponent(raw));
  assert.equal(url.includes("&trim=1"), false);
});

test("isProcessedStorageImageUrl matches the configurable CDN-base allowlist", () => {
  const bases = ["https://cdn.scentbeam.com", "https://abc.supabase.co/storage/v1/object/public/images"];
  assert.equal(isProcessedStorageImageUrl("https://cdn.scentbeam.com/anything/bottle.webp", bases), true);
  assert.equal(
    isProcessedStorageImageUrl(
      "https://abc.supabase.co/storage/v1/object/public/images/foo/bottle.webp",
      bases,
    ),
    true,
  );
  // A different host that merely shares a prefix substring must not match.
  assert.equal(isProcessedStorageImageUrl("https://cdn.scentbeam.com.evil.test/bottle.webp", bases), false);
  // Third-party hotlink source with no processed marker and no allowlist hit.
  assert.equal(isProcessedStorageImageUrl("https://fimgs.net/mdimg/perfume/375x500.123.jpg", bases), false);
});

test("processed CDN objects route through the proxy with cache version preserved", () => {
  const raw =
    "https://abc.supabase.co/storage/v1/object/public/images/images/processed/brand/slug/hash-v3.webp?v=v3";
  const expected =
    "https://api.example.com/api/image-proxy?url=" + encodeURIComponent(raw) + "&v=v3";
  // Default routing and the explicit Phase-4 forceProxy fallback produce the same
  // same-origin proxy URL.
  assert.equal(proxiedImageUrl(raw, { apiBaseUrl: "https://api.example.com" }), expected);
  assert.equal(
    proxiedImageUrl(raw, { apiBaseUrl: "https://api.example.com", forceProxy: true }),
    expected,
  );
});

test("forceProxy still returns local image-object paths as-is (proxying localhost is pointless)", () => {
  const raw = "/api/image-objects/images/processed/brand/bottle.webp?v=abc123";
  assert.equal(
    proxiedImageUrl(raw, { apiBaseUrl: "http://localhost:3002", forceProxy: true }),
    "http://localhost:3002/api/image-objects/images/processed/brand/bottle.webp?v=abc123",
  );
});

test("remote images still go through API image proxy with cache version preserved", () => {
  const url = proxiedImageUrl(
    "https://cdn.example.com/bottle.jpg?v=fresh",
    { apiBaseUrl: "https://api.example.com", packshot: true },
  );

  assert.equal(
    url,
    "https://api.example.com/api/image-proxy?url=https%3A%2F%2Fcdn.example.com%2Fbottle.jpg%3Fv%3Dfresh&v=fresh&trim=1",
  );
});

test("api base URL guard ignores comma-separated fallback origins", () => {
  const url = proxiedImageUrl(
    "https://cdn.example.com/bottle.jpg",
    {
      apiBaseUrl: "https://api.example.com,https://www.example.com,https://example.com",
      packshot: true,
    },
  );

  assert.equal(
    url,
    "https://api.example.com/api/image-proxy?url=https%3A%2F%2Fcdn.example.com%2Fbottle.jpg&trim=1",
  );
});
