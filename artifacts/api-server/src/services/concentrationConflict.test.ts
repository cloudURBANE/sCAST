import test from "node:test";
import assert from "node:assert/strict";
import {
  concentrationsConflict,
  concentrationsAmbiguouslyAdjacent,
  detectConcentration,
} from "./concentrationConflict.ts";
import {
  shouldSkipSerperCandidateByIdentity,
  scoreProcessedSerperCandidateBreakdown,
} from "./imageCandidateRanking.ts";

test("detectConcentration reads EDP/EDT/Parfum from free text", () => {
  assert.equal(detectConcentration("Bleu de Chanel Eau de Parfum 100ml"), "Eau de Parfum");
  assert.equal(detectConcentration("Bleu de Chanel EDT spray"), "Eau de Toilette");
  assert.equal(detectConcentration("Some Brand Extrait de Parfum"), "Extrait");
  assert.equal(detectConcentration("plain bottle photo"), "Unknown");
});

test("eau de parfum is recognised as EDP, not the looser bare Parfum rule", () => {
  // The ordered table must match the EDP phrase before the bare "parfum" rule.
  assert.equal(detectConcentration("eau de parfum"), "Eau de Parfum");
});

test("Elixir is a first-class concentration, matched before the bare Parfum rule", () => {
  assert.equal(detectConcentration("Dior Sauvage Elixir 60ml"), "Elixir");
  assert.equal(detectConcentration("Sauvage Elixir Parfum"), "Elixir");
});

test("Elixir is in the parfum family, so it is soft-adjacent to a bare Parfum request", () => {
  // An Elixir packshot must still satisfy a bare-"Parfum" request (soft, not hard-skip).
  assert.equal(concentrationsAmbiguouslyAdjacent("Parfum", "Elixir"), true);
  assert.equal(concentrationsAmbiguouslyAdjacent("Elixir", "Parfum"), true);
  // ...but a fresh-tier EDT vs Elixir stays a firm conflict.
  assert.equal(concentrationsAmbiguouslyAdjacent("Eau de Toilette", "Elixir"), false);
});

test("conflict only when both sides are known and differ", () => {
  assert.equal(concentrationsConflict("Eau de Parfum", "Eau de Toilette"), true);
  assert.equal(concentrationsConflict("Eau de Parfum", "Eau de Parfum"), false);
  assert.equal(concentrationsConflict("Unknown", "Eau de Toilette"), false);
  assert.equal(concentrationsConflict("Eau de Parfum", "Unknown"), false);
});

test("ranking skips an EDT candidate for an EDP target despite shared tokens", () => {
  const candidate = {
    imageUrl: "https://cdn.brand.com/bleu-de-chanel-edt-100ml.png",
    title: "Bleu de Chanel Eau de Toilette 100ml",
    source: "Chanel",
    score: 12,
  };
  // Same line tokens, conflicting concentration -> must be skipped.
  assert.equal(shouldSkipSerperCandidateByIdentity("Chanel", "Bleu de Chanel Eau de Parfum", candidate), true);

  const penalty = scoreProcessedSerperCandidateBreakdown({
    brand: "Chanel",
    name: "Bleu de Chanel Eau de Parfum",
    removeBackground: true,
    serperCandidate: candidate,
    processed: { width: 768, height: 768, backgroundRemoved: true, removeBgStatus: "removed" },
  });
  assert.equal(penalty.concentrationPenalty, -10);
});

test("matching concentration is not penalised and earns a phrase bonus", () => {
  const candidate = {
    imageUrl: "https://cdn.brand.com/baccarat-rouge-540-edp.png",
    title: "Maison Francis Kurkdjian Baccarat Rouge 540 Eau de Parfum",
    source: "MFK",
    score: 10,
  };
  const breakdown = scoreProcessedSerperCandidateBreakdown({
    brand: "Maison Francis Kurkdjian",
    name: "Baccarat Rouge 540 Eau de Parfum",
    removeBackground: true,
    serperCandidate: candidate,
    processed: { width: 768, height: 768, backgroundRemoved: true, removeBgStatus: "removed" },
  });
  assert.equal(breakdown.concentrationPenalty, 0);
  assert.equal(breakdown.phraseBonus, 2);
});

test("scattered tokens earn no phrase bonus", () => {
  const candidate = {
    imageUrl: "https://cdn.brand.com/rouge-something-540-baccarat.png",
    title: "540 limited rouge edition baccarat crystal",
    source: "shop",
    score: 5,
  };
  const breakdown = scoreProcessedSerperCandidateBreakdown({
    brand: "Maison Francis Kurkdjian",
    name: "Baccarat Rouge 540",
    removeBackground: true,
    serperCandidate: candidate,
    processed: { width: 768, height: 768, backgroundRemoved: true, removeBgStatus: "removed" },
  });
  assert.equal(breakdown.phraseBonus, 0);
});
