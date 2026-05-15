import assert from "node:assert/strict";
import test from "node:test";
import { proxiedImageUrl } from "./imageProxy.ts";

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
