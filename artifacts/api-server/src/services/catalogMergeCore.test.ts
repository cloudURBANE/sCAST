import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogProfileIsMinimal,
  isRealFamily,
  mergeCatalogProfilePreserveRicher,
} from "./catalogMergeCore.ts";
import type { ScentProfile } from "./scentEngineCore.ts";

function makeProfile(overrides: Partial<ScentProfile> = {}): ScentProfile {
  return {
    product: { name: "Test", brand: "Brand" },
    scent_vector: {
      freshness: 0,
      sweetness: 0,
      woodiness: 0,
      spice: 0,
      warmth: 0,
      musk: 0,
    } as ScentProfile["scent_vector"],
    performance: {} as ScentProfile["performance"],
    context: {} as ScentProfile["context"],
    notes: [],
    family: "Unknown Family",
    concentration: "Unknown",
    accords: [],
    ...overrides,
  };
}

test("isRealFamily rejects empty and Unknown placeholders", () => {
  assert.equal(isRealFamily("Woody"), true);
  assert.equal(isRealFamily("Unknown Family"), false);
  assert.equal(isRealFamily("unknown"), false);
  assert.equal(isRealFamily(""), false);
  assert.equal(isRealFamily(undefined), false);
});

test("catalogProfileIsMinimal: bare pending card is minimal", () => {
  assert.equal(catalogProfileIsMinimal(makeProfile()), true);
});

test("catalogProfileIsMinimal: any of notes/family/image/pyramid/accords lifts it", () => {
  assert.equal(catalogProfileIsMinimal(makeProfile({ notes: ["bergamot"] })), false);
  assert.equal(catalogProfileIsMinimal(makeProfile({ family: "Woody" })), false);
  assert.equal(catalogProfileIsMinimal(makeProfile({ imageUrl: "https://x/y.webp" })), false);
  assert.equal(
    catalogProfileIsMinimal(makeProfile({ pyramid: { top: ["citrus"], heart: [], base: [] } })),
    false,
  );
  assert.equal(catalogProfileIsMinimal(makeProfile({ accords: ["fresh"] })), false);
});

test("merge: a notes enrichment with no image keeps the existing image", () => {
  const existing = makeProfile({
    notes: [],
    family: "Unknown Family",
    imageUrl: "https://cdn/img.webp",
    storagePath: "p/img.webp",
    imageHash: "abc",
    storageProvider: "supabase",
    sourceProvider: "serper",
  });
  const incoming = makeProfile({ notes: ["oud", "rose"], family: "Woody" });

  const merged = mergeCatalogProfilePreserveRicher(existing, incoming);

  assert.deepEqual(merged.notes, ["oud", "rose"]);
  assert.equal(merged.family, "Woody");
  assert.equal(merged.imageUrl, "https://cdn/img.webp");
  assert.equal(merged.storagePath, "p/img.webp");
  assert.equal(merged.imageHash, "abc");
  assert.equal(merged.storageProvider, "supabase");
  assert.equal(merged.sourceProvider, "serper");
});

test("merge: an image refresh with empty notes keeps the existing notes/family", () => {
  const existing = makeProfile({ notes: ["oud", "rose"], family: "Woody", accords: ["smoky"] });
  const incoming = makeProfile({
    notes: [],
    family: "Unknown Family",
    accords: [],
    imageUrl: "https://cdn/new.webp",
    storagePath: "p/new.webp",
  });

  const merged = mergeCatalogProfilePreserveRicher(existing, incoming);

  assert.deepEqual(merged.notes, ["oud", "rose"]);
  assert.equal(merged.family, "Woody");
  assert.deepEqual(merged.accords, ["smoky"]);
  assert.equal(merged.imageUrl, "https://cdn/new.webp");
  assert.equal(merged.storagePath, "p/new.webp");
});

test("merge: incoming wins when it has richer data for the same field", () => {
  const existing = makeProfile({ notes: ["oud"], family: "Woody" });
  const incoming = makeProfile({ notes: ["oud", "rose", "amber"], family: "Amber" });

  const merged = mergeCatalogProfilePreserveRicher(existing, incoming);

  assert.deepEqual(merged.notes, ["oud", "rose", "amber"]);
  assert.equal(merged.family, "Amber");
});
