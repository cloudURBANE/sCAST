import test from "node:test";
import assert from "node:assert/strict";
import {
  asciiForImageSearch,
  resolveFragranceIdentity,
  resolveFragranceQuery,
} from "./fragranceNameResolver.ts";

test("resolves misspelled image identity to canonical dataset name", () => {
  const resolved = resolveFragranceIdentity("Dior", "Savauge");
  assert.equal(resolved.brand, "Dior");
  assert.equal(resolved.name, "Sauvage");
  assert.equal(resolved.corrected, true);
  assert.ok(resolved.confidence >= 0.8);
});

test("does not drop meaningful edition words during canonicalization", () => {
  const resolved = resolveFragranceIdentity("Creed", "Aventus Cologne");
  assert.equal(resolved.brand, "Creed");
  assert.equal(resolved.name, "Aventus Cologne");
  assert.equal(resolved.corrected, false);
});

test("resolves typed search query while ignoring image-search filler words", () => {
  const resolved = resolveFragranceQuery("sauvaj dior bottle image search");
  assert.equal(resolved?.brand, "Dior");
  assert.equal(resolved?.name, "Sauvage");
});

test("formats non-ascii names for image search", () => {
  assert.equal(asciiForImageSearch("Bleu de Chánel"), "Bleu de Chanel");
});
