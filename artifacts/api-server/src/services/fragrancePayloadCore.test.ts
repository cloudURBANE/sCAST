import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseHydratedImageUrl,
  chooseHydratedImageUrlWithMetadata,
  CURRENT_VAULT_SCHEMA_VERSION,
  isLegacyVaultRow,
  resolveCanonicalImageUrl,
  stampVaultSchemaVersion,
} from "./fragrancePayloadCore.ts";

test("isLegacyVaultRow flags rows missing the schema-version stamp", () => {
  assert.equal(isLegacyVaultRow(null), true);
  assert.equal(isLegacyVaultRow(undefined), true);
  assert.equal(isLegacyVaultRow({}), true);
  assert.equal(isLegacyVaultRow({ name: "Sauvage" }), true);
  assert.equal(isLegacyVaultRow({ schemaVersion: "1" as any }), true);
});

test("isLegacyVaultRow flags rows stamped below the current version", () => {
  assert.equal(isLegacyVaultRow({ schemaVersion: 0 }), true);
  assert.equal(isLegacyVaultRow({ schemaVersion: CURRENT_VAULT_SCHEMA_VERSION - 1 }), true);
});

test("isLegacyVaultRow accepts rows at or above the current version", () => {
  assert.equal(isLegacyVaultRow({ schemaVersion: CURRENT_VAULT_SCHEMA_VERSION }), false);
  assert.equal(isLegacyVaultRow({ schemaVersion: CURRENT_VAULT_SCHEMA_VERSION + 1 }), false);
});

test("stampVaultSchemaVersion sets the current version on un-stamped rows", () => {
  const stamped = stampVaultSchemaVersion({ name: "Sauvage", brand: "Dior" });
  assert.equal(stamped.schemaVersion, CURRENT_VAULT_SCHEMA_VERSION);
  assert.equal(stamped.name, "Sauvage");
  assert.equal(stamped.brand, "Dior");
});

test("stampVaultSchemaVersion overrides any prior schema-version value", () => {
  // The write gate owns the value; clients cannot pin themselves to a future
  // version they aren't actually writing in.
  const stamped = stampVaultSchemaVersion({ schemaVersion: 999, name: "X" });
  assert.equal(stamped.schemaVersion, CURRENT_VAULT_SCHEMA_VERSION);
});

test("stampVaultSchemaVersion does not mutate its input", () => {
  const input = { name: "Sauvage" };
  const stamped = stampVaultSchemaVersion(input);
  assert.notEqual(stamped, input);
  assert.equal((input as Record<string, any>).schemaVersion, undefined);
});

test("stampVaultSchemaVersion preserves every other field, including falsy ones", () => {
  const input = {
    id: "f-123",
    name: "Sauvage",
    brand: "Dior",
    notes: ["bergamot", "ambroxan"],
    pyramid: { top: ["bergamot"], heart: [], base: ["ambroxan"] },
    imageUrl: "",
    shareHidden: false,
    season: "Universal",
  };
  const stamped = stampVaultSchemaVersion(input);
  for (const key of Object.keys(input) as (keyof typeof input)[]) {
    assert.deepEqual(stamped[key], input[key]);
  }
});

test("chooseHydratedImageUrl keeps a usable stored row image over a shared image", () => {
  assert.equal(
    chooseHydratedImageUrl(
      "https://cdn.example.com/fresh.webp",
      "https://cdn.example.com/manual.webp",
    ),
    "https://cdn.example.com/manual.webp",
  );
});

test("chooseHydratedImageUrl falls back to the shared image when the stored row image is missing", () => {
  assert.equal(
    chooseHydratedImageUrl("https://cdn.example.com/shared.webp", null),
    "https://cdn.example.com/shared.webp",
  );
});

test("chooseHydratedImageUrl returns empty when neither source has an image", () => {
  assert.equal(chooseHydratedImageUrl("", "   "), "");
});

test("chooseHydratedImageUrlWithMetadata keeps a saved manual row image over shared images", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      { imageUrl: "https://cdn.example.com/openai.webp", sourceProvider: "openai" },
      { imageUrl: "https://cdn.example.com/manual.webp", sourceProvider: "manual" },
    ),
    "https://cdn.example.com/manual.webp",
  );
});

test("chooseHydratedImageUrlWithMetadata lets generated cache replace stale non-manual row images", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      {
        imageUrl: "https://cdn.example.com/generated.webp",
        sourceProvider: "manual",
        sourceUrl: "openai-reimagine:gpt-image-2:abc:def",
      },
      { imageUrl: "https://retailer.example.com/stale.jpg", sourceProvider: "serper" },
    ),
    "https://cdn.example.com/generated.webp",
  );
});

test("chooseHydratedImageUrlWithMetadata treats processed manual paths as saved manual images", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      { imageUrl: "https://cdn.example.com/shared.webp", sourceProvider: "manual" },
      {
        imageUrl: "https://storage.example.com/images/processed/manual/reflection.webp",
        storagePath: "images/processed/manual/reflection.webp",
      },
    ),
    "https://storage.example.com/images/processed/manual/reflection.webp",
  );
});

// --- crawled Fragrantica fallback demotion ----------------------------------
// The engine-crawled og:image ("crawled" provider; legacy copies stamped
// "manual" with a Fragrantica source URL) is never authoritative: a saved
// fallback upgrades to any non-crawled shared image, and a crawled cache row
// can never replace a row's non-crawled image or ride the manual fast-path.

