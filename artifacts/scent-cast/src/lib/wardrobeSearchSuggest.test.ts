import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeFamilyLabel, buildWardrobeSearchSuggestions } from "./wardrobeSearchSuggest.ts";

test("sanitizeFamilyLabel passes real family labels through trimmed", () => {
  assert.equal(sanitizeFamilyLabel("Woody Aromatic"), "Woody Aromatic");
  assert.equal(sanitizeFamilyLabel("  Amber  "), "Amber");
});

test("sanitizeFamilyLabel rejects placeholder junk regardless of case", () => {
  for (const junk of ["Unknown Family", "unknown family", "UNKNOWN", "N/A", "na", "none", "undefined", "null", "", "   "]) {
    assert.equal(sanitizeFamilyLabel(junk), null, `expected ${JSON.stringify(junk)} to sanitize to null`);
  }
});

test("sanitizeFamilyLabel rejects non-string values", () => {
  assert.equal(sanitizeFamilyLabel(undefined), null);
  assert.equal(sanitizeFamilyLabel(null), null);
  assert.equal(sanitizeFamilyLabel(42), null);
});

test("buildWardrobeSearchSuggestions still matches items with placeholder families", () => {
  const items = [
    { id: "1", name: "Sauvage", brand: "Dior", family: "Unknown Family", notes: ["bergamot"] },
  ];
  const suggestions = buildWardrobeSearchSuggestions(items, "sauvage");
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].item.id, "1");
});
