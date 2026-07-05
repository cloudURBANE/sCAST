import test from "node:test";
import assert from "node:assert/strict";

import {
  CRAWLED_SOURCE_PROVIDER,
  isCrawledImageProvenance,
  isFragranticaImageUrl,
} from "./imageProvenanceCore.ts";

test("isFragranticaImageUrl matches fimgs.net and fragrantica locale domains", () => {
  assert.equal(isFragranticaImageUrl("https://fimgs.net/mdimg/perfume/375x500.31861.jpg"), true);
  assert.equal(isFragranticaImageUrl("https://www.fragrantica.com/images/p.jpg"), true);
  assert.equal(isFragranticaImageUrl("https://www.fragrantica.es/images/p.jpg"), true);
  assert.equal(isFragranticaImageUrl("https://retailer.example.com/bottle.jpg"), false);
  assert.equal(isFragranticaImageUrl(null), false);
});

test("isCrawledImageProvenance: crawled provider and crawled storage path", () => {
  assert.equal(isCrawledImageProvenance({ sourceProvider: CRAWLED_SOURCE_PROVIDER }), true);
  assert.equal(
    isCrawledImageProvenance({ storagePath: "images/processed/crawled/dior-sauvage/a-v5.webp" }),
    true,
  );
});

test("isCrawledImageProvenance: legacy manual rows are crawled only with a Fragrantica source URL", () => {
  assert.equal(
    isCrawledImageProvenance({
      sourceProvider: "manual",
      sourceUrl: "https://fimgs.net/mdimg/perfume/375x500.31861.jpg",
      storagePath: "images/processed/manual/dior-sauvage/a-v5.webp",
    }),
    true,
  );
  // Genuinely curated manual rows (admin upload / pasted non-FG URL) stay manual.
  assert.equal(
    isCrawledImageProvenance({ sourceProvider: "manual", sourceUrl: "admin-upload:u:abc" }),
    false,
  );
  assert.equal(isCrawledImageProvenance({ sourceProvider: "manual" }), false);
});

test("isCrawledImageProvenance: a scored serper winner is never crawled, even from fimgs.net", () => {
  assert.equal(
    isCrawledImageProvenance({
      sourceProvider: "serper",
      sourceUrl: "https://fimgs.net/himg/o.31861.jpg",
    }),
    false,
  );
});

test("isCrawledImageProvenance: empty refs are not crawled", () => {
  assert.equal(isCrawledImageProvenance(null), false);
  assert.equal(isCrawledImageProvenance({}), false);
});
