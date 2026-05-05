import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REFRESH_QUERY_SUFFIX,
  resolveRefreshSerperInput,
  solverSkipsBgRemoval,
  solverWantsPoofProductType,
} from "./imageSolvers.ts";

test("default refresh uses fragrance base + default suffix and refine default", () => {
  const r = resolveRefreshSerperInput({
    asciiBrand: "Dior",
    asciiName: "Sauvage",
    concentrationText: "",
  });
  assert.ok(r.query.startsWith("Dior Sauvage"));
  assert.ok(r.query.includes(DEFAULT_REFRESH_QUERY_SUFFIX));
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
