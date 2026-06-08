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

test("scoreSerperImageCandidate rejects listings whose title names a box", () => {
  for (const title of [
    "Dior Sauvage EDP 100ml with box",
    "Chanel Bleu de Chanel bottle and box",
    "Versace Eros coffret gift set",
    "Tom Ford Oud Wood gift box packaging",
  ]) {
    const boxed = scoreSerperImageCandidate({
      imageUrl: "https://cdn.example.com/perfume.png",
      title,
      source: "Marketplace",
      imageWidth: 800,
      imageHeight: 800,
    });
    assert.equal(boxed, -Infinity, `expected "${title}" to be rejected`);
  }
});

test("scoreSerperImageCandidate prefers a portrait bottle over a wide box+bottle shot", () => {
  const base = {
    imageUrl: "https://cdn.example.com/dior-sauvage-edp.png",
    title: "Dior Sauvage EDP 100ml",
    source: "Twisted Lily",
  };

  const portraitBottle = scoreSerperImageCandidate({
    ...base,
    imageWidth: 700,
    imageHeight: 1000, // aspect 0.7 — tall, single-bottle shaped
  });
  const wideComposition = scoreSerperImageCandidate({
    ...base,
    imageWidth: 1000,
    imageHeight: 700, // aspect ~1.43 — wide, often bottle + carton
  });

  assert.ok(Number.isFinite(portraitBottle));
  assert.ok(Number.isFinite(wideComposition));
  assert.ok(
    portraitBottle > wideComposition,
    `portrait (${portraitBottle}) should outrank wide (${wideComposition})`,
  );
});
