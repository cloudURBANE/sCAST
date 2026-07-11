import test from "node:test";
import assert from "node:assert/strict";

import { displayableVaultImageUrl, isBlockedVaultImageUrl } from "./vaultImagePolicy.ts";

test("blocks raw Fragrantica image urls (fimgs.net and locale domains)", () => {
  assert.equal(isBlockedVaultImageUrl("https://fimgs.net/mdimg/perfume/375x500.10421.jpg"), true);
  assert.equal(isBlockedVaultImageUrl("https://www.fragrantica.com/images/p.jpg"), true);
  assert.equal(isBlockedVaultImageUrl("https://www.fragrantica.es/images/p.jpg"), true);
});

test("blocks processed copies of the crawled fallback by their storage path", () => {
  assert.equal(
    isBlockedVaultImageUrl(
      "https://storage.example.com/images/processed/crawled/dior-sauvage/a-v5.webp",
    ),
    true,
  );
  assert.equal(
    isBlockedVaultImageUrl("/api/image-objects/images/processed/crawled/dior-sauvage/a-v5.webp"),
    true,
  );
});

test("passes our own processed packshots and empty values through", () => {
  assert.equal(
    isBlockedVaultImageUrl(
      "https://storage.example.com/images/processed/serper/dior-sauvage/a-v5.webp",
    ),
    false,
  );
  assert.equal(isBlockedVaultImageUrl(""), false);
  assert.equal(isBlockedVaultImageUrl(undefined), false);
  assert.equal(isBlockedVaultImageUrl(null), false);
});

test("displayableVaultImageUrl blanks blocked urls and trims clean ones", () => {
  assert.equal(displayableVaultImageUrl("https://fimgs.net/mdimg/perfume/x.jpg"), "");
  assert.equal(
    displayableVaultImageUrl(" https://cdn.example.com/clean.webp "),
    "https://cdn.example.com/clean.webp",
  );
  assert.equal(displayableVaultImageUrl(42), "");
  assert.equal(displayableVaultImageUrl("   "), "");
});
