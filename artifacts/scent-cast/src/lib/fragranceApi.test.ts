import assert from "node:assert/strict";
import test from "node:test";
import type { DerivedMetrics } from "./fragranceApi.ts";
import {
  collectMainAccordDisplayRows,
  getFragranceDetails,
  isBackgroundEnrichmentQueued,
  isFragranceDetailEffectivelyComplete,
  normalizeFragranceDetail,
  normalizeFragranceSearchResult,
  normalizedAccordBarPct,
  requeueFragranceDetails,
  resolveMainAccordChartRows,
  resolveSourceStatus,
  searchFragrances,
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
  assert.equal(result?.origin, "srt");
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
  assert.equal(result?.origin, "srt");
});

test("normalizeFragranceSearchResult recovers house from source URL", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: "opaque-token",
      name: "Liquid Brun",
      source_url: "https://www.fragrantica.com/perfume/French-Avenue/Liquid-Brun-94713.html",
    },
    "Liquid Brun",
  );

  assert.equal(result?.name, "Liquid Brun");
  assert.equal(result?.house, "French Avenue");
  assert.equal(result?.brand, "French Avenue");
  assert.equal(
    result?.source_url,
    "https://www.fragrantica.com/perfume/French-Avenue/Liquid-Brun-94713.html",
  );
});

test("normalizeFragranceSearchResult recovers house from source id", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: "source:https://www.fragrantica.com/perfume/Tom-Ford/Oud-Wood-1826.html",
      name: "Oud Wood",
    },
    "Oud Wood",
  );

  assert.equal(result?.house, "Tom Ford");
  assert.equal(result?.brand, "Tom Ford");
  assert.equal(result?.source_url, "https://www.fragrantica.com/perfume/Tom-Ford/Oud-Wood-1826.html");
});

test("normalizeFragranceSearchResult recovers house from catalog id", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: "catalog:Maison%20Francis%20Kurkdjian::Baccarat%20Rouge%20540",
    },
    "Baccarat",
    "app",
  );

  assert.equal(result?.name, "Baccarat Rouge 540");
  assert.equal(result?.house, "Maison Francis Kurkdjian");
  assert.equal(result?.brand, "Maison Francis Kurkdjian");
  assert.equal(result?.origin, "app");
});

test("normalizeFragranceSearchResult recovers house from SRT opaque id", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: "eyJuIjoiTGlxdWlkIEJydW4iLCJiIjoiRnJlbmNoIEF2ZW51ZSIsInkiOiIyMDI0IiwiYm4iOiIiLCJmZyI6Imh0dHBzOi8vd3d3LmZyYWdyYW50aWNhLmNvbS9wZXJmdW1lL0ZyZW5jaC1BdmVudWUvTGlxdWlkLUJydW4tOTQ3MTMuaHRtbCJ9",
    },
    "Liquid Brun",
  );

  assert.equal(result?.name, "Liquid Brun");
  assert.equal(result?.house, "French Avenue");
  assert.equal(result?.brand, "French Avenue");
});

test("normalizeFragranceSearchResult reads nested product identity", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: "nested-product",
      product: {
        name: "Another 13",
        brand: "Le Labo",
      },
    },
    "Another 13",
    "app",
  );

  assert.equal(result?.name, "Another 13");
  assert.equal(result?.house, "Le Labo");
  assert.equal(result?.brand, "Le Labo");
});

test("normalizeFragranceSearchResult preserves quality metrics", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: "vetted-scent",
      name: "Aventus",
      brand: "Creed",
      bn_positive_pct: 85,
      bn_vote_count: 1200,
    },
    "Creed Aventus",
  );

  assert.equal(result?.bn_positive_pct, 85);
  assert.equal(result?.bn_vote_count, 1200);
});

test("normalizeFragranceDetail does not complete without both source signals", () => {
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

  assert.equal(detail.source_coverage?.complete, false);
  assert.equal(detail.source_coverage?.fragrantica, true);
  assert.equal(detail.source_coverage?.derived_metrics, "partial");
  assert.equal(isFragranceDetailEffectivelyComplete(detail), false);
});

test("normalizeFragranceDetail treats complete Fragrantica metrics as display complete", () => {
  const detail = normalizeFragranceDetail({
    name: "Santal 33",
    house: "Le Labo",
    source_coverage: {
      complete: false,
      basenotes: false,
      fragrantica: true,
      fragrantica_metrics_complete: true,
      derived_metrics: "partial",
    },
    derived_metrics: {
      headline: { summary: "Woody aromatic musk." },
    },
  });
  const status = resolveSourceStatus(detail.source_coverage, detail.enrichment);

  assert.equal(detail.source_coverage?.complete, true);
  assert.equal(isFragranceDetailEffectivelyComplete(detail), true);
  assert.equal(status.complete, true);
  assert.equal(status.badgeLabel, "Complete");
  assert.equal(status.metricsLabel, "Metrics ready");
});

