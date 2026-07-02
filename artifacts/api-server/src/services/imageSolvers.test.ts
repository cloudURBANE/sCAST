import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_SOLVER_IDS,
  resolveRefreshSerperInput,
  solverPrefersDifferentImage,
  solverSkipsBgRemoval,
  solverWantsFreshProcessing,
  solverWantsPoofProductType,
} from "./imageSolvers.ts";

test("default refresh sends the bare fragrance line and lets the Serper layer own the suffix", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Dior",
    asciiName: "Sauvage",
    concentrationText: "EDP",
  });
  // The route must NOT pre-append its own suffix: the Serper layer appends the
  // default refinement, and a second route-level suffix pushed composed queries
  // past Google's 32-word truncation limit (audit W2 double-suffix defect).
  assert.equal(r.query, "Dior Sauvage EDP");
  assert.equal(r.refine, "default");
});

test("dupe_interference uses quoted brand line and solver refine", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Dior",
    asciiName: "Sauvage",
    concentrationText: "",
    solverId: "dupe_interference",
  });
  assert.ok(r.query.includes('"Dior Sauvage"'));
  assert.ok(r.query.includes("-inspired"));
  assert.equal(r.refine, "solver");
});

test("niche_scraping restricts domains with refine none", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Acme",
    asciiName: "Oud",
    concentrationText: "",
    solverId: "niche_scraping",
  });
  assert.ok(r.query.includes("Acme Oud"));
  assert.ok(r.query.includes("site:fragrantica.com"));
  assert.equal(r.refine, "none");
});

test("box_interference appends negative keywords", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Chanel",
    asciiName: "No5",
    concentrationText: "eau de parfum EDP",
    solverId: "box_interference",
  });
  assert.ok(r.query.includes("Chanel"));
  assert.ok(r.query.includes("-box"));
  assert.equal(r.refine, "solver");
});

test("solverSkipsBgRemoval and solverWantsPoofProductType", () => {
  assert.equal(solverSkipsBgRemoval("manual_fallback"), true);
  assert.equal(solverSkipsBgRemoval(undefined), false);
  assert.equal(solverWantsPoofProductType("transparent_glass"), "product");
  assert.equal(solverWantsPoofProductType("hand_interference"), "product");
  assert.equal(solverWantsPoofProductType(undefined), undefined);
});

test("decant solver does not negate 'ml' (it appears in almost every retail title)", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Creed",
    asciiName: "Aventus",
    concentrationText: "",
    solverId: "decant",
  });
  assert.ok(!/\s-ml\b/.test(r.query), `query still negates ml: ${r.query}`);
  assert.ok(r.query.includes("-decant"));
});

test("solverPrefersDifferentImage: wrong-picture solvers yes, reprocessing solvers no", () => {
  assert.equal(solverPrefersDifferentImage("group_shot"), true);
  assert.equal(solverPrefersDifferentImage("box_interference"), true);
  assert.equal(solverPrefersDifferentImage("tester_bottle"), true);
  // "Picture is right, processing is wrong" solvers keep the current source.
  assert.equal(solverPrefersDifferentImage("transparent_glass"), false);
  assert.equal(solverPrefersDifferentImage("manual_fallback"), false);
  assert.equal(solverPrefersDifferentImage("dark_edge_bleed"), false);
  // No solver (plain API refresh) preserves legacy behavior: no exclusion.
  assert.equal(solverPrefersDifferentImage(undefined), false);
});

test("solverWantsFreshProcessing only for the Poof product-mode solvers", () => {
  assert.equal(solverWantsFreshProcessing("transparent_glass"), true);
  assert.equal(solverWantsFreshProcessing("hand_interference"), true);
  assert.equal(solverWantsFreshProcessing("group_shot"), false);
  assert.equal(solverWantsFreshProcessing(undefined), false);
});

test("no solver query negates a term that its own tokens also assert", () => {
  // A query containing both `-term` and a bare `term` is self-contradictory to
  // Google and returns few or zero image results (audit S1).
  for (const solverId of IMAGE_SOLVER_IDS) {
    const r = resolveRefreshSerperInput({
      asciiBrand: "Chanel",
      asciiName: "Bleu",
      concentrationText: "",
      solverId,
    });
    const words = r.query.split(/\s+/).filter(Boolean);
    const negated = new Set(
      words.filter((w) => w.startsWith("-")).map((w) => w.replace(/^-/, "").replace(/"/g, "").toLowerCase()),
    );
    const positive = words.filter((w) => !w.startsWith("-")).map((w) => w.replace(/"/g, "").toLowerCase());
    for (const p of positive) {
      assert.ok(!negated.has(p), `solver ${solverId}: "${p}" is both asserted and negated in: ${r.query}`);
    }
  }
});
