import assert from "node:assert/strict";
import test from "node:test";
import { parseIncomingImageUrl } from "./incomingImageUrl.ts";

test("incoming absolute API object URLs are normalized back to local object paths", () => {
  assert.equal(
    parseIncomingImageUrl("http://localhost:3002/api/image-objects/images/processed/brand/bottle.webp?v=abc"),
    "/api/image-objects/images/processed/brand/bottle.webp?v=abc",
  );
  assert.equal(
    parseIncomingImageUrl("https://api.scentbeam.com/api/image-objects/images/processed/brand/bottle.webp"),
    "/api/image-objects/images/processed/brand/bottle.webp",
  );
});

test("incoming remote image URLs remain remote sources", () => {
  assert.equal(
    parseIncomingImageUrl("https://cdn.example.com/images/bottle.jpg?v=abc"),
    "https://cdn.example.com/images/bottle.jpg?v=abc",
  );
});

test("incoming image parser rejects non-image object local paths", () => {
  assert.equal(parseIncomingImageUrl("/api/health"), null);
  assert.equal(parseIncomingImageUrl("file:///tmp/bottle.jpg"), null);
});
