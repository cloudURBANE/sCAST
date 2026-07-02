import assert from "node:assert/strict";
import test from "node:test";
import {
  computeFragranceIdentityCoverage,
  shouldSkipSerperCandidateByIdentity,
} from "./imageCandidateRanking.ts";

test("identity coverage no longer credits unrelated words via substring matching (audit W5)", () => {
  // "oud" must not match "loud", "noir" must not match "renoir".
  const oudVsLoud = computeFragranceIdentityCoverage("Acme", "Oud Royale", {
    imageUrl: "https://cdn.example.com/img.png",
    title: "Loud speaker royale edition",
    source: "Electronics store",
  });
  assert.ok(oudVsLoud < 1, `"loud" should not satisfy the "oud" token (coverage ${oudVsLoud})`);

  const noirVsRenoir = computeFragranceIdentityCoverage("Lalique", "Encre Noire", {
    imageUrl: "https://cdn.example.com/img.png",
    title: "Renoir encre painting print",
    source: "Art store",
  });
  assert.ok(noirVsRenoir < 1, `"renoir" should not satisfy "noire" (coverage ${noirVsRenoir})`);
});

test("identity coverage still tolerates short inflectional tails (plural/genitive)", () => {
  const coverage = computeFragranceIdentityCoverage("Dior", "Sauvage", {
    imageUrl: "https://cdn.example.com/dior.png",
    title: "Dior Sauvages collection",
    source: "Retailer",
  });
  assert.equal(coverage, 1, `plural "sauvages" should satisfy "sauvage" (coverage ${coverage})`);
});

test("exact-match identity coverage is unchanged", () => {
  const coverage = computeFragranceIdentityCoverage("Chanel", "Bleu de Chanel", {
    imageUrl: "https://cdn.example.com/bleu.png",
    title: "Chanel Bleu de Chanel EDP 100ml",
    source: "Sephora",
  });
  assert.equal(coverage, 1);
});

test("low-identity candidates are still hard-skipped below the 0.34 floor", () => {
  const skip = shouldSkipSerperCandidateByIdentity("Maison Francis Kurkdjian", "Baccarat Rouge 540", {
    imageUrl: "https://cdn.example.com/random.png",
    title: "Gucci Bloom garden edition",
    source: "Marketplace",
  });
  assert.equal(skip, true);
});
