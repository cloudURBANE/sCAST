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

test("processed Supabase CDN URLs render directly, bypassing the proxy in packshot mode", () => {
  const url = proxiedImageUrl(
    "https://abc.supabase.co/storage/v1/object/public/images/images/processed/brand/slug/hash-v3.webp?v=v3",
    { apiBaseUrl: "https://api.example.com", packshot: true },
  );

  // Direct passthrough: same URL, no proxy wrapper, no trim re-encode, v= preserved.
  assert.equal(
    url,
    "https://abc.supabase.co/storage/v1/object/public/images/images/processed/brand/slug/hash-v3.webp?v=v3",
  );
  assert.equal(url.includes("/api/image-proxy"), false);
});

test("processed Firebase alt=media URLs (percent-encoded path) render directly", () => {
  const raw =
    "https://firebasestorage.googleapis.com/v0/b/my-bucket/o/images%2Fprocessed%2Fbrand%2Fslug%2Fhash-v3.webp?alt=media&token=abc";
  const url = proxiedImageUrl(raw, { apiBaseUrl: "https://api.example.com", packshot: true });

  assert.equal(url, raw);
  assert.equal(url.includes("/api/image-proxy"), false);
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
