import test from "node:test";
import assert from "node:assert/strict";
import { detectFlankerMismatch, hasConfidentFlankerMismatch } from "./flankerConflict.ts";
import {
  shouldSkipSerperCandidateByIdentity,
  scoreProcessedSerperCandidateBreakdown,
} from "./imageCandidateRanking.ts";

const processedOk = {
  width: 768,
  height: 768,
  backgroundRemoved: true,
  removeBgStatus: "removed" as const,
};

test("candidate asserting a hard flanker word the target lacks is a confident mismatch", () => {
  const mismatch = detectFlankerMismatch("Dior Sauvage", "Dior Sauvage Elixir 60ml packshot");
  assert.deepEqual(mismatch.hardCandidateAsserts, ["elixir"]);
  assert.equal(hasConfidentFlankerMismatch(mismatch), true);
});

test("candidate merely LACKING a flanker word the target has is never confident (weak direction)", () => {
  const mismatch = detectFlankerMismatch("Dior Homme Intense", "Dior Homme Eau de Toilette 100ml");
  assert.deepEqual(mismatch.candidateLacks, ["intense"]);
  assert.equal(mismatch.hardCandidateAsserts.length, 0);
  assert.equal(hasConfidentFlankerMismatch(mismatch), false);
});

test("matching flanker words on both sides produce no mismatch", () => {
  const mismatch = detectFlankerMismatch("Chanel Allure Homme Sport", "Allure Homme Sport EDT 100ml");
  assert.deepEqual(mismatch.candidateAsserts, []);
  assert.deepEqual(mismatch.candidateLacks, []);
  assert.equal(hasConfidentFlankerMismatch(mismatch), false);
});

test("surface forms of the same flanker never manufacture a conflict (noir/noire, accents)", () => {
  // noire vs noir: same flanker concept.
  const noir = detectFlankerMismatch("Lalique Encre Noire", "Lalique Encre Noir pour homme");
  assert.equal(hasConfidentFlankerMismatch(noir), false);
  assert.deepEqual(noir.candidateLacks, []);

  // "Extrême" accent-folds to "extreme" and matches the target's plain spelling.
  const extreme = detectFlankerMismatch("Jimmy Choo Man Extreme", "Jimmy Choo Man Extrême EDT");
  assert.equal(hasConfidentFlankerMismatch(extreme), false);
  assert.deepEqual(extreme.candidateLacks, []);
});

test("soft flanker words (extrait, summer) are asserted but never confident", () => {
  // Niche houses sell their MAINLINE as an extrait — the correct packshot for
  // "Nishane Hacivat" is titled "… Extrait de Parfum" and must survive.
  const extrait = detectFlankerMismatch("Nishane Hacivat", "Nishane Hacivat Extrait de Parfum 100ml");
  assert.deepEqual(extrait.candidateAsserts, ["extrait"]);
  assert.deepEqual(extrait.hardCandidateAsserts, []);
  assert.equal(hasConfidentFlankerMismatch(extrait), false);

  // Seasonal retailer decoration must not disqualify the right bottle.
  const summer = detectFlankerMismatch("Dior Sauvage", "Dior Sauvage EDP 100ml | Summer Sale");
  assert.deepEqual(summer.candidateAsserts, ["summer"]);
  assert.equal(hasConfidentFlankerMismatch(summer), false);
});

test("gender is opposition-only: decorative 'for men' never conflicts, opposite gender does", () => {
  // Retailers decorate masculine listings freely — no target gender, no conflict.
  const decorative = detectFlankerMismatch("Dior Sauvage", "Dior Sauvage EDT for Men");
  assert.equal(decorative.genderOpposition, false);

  // Unisex titles assert both sides and oppose nothing.
  const unisex = detectFlankerMismatch("Dior Homme", "Dior Homme fragrance for men and women");
  assert.equal(unisex.genderOpposition, false);

  // Target masculine vs candidate feminine IS a wrong bottle.
  const opposed = detectFlankerMismatch("Dior Homme", "Dior perfume pour femme 50ml");
  assert.equal(opposed.genderOpposition, true);
  assert.equal(hasConfidentFlankerMismatch(opposed), true);
});

