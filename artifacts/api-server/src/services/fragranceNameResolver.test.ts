import test from "node:test";
import assert from "node:assert/strict";
import {
  asciiForImageSearch,
  fragranceCatalogSearchTerms,
  hasMeaningfulFragranceQuery,
  isLikelySameFragranceIdentity,
  resolveFragranceIdentity,
  resolveFragranceQuery,
  scoreFragranceCandidate,
  searchFragranceDataset,
  shouldSearchExternalFragranceSources,
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

test("strips retail bottle size and spray noise before canonical matching", () => {
  const resolved = resolveFragranceIdentity("Dior", "Sauvage Eau de Parfum 100 ml / 3.4 oz Spray");
  assert.equal(resolved.brand, "Dior");
  assert.equal(resolved.name, "Sauvage");
  assert.equal(resolved.corrected, true);
});

test("keeps edition words while removing size noise without a dataset hit", () => {
  const resolved = resolveFragranceIdentity("Creed", "Aventus Cologne 100ml Tester Spray");
  assert.equal(resolved.brand, "Creed");
  assert.equal(resolved.name, "Aventus Cologne");
  assert.equal(resolved.corrected, true);
});

test("formats unknown fallback names by cutting retail suffixes", () => {
  const resolved = resolveFragranceIdentity("Imaginary House", "Moon Water EDP 50ml Natural Spray");
  assert.equal(resolved.brand, "Imaginary House");
  assert.equal(resolved.name, "Moon Water");
  assert.equal(resolved.confidence, 0);
  assert.equal(resolved.corrected, true);
});

test("removes redundant long and short concentration labels from names", () => {
  const resolved = resolveFragranceIdentity("Dior", "Sauvage Eau de Toilette EDT");
  assert.equal(resolved.name, "Sauvage");
  assert.equal(resolved.corrected, true);
});

test("resolves typed search query while ignoring image-search filler words", () => {
  const resolved = resolveFragranceQuery("sauvaj dior bottle image search");
  assert.equal(resolved?.brand, "Dior");
  assert.equal(resolved?.name, "Sauvage");
});

test("external search is fragrance-gated", () => {
  assert.equal(shouldSearchExternalFragranceSources("running shoes"), false);
  assert.equal(shouldSearchExternalFragranceSources("blue jeans"), false);
  assert.equal(shouldSearchExternalFragranceSources("versace blue jeans"), true);
  assert.equal(shouldSearchExternalFragranceSources("moon water perfume"), true);
  assert.equal(shouldSearchExternalFragranceSources("French Avenue Liquid Brun"), true);
  assert.equal(shouldSearchExternalFragranceSources("sauvaj dior"), true);
  assert.equal(shouldSearchExternalFragranceSources("sauvage elixir"), true);
});

test("formats non-ascii names for image search", () => {
  assert.equal(asciiForImageSearch("Bleu de Ch\u00e1nel"), "Bleu de Chanel");
});

test("category-only fragrance words are too vague to resolve or score", () => {
  for (const query of ["perfume", "fragrance", "cologne", "elixir", "show me a bottle"]) {
    assert.equal(resolveFragranceQuery(query), null);
    assert.equal(shouldSearchExternalFragranceSources(query), false);
    assert.equal(hasMeaningfulFragranceQuery(query), false);
    assert.deepEqual(fragranceCatalogSearchTerms(query), []);
    assert.deepEqual(searchFragranceDataset(query), []);
  }

  assert.equal(
    scoreFragranceCandidate("cologne", { brand: "Creed", name: "Aventus Cologne" }).matched,
    false,
  );
  assert.equal(
    scoreFragranceCandidate("elixir", { brand: "Dior", name: "Sauvage Elixir" }).matched,
    false,
  );
});

test("non-fragrance inputs and brand-only queries do not pass fuzzy scoring", () => {
  assert.equal(resolveFragranceQuery("running shoes"), null);
  assert.equal(shouldSearchExternalFragranceSources("running shoes"), false);
  assert.equal(scoreFragranceCandidate("running shoes", { brand: "Dior", name: "Sauvage" }).matched, false);
  assert.equal(scoreFragranceCandidate("Dior", { brand: "Dior", name: "Sauvage" }).matched, false);
  assert.equal(shouldSearchExternalFragranceSources("rouge lipstick"), false);
  assert.deepEqual(searchFragranceDataset("rouge lipstick"), []);
});

test("scorer rejects omitted flanker tokens while allowing concentration aliases", () => {
  assert.equal(
    scoreFragranceCandidate("Dior Sauvage", { brand: "Dior", name: "Sauvage Elixir" }).matched,
    false,
  );
  assert.equal(
    scoreFragranceCandidate("Dior Sauvage EDP", { brand: "Dior", name: "Sauvage" }).matched,
    true,
  );
  assert.equal(
    scoreFragranceCandidate("Baccarat", { brand: "Maison Francis Kurkdjian", name: "Baccarat Rouge 540" }).matched,
    false,
  );
  assert.equal(
    scoreFragranceCandidate("Baccarat Rouge", { brand: "Maison Francis Kurkdjian", name: "Baccarat Rouge 540" }).matched,
    true,
  );
  assert.equal(
    isLikelySameFragranceIdentity(
      { brand: "Dior", name: "Sauvage" },
      { brand: "Dior", name: "Sauvage Elixir" },
    ),
    false,
  );
});
