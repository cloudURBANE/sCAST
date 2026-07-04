import test from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_SOLVER_IDS,
  isImageSolverId,
  isLegacyImageSolverId,
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

test("dupe_interference keeps clone negatives without demanding an exact-phrase title match", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Dior",
    asciiName: "Sauvage",
    concentrationText: "",
    solverId: "dupe_interference",
  });
  // The old exact phrase `"Dior Sauvage"` failed whenever a page title styled
  // the name differently ("Sauvage by Dior") — audit S4. No quoted phrases.
  assert.ok(!r.query.includes('"'), `query still demands an exact phrase: ${r.query}`);
  assert.ok(r.query.includes("Dior Sauvage"));
  assert.ok(r.query.includes("-inspired"));
  assert.ok(r.query.includes("-clone"));
  assert.equal(r.refine, "solver");
});

test("orientation no longer requires the double exact-phrase match (audit S4)", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Chanel",
    asciiName: "Bleu",
    concentrationText: "",
    solverId: "orientation",
  });
  // Requiring BOTH "standing upright" AND "front profile" verbatim returned
  // near-zero image results. Loose positive tokens + tilt negatives instead.
  assert.ok(!r.query.includes('"'), `query still demands exact phrases: ${r.query}`);
  assert.ok(r.query.includes("upright"));
  assert.ok(r.query.includes("-tilted"));
  assert.equal(r.refine, "solver");
});

test("cropped_image no longer requires the exact phrase 'full bottle' (audit S4)", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Chanel",
    asciiName: "Bleu",
    concentrationText: "",
    solverId: "cropped_image",
  });
  assert.ok(!r.query.includes('"'), `query still demands an exact phrase: ${r.query}`);
  assert.ok(r.query.includes("full bottle"));
  assert.ok(r.query.includes("-macro"));
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
  // No solver (plain API refresh) preserves legacy behavior: no exclusion.
  assert.equal(solverPrefersDifferentImage(undefined), false);
});

test("solverWantsFreshProcessing only for the re-processing solvers", () => {
  assert.equal(solverWantsFreshProcessing("transparent_glass"), true);
  assert.equal(solverWantsFreshProcessing("hand_interference"), true);
  // manual_fallback ("skip AI trim") must re-process the source raw — the
  // no-removal cache check accepts ANY cached variant, so without the bypass
  // it hands back the same trimmed cut-out the user is trying to escape.
  assert.equal(solverWantsFreshProcessing("manual_fallback"), true);
  assert.equal(solverWantsFreshProcessing("group_shot"), false);
  assert.equal(solverWantsFreshProcessing(undefined), false);
});

test("pruned no-op solver ids are recognized as legacy, not valid or 400-worthy", () => {
  // abstract_query (unbuilt phase-2 stub) and dark_edge_bleed (promised
  // frontend tweak that was never implemented) sent the unchanged default
  // query with no processing flag — guaranteed end-to-end no-ops (audit #11).
  for (const legacy of ["abstract_query", "dark_edge_bleed"]) {
    assert.equal(isImageSolverId(legacy), false, `${legacy} should no longer be a valid solver id`);
    assert.equal(isLegacyImageSolverId(legacy), true, `${legacy} should be tolerated as a legacy id`);
  }
  assert.equal(isLegacyImageSolverId("group_shot"), false);
  assert.equal(isLegacyImageSolverId("nonsense"), false);
  assert.equal(isLegacyImageSolverId(undefined), false);
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
