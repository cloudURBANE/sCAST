import assert from "node:assert/strict";
import test from "node:test";
import { scoreSerperImageCandidate } from "./serperCandidateScoring.ts";

test("scoreSerperImageCandidate accepts retailer EDP titles without perfume/bottle words", () => {
  const retailerPackshot = scoreSerperImageCandidate({
    imageUrl: "https://cdn.twistedlily.com/products/dior-sauvage-edp.png",
    title: "Dior Sauvage EDP 100ml",
    source: "Twisted Lily",
    imageWidth: 800,
    imageHeight: 800,
  });

  assert.ok(Number.isFinite(retailerPackshot), "EDP retailer packshot should pass bottle-signal gate");
  assert.ok(retailerPackshot > 0);
});

test("scoreSerperImageCandidate rejects Instagram lookaside crawler URLs", () => {
  const instagramLookaside = scoreSerperImageCandidate({
    imageUrl: "https://lookaside.instagram.com/seo/google_widget/crawler/?media_id=123",
    title: "Dior Sauvage perfume bottle",
    source: "Instagram",
    imageWidth: 800,
    imageHeight: 800,
  });

  assert.equal(instagramLookaside, -Infinity);
});

test("scoreSerperImageCandidate still rejects unrelated listings without bottle signals", () => {
  const unrelated = scoreSerperImageCandidate({
    imageUrl: "https://cdn.example.com/random-product.png",
    title: "Luxury leather wallet black",
    source: "Fashion store",
    imageWidth: 800,
    imageHeight: 800,
  });

  assert.equal(unrelated, -Infinity);
});
