import assert from "node:assert/strict";
import test from "node:test";
import {
  getFragranceDetails,
  isBackgroundEnrichmentQueued,
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

test("pending worker enrichment is queued background work, not completed coverage", () => {
  const detail = normalizeFragranceDetail({
    name: "Sauvage",
    house: "Dior",
    source_coverage: {
      complete: false,
    },
    enrichment: {
      status: "pending",
      requires_worker: true,
    },
  });

  assert.equal(detail.source_coverage?.complete, false);
  assert.equal(isFragranceDetailEffectivelyComplete(detail), false);
  assert.equal(isBackgroundEnrichmentQueued(detail.enrichment), true);
});

test("terminal enrichment status is not treated as queued even with worker flag", () => {
  assert.equal(
    isBackgroundEnrichmentQueued({
      status: "failed",
      requires_worker: true,
    }),
    false,
  );
});

test("getFragranceDetails posts opaque id with source_url when both are available", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ name: "Silver Mountain Water" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: previousFetch,
    });
    if (previousApiUrl === undefined) {
      delete process.env.VITE_FRAGRANCE_API_URL;
    } else {
      process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    }
  });

  await getFragranceDetails({
    id: "opaque-token",
    source_url: "https://www.fragrantica.com/perfume/Creed/Silver-Mountain-Water-472.html",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.test/api/fragrances/details");
  assert.equal(requests[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    id: "opaque-token",
    source_url: "https://www.fragrantica.com/perfume/Creed/Silver-Mountain-Water-472.html",
  });
});