test("chooseHydratedImageUrlWithMetadata upgrades a saved crawled fallback to the shared serper winner", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      { imageUrl: "https://cdn.example.com/serper.webp", sourceProvider: "serper" },
      { imageUrl: "https://cdn.example.com/fg-fallback.webp", sourceProvider: "crawled" },
    ),
    "https://cdn.example.com/serper.webp",
  );
});

test("chooseHydratedImageUrlWithMetadata detects a crawled row image by its storage path", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      { imageUrl: "https://cdn.example.com/serper.webp", sourceProvider: "serper" },
      {
        imageUrl: "https://storage.example.com/images/processed/crawled/dior-sauvage/abc-v5.webp",
        storagePath: "images/processed/crawled/dior-sauvage/abc-v5.webp",
      },
    ),
    "https://cdn.example.com/serper.webp",
  );
});

test("chooseHydratedImageUrlWithMetadata never lets a legacy crawled cache row (manual + Fragrantica URL) override a row image or ride the manual fast-path", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      {
        imageUrl: "https://cdn.example.com/fg-fallback.webp",
        sourceProvider: "manual",
        sourceUrl: "https://fimgs.net/mdimg/perfume/375x500.31861.jpg",
        storagePath: "images/processed/manual/dior-sauvage/abc-v5.webp",
      },
      { imageUrl: "https://cdn.example.com/serper.webp", sourceProvider: "serper" },
    ),
    "https://cdn.example.com/serper.webp",
  );
});

test("chooseHydratedImageUrlWithMetadata keeps a genuinely manual shared image over a crawled row image", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      {
        imageUrl: "https://cdn.example.com/curated.webp",
        sourceProvider: "manual",
        sourceUrl: "admin-upload:user-1:abc",
      },
      { imageUrl: "https://cdn.example.com/fg-fallback.webp", sourceProvider: "crawled" },
    ),
    "https://cdn.example.com/curated.webp",
  );
});

test("chooseHydratedImageUrlWithMetadata returns empty when both candidates are crawled (the fallback is never displayable)", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      {
        imageUrl: "https://cdn.example.com/fg-shared.webp",
        sourceProvider: "manual",
        sourceUrl: "https://fimgs.net/mdimg/perfume/375x500.31861.jpg",
      },
      { imageUrl: "https://cdn.example.com/fg-row.webp", sourceProvider: "crawled" },
    ),
    "",
  );
});

test("chooseHydratedImageUrlWithMetadata returns empty when the only candidate is crawled", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      null,
      { imageUrl: "https://cdn.example.com/fg-row.webp", sourceProvider: "crawled" },
    ),
    "",
  );
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      { imageUrl: "https://cdn.example.com/fg-shared.webp", sourceProvider: "crawled" },
      null,
    ),
    "",
  );
});

test("chooseHydratedImageUrlWithMetadata treats a raw Fragrantica display url as the crawled fallback even with no provider metadata", () => {
  // A client payload that persisted the engine's image_url verbatim: the row's
  // display url IS the raw fimgs.net image. It must never win over a processed
  // shared image, and alone it must blank rather than display.
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      { imageUrl: "https://cdn.example.com/serper.webp", sourceProvider: "serper" },
      { imageUrl: "https://fimgs.net/mdimg/perfume/375x500.10421.jpg" },
    ),
    "https://cdn.example.com/serper.webp",
  );
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      null,
      { imageUrl: "https://fimgs.net/mdimg/perfume/375x500.10421.jpg" },
    ),
    "",
  );
});

test("chooseHydratedImageUrlWithMetadata keeps serper trust for a scored fimgs.net winner (serper is never demoted as crawled)", () => {
  assert.equal(
    chooseHydratedImageUrlWithMetadata(
      {
        imageUrl: "https://cdn.example.com/serper-fimgs.webp",
        sourceProvider: "serper",
        sourceUrl: "https://fimgs.net/himg/o.31861.jpg",
      },
      { imageUrl: "https://cdn.example.com/fg-fallback.webp", sourceProvider: "crawled" },
    ),
    "https://cdn.example.com/serper-fimgs.webp",
  );
});

// Regression guard for the "no image after successful add" bug: the external
// Python engine and some legacy/search payloads carry the bottle image as
// snake_case `image_url` (or bare `image`), while every persistence/render path
// reads camelCase `imageUrl`. resolveCanonicalImageUrl must alias these so a
// *known* image is never silently dropped at add time.

test("resolveCanonicalImageUrl carries snake_case image_url through", () => {
  assert.equal(
    resolveCanonicalImageUrl({ name: "Sauvage", image_url: "https://cdn.example.com/s.webp" }),
    "https://cdn.example.com/s.webp",
  );
});

test("resolveCanonicalImageUrl carries bare `image` through", () => {
  assert.equal(
    resolveCanonicalImageUrl({ name: "Aventus", image: "https://cdn.example.com/a.webp" }),
    "https://cdn.example.com/a.webp",
  );
});

test("resolveCanonicalImageUrl prefers an explicit camelCase imageUrl over aliases", () => {
  assert.equal(
    resolveCanonicalImageUrl({
      imageUrl: "https://cdn.example.com/canonical.webp",
      image_url: "https://cdn.example.com/legacy.webp",
    }),
    "https://cdn.example.com/canonical.webp",
  );
});

test("resolveCanonicalImageUrl ignores blank/whitespace aliases and falls back to imageUrl", () => {
  assert.equal(
    resolveCanonicalImageUrl({ imageUrl: "", image_url: "   " }),
    "",
  );
  assert.equal(resolveCanonicalImageUrl({ name: "Terre" }), undefined);
});
