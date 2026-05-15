import assert from "node:assert/strict";
import test from "node:test";
import {
  isFragranceDetailEffectivelyComplete,
  normalizeFragranceDetail,
  normalizeFragranceSearchResult,
} from "./fragranceApi.ts";

test("normalizeFragranceSearchResult preserves source-url-only candidates", () => {
  const result = normalizeFragranceSearchResult(
    {
      name: "Sauvage",
      brand: "Dior",
      source_url: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
    },
    "Dior Sauvage",
  );

  assert.equal(result?.id, "source:https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html");
  assert.equal(result?.name, "Sauvage");
  assert.equal(result?.brand, "Dior");
  assert.equal(result?.house, "Dior");
});

test("normalizeFragranceSearchResult coerces non-string ids", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: 31861,
      title: "Sauvage",
      designer: "Dior",
    },
    "Dior Sauvage",
  );

  assert.equal(result?.id, "31861");
  assert.equal(result?.name, "Sauvage");
  assert.equal(result?.house, "Dior");
});

test("normalizeFragranceDetail marks derived metrics as complete without losing partial coverage", () => {
  const detail = normalizeFragranceDetail({
    name: "Sauvage",
    house: "Dior",
    source_coverage: {
      complete: false,
      fragrantica: true,
      derived_metrics: "partial",
    },
    derived_metrics: {
      headline: { summary: "Fresh spicy amber woods." },
    },
  });

  assert.equal(detail.source_coverage?.complete, true);
  assert.equal(detail.source_coverage?.fragrantica, true);
  assert.equal(detail.source_coverage?.derived_metrics, "complete");
  assert.equal(isFragranceDetailEffectivelyComplete(detail), true);
});
