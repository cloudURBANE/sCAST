import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImagePatch,
  matchesBackfillTarget,
  normalizeBackfillText,
} from "./userImageBackfillCore.ts";

const image = {
  imageUrl: "https://cdn.example.com/ysl-cinema.webp",
  imageHash: "abc123",
  storagePath: "fragrances/ysl-cinema.webp",
  storageProvider: "supabase",
  sourceProvider: "serper" as const,
};

test("matchesBackfillTarget fills an imageless row matching brand+name", () => {
  // Real shape observed live: YSL Cinema with imageUrl: "".
  const row = { brand: "Yves Saint Laurent", name: "Cinema", imageUrl: "" };
  assert.equal(matchesBackfillTarget(row, "Yves Saint Laurent", "Cinema"), true);
});

test("matchesBackfillTarget never overwrites a row that already has an image", () => {
  const row = {
    brand: "Yves Saint Laurent",
    name: "Black Opium",
    imageUrl: "https://store.example.com/black-opium.webp",
  };
  assert.equal(matchesBackfillTarget(row, "Yves Saint Laurent", "Black Opium"), false);
});

test("matchesBackfillTarget treats a legacy snake-case image_url as 'has image'", () => {
  const row = { brand: "Yves Saint Laurent", name: "Muse", image_url: "https://x/muse.webp" };
  assert.equal(matchesBackfillTarget(row, "Yves Saint Laurent", "Muse"), false);
});

test("matchesBackfillTarget matches across brand-alias spellings (BE-6)", () => {
  // A row stored under "YSL" still heals when the resolve came back as the
  // canonical brand, and vice-versa.
  for (const storedBrand of ["YSL", "Saint Laurent", "yves saint laurent"]) {
    const row = { brand: storedBrand, name: "Libre Le Parfum", imageUrl: "" };
    assert.equal(
      matchesBackfillTarget(row, "Yves Saint Laurent", "Libre Le Parfum"),
      true,
      `stored brand "${storedBrand}" should match`,
    );
  }
});

test("matchesBackfillTarget is case/whitespace-insensitive on name", () => {
  const row = { brand: "Dior", name: "  SAUVAGE ", imageUrl: "" };
  assert.equal(matchesBackfillTarget(row, "Dior", "sauvage"), true);
});

test("matchesBackfillTarget does not bleed across different fragrances or brands", () => {
  const row = { brand: "Dior", name: "Sauvage", imageUrl: "" };
  assert.equal(matchesBackfillTarget(row, "Dior", "Homme"), false, "different name");
  assert.equal(
    matchesBackfillTarget(row, "Chanel", "Sauvage"),
    false,
    "different (non-aliased) brand",
  );
});

test("buildImagePatch carries only image-bearing keys, defaulting imageHash to null", () => {
  assert.deepEqual(buildImagePatch(image), {
    imageUrl: image.imageUrl,
    imageHash: "abc123",
    storagePath: image.storagePath,
    storageProvider: image.storageProvider,
    sourceProvider: image.sourceProvider,
  });

  assert.deepEqual(buildImagePatch({ imageUrl: "https://x/y.webp" }), {
    imageUrl: "https://x/y.webp",
    imageHash: null,
  });
});

test("normalizeBackfillText mirrors SQL lower(trim(x)) and tolerates non-strings", () => {
  assert.equal(normalizeBackfillText("  Cinema "), "cinema");
  assert.equal(normalizeBackfillText(undefined), "");
  assert.equal(normalizeBackfillText(42), "");
});