test("ranking hard-skips the wrong flanker despite full line-token coverage (audit W4)", () => {
  // "elixir" is an identity-tokenizer stopword and the target carries no
  // concentration, so before the flanker check this candidate had coverage 1.0
  // and zero penalties — the exact W4 failure.
  const wrongFlanker = {
    imageUrl: "https://cdn.sephora.com/dior-sauvage-elixir-60ml.png",
    title: "Dior Sauvage Elixir 60ml",
    source: "Sephora",
    score: 12,
  };
  assert.equal(shouldSkipSerperCandidateByIdentity("Dior", "Sauvage", wrongFlanker), true);

  // …and the matching flanker on both sides is untouched.
  const rightFlanker = {
    imageUrl: "https://cdn.sephora.com/dior-sauvage-elixir-60ml.png",
    title: "Dior Sauvage Elixir Parfum 60ml",
    source: "Sephora",
    score: 12,
  };
  assert.equal(shouldSkipSerperCandidateByIdentity("Dior", "Sauvage Elixir", rightFlanker), false);
  const breakdown = scoreProcessedSerperCandidateBreakdown({
    brand: "Dior",
    name: "Sauvage Elixir",
    removeBackground: true,
    serperCandidate: rightFlanker,
    processed: processedOk,
  });
  assert.equal(breakdown.flankerPenalty, 0);
});

test("ranking hard-skips a sport flanker for the plain target and an opposite-gender candidate", () => {
  const sport = {
    imageUrl: "https://cdn.chanel.com/allure-homme-sport.png",
    title: "Chanel Allure Homme Sport Eau de Toilette",
    source: "Chanel",
    score: 12,
  };
  assert.equal(shouldSkipSerperCandidateByIdentity("Chanel", "Allure Homme", sport), true);

  const femme = {
    imageUrl: "https://cdn.example.com/dior-pour-femme.png",
    title: "Dior pour Femme perfume 50ml",
    source: "Retailer",
    score: 12,
  };
  assert.equal(shouldSkipSerperCandidateByIdentity("Dior", "Homme", femme), true);
});

test("the weak direction only demotes: plain bottle for a flanker target is penalised, not skipped", () => {
  // Target "Dior Homme Intense", candidate the plain "Dior Homme" — the
  // candidate lacking the word is weaker evidence (terse titles exist), so it
  // must stay in the race but lose to a candidate that carries the word.
  const plain = {
    imageUrl: "https://cdn.dior.com/dior-homme-edt.png",
    title: "Dior Homme Eau de Toilette 100ml",
    source: "Dior",
    score: 12,
  };
  assert.equal(shouldSkipSerperCandidateByIdentity("Dior", "Homme Intense", plain), false);
  const breakdown = scoreProcessedSerperCandidateBreakdown({
    brand: "Dior",
    name: "Homme Intense",
    removeBackground: true,
    serperCandidate: plain,
    processed: processedOk,
  });
  assert.equal(breakdown.flankerPenalty, -6);

  // The -6 must outweigh the +5 trusted-host edge: given equal processing, the
  // correct flanker candidate outscores the plain bottle.
  const correct = {
    imageUrl: "https://cdn.notino.com/dior-homme-intense-edp.png",
    title: "Dior Homme Intense Eau de Parfum 100ml",
    source: "Notino",
    score: 7, // no trusted-host bonus (12 - 5)
  };
  const correctBreakdown = scoreProcessedSerperCandidateBreakdown({
    brand: "Dior",
    name: "Homme Intense",
    removeBackground: true,
    serperCandidate: correct,
    processed: processedOk,
  });
  assert.equal(correctBreakdown.flankerPenalty, 0);
  assert.ok(
    correctBreakdown.total > breakdown.total,
    `correct flanker (${correctBreakdown.total}) must outrank trusted-host plain bottle (${breakdown.total})`,
  );
});

test("flanker evidence includes the URL slug, so a terse title with a correct slug is not penalised", () => {
  const terse = {
    imageUrl: "https://cdn.notino.com/dior-homme-intense-edp.png",
    title: "Dior fragrance",
    source: "Notino",
    score: 7,
  };
  const breakdown = scoreProcessedSerperCandidateBreakdown({
    brand: "Dior",
    name: "Homme Intense",
    removeBackground: true,
    serperCandidate: terse,
    processed: processedOk,
  });
  assert.equal(breakdown.flankerPenalty, 0);
});
