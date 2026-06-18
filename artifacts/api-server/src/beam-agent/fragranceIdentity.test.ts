import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOwnedFragranceIndex,
  findOwnedVaultItem,
  isOwnedFragrance,
  normalizeFragranceIdentityPart,
} from "./fragranceIdentity.ts";

test("normalizes punctuation and diacritics in fragrance names", () => {
  assert.equal(
    normalizeFragranceIdentityPart("L’Eau d’Issey"),
    "l eau d issey",
  );
  assert.equal(normalizeFragranceIdentityPart("Égoïste"), "egoiste");
});

test("matches known house aliases without weakening the fragrance name", () => {
  const index = buildOwnedFragranceIndex([
    { id: "1", brand: "Yves Saint Laurent", name: "Y Eau de Parfum" },
  ]);
  assert.equal(isOwnedFragrance(index, "YSL", "Y Eau de Parfum"), true);
  assert.equal(isOwnedFragrance(index, "YSL", "Y Le Parfum"), false);
});

test("handles missing brands conservatively and rejects ambiguous bare names", () => {
  const index = buildOwnedFragranceIndex([
    { id: "1", brand: "House A", name: "Homme" },
    { id: "2", brand: "House B", name: "Homme" },
    { id: "3", name: "Unbranded Scent" },
  ]);
  assert.equal(isOwnedFragrance(index, undefined, "Homme"), false);
  assert.equal(isOwnedFragrance(index, "House A", "Homme"), true);
  assert.equal(isOwnedFragrance(index, "Any House", "Unbranded Scent"), true);
});

test("owned fallback requires exact brand and name instead of substring matching", () => {
  const vault = [
    { id: "1", brand: "Dior", name: "Dior Homme" },
    { id: "2", brand: "Guerlain", name: "L'Homme Ideal" },
  ];
  assert.equal(findOwnedVaultItem(vault, "Guerlain", "L'Homme Ideal")?.id, "2");
  assert.equal(findOwnedVaultItem(vault, undefined, "Homme"), undefined);
});
