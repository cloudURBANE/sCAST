import assert from "node:assert/strict";
import test from "node:test";
import { scoreSerperImageCandidate } from "./serperCandidateScoring.ts";
import { applySerperRefinement, capQueryWords } from "./serperQueryCore.ts";
import { IMAGE_SOLVER_IDS, resolveRefreshSerperInput } from "./imageSolvers.ts";

test("composed refresh queries never both assert and negate the same term (audit S1)", () => {
  // The old solver suffix ended in "no sample no tester", re-adding the literal
  // words that four solvers negate (`-sample`, `-tester`) — a self-contradictory
  // Google query that returns few or zero image results. Verify the FINAL
  // composed query (solver tokens + Serper suffix) for every solver.
  for (const solverId of IMAGE_SOLVER_IDS) {
    const r = resolveRefreshSerperInput({
      asciiBrand: "Dior",
      asciiName: "Sauvage",
      concentrationText: "EDP",
      solverId,
    });
    const composed = applySerperRefinement(r.query, r.refine);
    const words = composed.split(/\s+/).filter(Boolean);
    const negated = new Set(
      words.filter((w) => w.startsWith("-")).map((w) => w.replace(/^-/, "").replace(/"/g, "").toLowerCase()),
    );
    const positive = words.filter((w) => !w.startsWith("-")).map((w) => w.replace(/"/g, "").toLowerCase());
    for (const p of positive) {
      assert.ok(
        !negated.has(p),
        `solver ${solverId}: "${p}" is both asserted and negated in composed query: ${composed}`,
      );
    }
  }
});

test("composed refresh queries stay within Google's 32-word truncation limit (audit W2)", () => {
  const longBase = resolveRefreshSerperInput({
    asciiBrand: "Maison Francis Kurkdjian",
    asciiName: "Baccarat Rouge 540 Extrait de Parfum Limited Edition",
    concentrationText: "Extrait",
  });
  for (const { query, refine } of [
    longBase,
    resolveRefreshSerperInput({
      asciiBrand: "Dior",
      asciiName: "Sauvage",
      concentrationText: "",
      solverId: "tester_bottle",
    }),
  ]) {
    const composed = applySerperRefinement(query, refine);
    const wordCount = composed.split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount <= 32, `composed query has ${wordCount} words (> 32): ${composed}`);
  }
});

test("capQueryWords keeps the leading base words and trims only the tail", () => {
  assert.equal(capQueryWords("a b c", 32), "a b c");
  assert.equal(capQueryWords("one two three four", 3), "one two three");
  assert.equal(capQueryWords("  spaced   out  ", 32), "spaced out");
});

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

test("scoreSerperImageCandidate admits trusted-host packshots below the old 500px floor", () => {
  // Live Serper dims (YSL Libre / MYSLF / Y "Le Parfum", 2026-06): the official
  // YSL CDN serves 320×320, Sephora 350×350, Macy's 328×400 — all previously
  // `-Infinity`'d by the 500px floor. They must now survive (BE-3).
  for (const c of [
    { imageUrl: "https://www.yslbeautyus.com/libre-le-parfum.png", title: "YSL Libre Le Parfum 3.0 oz", source: "YSL Beauty", imageWidth: 320, imageHeight: 320 },
    { imageUrl: "https://slimages.macysassets.com/ysl-libre.jpg", title: "Yves Saint Laurent Libre Le Parfum Spray", source: "Macy's", imageWidth: 328, imageHeight: 400 },
  ]) {
    const score = scoreSerperImageCandidate(c);
    assert.ok(Number.isFinite(score) && score > 0, `${c.source} ${c.imageWidth}×${c.imageHeight} packshot should pass`);
  }
});

test("scoreSerperImageCandidate still rejects sub-300px thumbnails/icons", () => {
  const tinyIcon = scoreSerperImageCandidate({
    imageUrl: "https://www.sephora.com/sprite/perfume-thumb.png",
    title: "YSL Libre perfume bottle",
    source: "Sephora",
    imageWidth: 120,
    imageHeight: 120,
  });
  assert.equal(tinyIcon, -Infinity);
});