test("resolveSourceStatus keeps stale complete flags partial without both sources", () => {
  const detail = normalizeFragranceDetail({
    name: "Sauvage",
    house: "Dior",
    source_coverage: {
      basenotes: false,
      fragrantica: false,
      complete: true,
      derived_metrics: "complete",
    },
    enrichment: {
      status: "not_needed",
      message: "Provisional fragrance profile available.",
    },
    derived_metrics: {
      headline: { summary: "Fresh spicy amber woods." },
    },
  });
  const status = resolveSourceStatus(detail.source_coverage, detail.enrichment);

  assert.equal(detail.source_coverage?.complete, false);
  assert.equal(status.complete, false);
  assert.equal(status.badgeLabel, "Partial");
  assert.equal(status.statusText, "Community-source profile available. Some source data is still pending.");
  assert.equal(status.sourceCountLabel, "Sources 0 of 2");
  assert.equal(status.metricsLabel, "Metrics pending");

  const staleTerminalStatus = resolveSourceStatus(detail.source_coverage, {
    status: "not_needed",
  });

  assert.equal(staleTerminalStatus.enrichmentMessage, null);
  assert.equal(staleTerminalStatus.shouldShowEnrichmentMessage, false);
});

test("normalizeFragranceDetail completes with both source signals and complete metrics", () => {
  const detail = normalizeFragranceDetail({
    name: "Sauvage",
    house: "Dior",
    source_coverage: {
      complete: true,
      basenotes: true,
      fragrantica: true,
      derived_metrics: "full",
    },
    derived_metrics: {
      headline: { summary: "Fresh spicy amber woods." },
    },
  });

  assert.equal(detail.source_coverage?.complete, true);
  assert.equal(detail.source_coverage?.basenotes, true);
  assert.equal(detail.source_coverage?.fragrantica, true);
  assert.equal(detail.source_coverage?.derived_metrics, "full");
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
  assert.equal(
    isBackgroundEnrichmentQueued({
      status: "complete",
      requires_worker: true,
    }),
    false,
  );
});

test("getFragranceDetails posts opaque id and source URL to SRT details", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
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

test("requeueFragranceDetails posts force refresh to SRT engine", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test/";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({ queued: true, job: { id: "job-1", status: "pending" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  const response = await requeueFragranceDetails({
    id: "opaque-token",
    source_url: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
    priority: 10,
  });

  assert.equal(response.queued, true);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://engine.example.test/api/fragrances/details/requeue",
  );
  assert.equal(requests[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    id: "opaque-token",
    source_url: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
    priority: 10,
  });
});

test("searchFragrances uses same-origin engine proxy when app API base is unset", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  delete process.env.VITE_API_BASE_URL;
  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          query: "Dior Sauvage",
          results: [
            {
              id: "opaque-token",
              name: "Sauvage Eau de Parfum",
              house: "Christian Dior",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  await searchFragrances("Dior Sauvage");

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "/api/engine/fragrances/search?q=Dior%20Sauvage",
  );
});

test("searchFragrances uses the fragrance engine API instead of the app API", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          query: "Dior Sauvage",
          results: [
            {
              id: "opaque-token",
              name: "Sauvage Eau de Parfum",
              house: "Christian Dior",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  const response = await searchFragrances("Dior Sauvage");

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://engine.example.test/api/fragrances/search?q=Dior%20Sauvage",
  );
  assert.equal(response.results[0]?.id, "opaque-token");
  assert.equal(response.results[0]?.origin, "srt");
});

