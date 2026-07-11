import test from "node:test";
import assert from "node:assert/strict";

import {
  CRAWLED_SOURCE_PROVIDER,
  displayableImageUrl,
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

test("isCrawledImageProvenance: a raw Fragrantica DISPLAY url is the fallback itself, whatever the provider label", () => {
  assert.equal(
    isCrawledImageProvenance({ imageUrl: "https://fimgs.net/mdimg/perfume/375x500.10421.jpg" }),
    true,
  );
  // Even a "serper"/"manual" label cannot launder a raw fimgs display url —
  // processed pipeline winners always live on our own storage.
  assert.equal(
    isCrawledImageProvenance({
      sourceProvider: "serper",
      imageUrl: "https://www.fragrantica.com/images/p.jpg",
    }),
    true,
  );
});

test("isCrawledImageProvenance: a processed crawled copy is detected by its public url", () => {
  assert.equal(
    isCrawledImageProvenance({
      imageUrl: "https://storage.example.com/images/processed/crawled/dior-sauvage/a-v5.webp",
    }),
    true,
  );
});

test("isCrawledImageProvenance: our own processed display url stays clean", () => {
  assert.equal(
    isCrawledImageProvenance({
      sourceProvider: "serper",
      sourceUrl: "https://fimgs.net/himg/o.31861.jpg",
      imageUrl: "https://storage.example.com/images/processed/serper/dior-sauvage/a-v5.webp",
    }),
    false,
  );
});

test("displayableImageUrl blanks crawled refs and passes clean urls through", () => {
  assert.equal(
    displayableImageUrl({ imageUrl: "https://fimgs.net/mdimg/perfume/375x500.10421.jpg" }),
    "",
  );
  assert.equal(
    displayableImageUrl({ imageUrl: "https://cdn.example.com/x.webp", sourceProvider: "crawled" }),
    "",
  );
  assert.equal(
    displayableImageUrl({ imageUrl: "https://cdn.example.com/x.webp", sourceProvider: "serper" }),
    "https://cdn.example.com/x.webp",
  );
  assert.equal(displayableImageUrl({ imageUrl: "   " }), "");
  assert.equal(displayableImageUrl(null), "");
});
