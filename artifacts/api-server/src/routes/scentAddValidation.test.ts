import test from "node:test";
import assert from "node:assert/strict";
import { validateScentProfileBody, validateSearchScentBody } from "./scentAddValidation.ts";

// WS-11: add-route hardening. These tests pin the body-shape validation that
// guards POST /scent-profile and POST /search-scent so a malformed payload
// (e.g. notes sent as a string) returns a 400, not an opaque 500.

test("validateScentProfileBody: malformed notes (string instead of array) -> 400 reason", () => {
  const result = validateScentProfileBody({ name: "Aventus", notes: "leather" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /notes/i);
});

test("validateScentProfileBody: notes array containing a non-string -> rejected", () => {
  const result = validateScentProfileBody({ name: "Aventus", notes: ["leather", 7] });
  assert.equal(result.ok, false);
});

test("validateScentProfileBody: missing name -> rejected with name message", () => {
  const result = validateScentProfileBody({ notes: ["leather"] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /name/i);
});

test("validateScentProfileBody: empty/whitespace name -> rejected", () => {
  assert.equal(validateScentProfileBody({ name: "" }).ok, false);
  assert.equal(validateScentProfileBody({ name: "   " }).ok, false);
});

test("validateScentProfileBody: non-object body -> rejected", () => {
  assert.equal(validateScentProfileBody(null).ok, false);
  assert.equal(validateScentProfileBody("Aventus").ok, false);
  assert.equal(validateScentProfileBody(undefined).ok, false);
});

test("validateScentProfileBody: malformed pyramid tier -> 400 with tier message", () => {
  const result = validateScentProfileBody({
    name: "Aventus",
    pyramid: { top: "bergamot", heart: ["rose"] },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /pyramid\.top/i);
});

test("validateScentProfileBody: pyramid as array -> rejected", () => {
  const result = validateScentProfileBody({ name: "Aventus", pyramid: ["top"] });
  assert.equal(result.ok, false);
});

test("validateScentProfileBody: non-string optional field (family) -> rejected", () => {
  const result = validateScentProfileBody({ name: "Aventus", family: 42 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /family/i);
});

test("validateScentProfileBody: fully valid payload passes", () => {
  const result = validateScentProfileBody({
    name: "Aventus",
    brand: "Creed",
    notes: ["pineapple", "birch"],
    family: "Chypre Fruity",
    description: "A pineapple-forward modern classic",
    imageUrl: "https://example.com/a.jpg",
    perfumer: "Olivier Creed",
    concentrationHint: "edp",
    pyramid: { top: ["pineapple"], heart: ["birch"], base: ["musk"] },
  });
  assert.equal(result.ok, true);
});

test("validateScentProfileBody: minimal valid payload (name only) passes", () => {
  assert.equal(validateScentProfileBody({ name: "Aventus" }).ok, true);
});

test("validateScentProfileBody: partial pyramid (only base present) passes", () => {
  const result = validateScentProfileBody({
    name: "Aventus",
    pyramid: { base: ["musk"] },
  });
  assert.equal(result.ok, true);
});

test("validateSearchScentBody: missing query -> rejected", () => {
  const result = validateSearchScentBody({});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /query/i);
});

test("validateSearchScentBody: empty/whitespace query -> rejected", () => {
  assert.equal(validateSearchScentBody({ query: "" }).ok, false);
  assert.equal(validateSearchScentBody({ query: "   " }).ok, false);
});

test("validateSearchScentBody: non-string concentrationHint -> rejected", () => {
  const result = validateSearchScentBody({ query: "Creed Aventus", concentrationHint: 5 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /concentrationHint/i);
});

test("validateSearchScentBody: valid query passes", () => {
  assert.equal(validateSearchScentBody({ query: "Creed Aventus" }).ok, true);
  assert.equal(
    validateSearchScentBody({ query: "Creed Aventus", concentrationHint: "edp" }).ok,
    true,
  );
});