test("searchFragrances supplements degraded SRT breadth with app API results", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (String(url).startsWith("https://engine.example.test")) {
        return new Response(
          JSON.stringify({
            query: "creed",
            results: [
              { id: "srt-aventus", name: "Aventus", house: "Creed" },
              { id: "srt-smw", name: "Silver Mountain Water", house: "Creed" },
            ],
            diagnostics: {
              result_count: 2,
              fallback_source: "db",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          query: "creed",
          results: [
            { id: "catalog:Creed::Aventus", name: "Aventus", brand: "Creed" },
            { id: "catalog:Creed::Green Irish Tweed", name: "Green Irish Tweed", brand: "Creed" },
            {
              id: "weak-source",
              name: "Aventus Product Page",
              source_url: "https://example.test/products/aventus-product-page",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  const response = await searchFragrances("creed");

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://engine.example.test/api/fragrances/search?q=creed",
      "https://app-api.example.test/api/fragrances/search?q=creed",
    ],
  );
  assert.equal(response.results.length, 3);
  assert.equal(response.results[0]?.id, "srt-aventus");
  assert.equal(response.results[0]?.origin, "srt");
  assert.equal(response.results[2]?.id, "catalog:Creed::Green Irish Tweed");
  assert.equal(response.results[2]?.origin, "app");
  assert.equal(response.diagnostics?.fallback_source, "db");
});

test("searchFragrances caches non-empty supplemented responses", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  const requests: string[] = [];
  const localStorageData = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageData.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageData.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageData.delete(key);
    },
    clear: () => {
      localStorageData.clear();
    },
  };

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      requests.push(url);
      if (String(url).startsWith("https://engine.example.test")) {
        return new Response(
          JSON.stringify({
            query: "creed",
            results: [{ id: "srt-aventus", name: "Aventus", house: "Creed" }],
            diagnostics: { result_count: 1, fallback_source: "identity" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          query: "creed",
          results: [
            { id: "catalog:Creed::Green Irish Tweed", name: "Green Irish Tweed", brand: "Creed" },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: previousFetch,
    });
    if (previousWindow === undefined) {
      delete (globalThis as typeof globalThis & { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
    if (previousApiUrl === undefined) {
      delete process.env.VITE_FRAGRANCE_API_URL;
    } else {
      process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    }
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  const first = await searchFragrances("creed");
  const second = await searchFragrances("creed");

  assert.deepEqual(requests, [
    "https://engine.example.test/api/fragrances/search?q=creed",
    "https://app-api.example.test/api/fragrances/search?q=creed",
  ]);
  assert.deepEqual(
    second.results.map((result) => result.id),
    first.results.map((result) => result.id),
  );
  assert.equal(second.results.length, 2);
});

test("searchFragrances drops non-fragrance archive rows with generated display names", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      return new Response(
        JSON.stringify({
          query: "Yves Saint Laurent Libre",
          results: [
            { id: "libre", name: "Libre", house: "Yves Saint Laurent" },
            { id: "archive-comment", name: "1avmxj5", brand: "Comments" },
            { id: "dior-stale", name: "J'adore Eau de Toilette 2002", house: "Dior" },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  const response = await searchFragrances("Yves Saint Laurent Libre");

  assert.deepEqual(
    response.results.map((result) => `${result.house}:${result.name}`),
    ["Yves Saint Laurent:Libre"],
  );
});

test("searchFragrances drops brand-only catalog archive rows", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      if (String(url).startsWith("https://engine.example.test")) {
        return new Response(
          JSON.stringify({
            query: "xerjof",
            results: [],
            diagnostics: { result_count: 0 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          query: "xerjof",
          results: [
            {
              id: "catalog:Xerjoff::Xerjoff",
              name: "Xerjoff",
              house: "Xerjoff",
              brand: "Xerjoff",
              source_url: null,
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  const response = await searchFragrances("xerjof");

  assert.deepEqual(response.results, []);
});

test("getFragranceDetails keeps catalog ids on the app API", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ name: "Sauvage", house: "Dior" }), {
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  await getFragranceDetails({ id: "catalog:Dior::Sauvage" });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://app-api.example.test/api/fragrances/details");
});

test("getFragranceDetails routes app-origin source URLs to the app API", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ name: "Aventus", house: "Creed" }), {
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
    if (previousAppApiUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousAppApiUrl;
    }
  });

  await getFragranceDetails({
    source_url: "https://www.fragrantica.com/perfume/Creed/Aventus-9828.html",
    origin: "app",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://app-api.example.test/api/fragrances/details");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    source_url: "https://www.fragrantica.com/perfume/Creed/Aventus-9828.html",
  });
});

test("normalizedAccordBarPct maps 0–10 axis scores onto bar widths", () => {
  assert.equal(normalizedAccordBarPct({ label: "Warmth", score: 10 }), 100);
  assert.equal(normalizedAccordBarPct({ label: "Warmth", score: 5 }), 50);
});

test("normalizedAccordBarPct bumps tiny pct values upward for readability", () => {
  assert.equal(normalizedAccordBarPct({ label: "X", pct: 3 }), 14);
});

test("collectMainAccordDisplayRows reads object-shaped scent_vector (catalog axes)", () => {
  const rows = collectMainAccordDisplayRows({
    scent_vector: {
      freshness: 8,
      sweetness: 2,
      woodiness: 3,
      spice: 5,
      warmth: 7,
      musk: 4,
    },
  } as DerivedMetrics["main_accords"]);

  assert.equal(rows.length, 6);
  assert.equal(rows[0]?.label, "Freshness");
});

test("resolveMainAccordChartRows falls back to profile axes when metrics lack rows", () => {
  assert.equal(resolveMainAccordChartRows(undefined, undefined).length, 0);

  const rows = resolveMainAccordChartRows({} as DerivedMetrics["main_accords"], {
    woodiness: 9,
    musk: 2,
  });
  assert.equal(rows[0]?.label, "Woodiness");
});
