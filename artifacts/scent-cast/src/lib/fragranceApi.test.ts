import assert from "node:assert/strict";
import test from "node:test";
import type { DerivedMetrics } from "./fragranceApi.ts";
import {
  accordProminenceTier,
  APP_SEARCH_TIMEOUT_MS,
  collectMainAccordDisplayRows,
  ENGINE_FALLBACK_SOURCE,
  firstNonEmptyString,
  getCachedFragranceSearch,
  getFragranceDetails,
  isBackgroundEnrichmentQueued,
  isFetchNetworkError,
  isSearchResponseDegraded,
  isTransientDetailFetchError,
  isFragranceDetailEffectivelyComplete,
  normalizeFragranceDetail,
  normalizeFragranceSearchResult,
  normalizedAccordBarPct,
  requeueFragranceDetails,
  resolveMainAccordChartRows,
  resolveSourceStatus,
  sanitizeEngineQuery,
  sanitizeSearchQuery,
  scoreSearchResultForQuery,
  searchFragrances,
} from "./fragranceApi.ts";

test("sanitizeEngineQuery strips accents and symbols while preserving word boundaries and case", () => {
  // Accented vowels (NFD-decomposed) collapse to their base letter, not a split word.
  assert.equal(
    sanitizeEngineQuery("LANCÔME Idôle Eau de Toilette"),
    "LANCOME Idole Eau de Toilette",
  );
  // Trademark/registered glyphs drop out (NFD keeps "™" intact rather than expanding to "TM").
  assert.equal(sanitizeEngineQuery("BORNTOSTANDOUT® Cola Addict"), "BORNTOSTANDOUT Cola Addict");
  assert.equal(sanitizeEngineQuery("Scent™ Number 9"), "Scent Number 9");
  // Already-plain input is returned unchanged, so the auto-retry never fires needlessly.
  assert.equal(sanitizeEngineQuery("thom brown"), "thom brown");
  assert.equal(sanitizeEngineQuery("Yves Saint Laurent Libre"), "Yves Saint Laurent Libre");
});

test("isFetchNetworkError recognizes WebKit, Chromium, and Firefox network failures", () => {
  // WebKit (Safari, iOS/iPadOS) reports failed fetches as "Load failed".
  assert.equal(isFetchNetworkError(new TypeError("Load failed")), true);
  // Chromium.
  assert.equal(isFetchNetworkError(new TypeError("Failed to fetch")), true);
  // Firefox.
  assert.equal(isFetchNetworkError(new TypeError("NetworkError when attempting to fetch resource.")), true);
  // Aborts and non-network errors must not be treated as network failures.
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isFetchNetworkError(abort), false);
  assert.equal(isFetchNetworkError(new Error("HTTP 500")), false);
});

test("isTransientDetailFetchError treats network blips and 5xx as recoverable, 4xx as real", () => {
  // Network failures across engines → transient (fall back to best-effort add).
  assert.equal(isTransientDetailFetchError(new TypeError("Load failed")), true);
  assert.equal(isTransientDetailFetchError(new TypeError("Failed to fetch")), true);
  // getFragranceDetails throws "Fragrance detail fetch failed: <status>".
  assert.equal(isTransientDetailFetchError(new Error("Fragrance detail fetch failed: 503")), true);
  assert.equal(isTransientDetailFetchError(new Error("Fragrance detail fetch failed: 500")), true);
  // 4xx is a genuine failure (e.g. not found) and must surface, not be swallowed.
  assert.equal(isTransientDetailFetchError(new Error("Fragrance detail fetch failed: 404")), false);
  assert.equal(isTransientDetailFetchError(new Error("Fragrance detail fetch failed: 422")), false);
  // Aborts and unrelated errors are not transient-recoverable here.
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isTransientDetailFetchError(abort), false);
  assert.equal(isTransientDetailFetchError(new Error("Selected fragrance is missing a detail identifier.")), false);
  assert.equal(isTransientDetailFetchError("not an error"), false);
});

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

test("normalizeFragranceSearchResult recovers house from BaseNotes source URL", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: "basenotes-token",
      source_url: "https://basenotes.com/fragrances/absolu-aventus-triple-aged-batch-by-creed.26272004",
    },
    "Creed",
  );

  assert.equal(result?.name, "Absolu Aventus Triple Aged Batch");
  assert.equal(result?.house, "Creed");
  assert.equal(result?.brand, "Creed");
  assert.equal(
    result?.source_url,
    "https://basenotes.com/fragrances/absolu-aventus-triple-aged-batch-by-creed.26272004",
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

test("normalizeFragranceSearchResult does not use the raw search query as the fragrance name", () => {
  const result = normalizeFragranceSearchResult(
    {
      id: "weak-result",
      brand: "Dior",
    },
    "dior sauvage with vanilla",
  );

  assert.equal(result, null);
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

test("normalizeFragranceDetail keeps fragrantica-only metrics partial", () => {
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

  assert.equal(detail.source_coverage?.complete, false);
  assert.equal(isFragranceDetailEffectivelyComplete(detail), false);
  assert.equal(status.complete, false);
  assert.equal(status.badgeLabel, "Partial");
  assert.equal(status.sourceCountLabel, "Sources 1 of 2");
  assert.equal(status.metricsLabel, "Metric coverage incomplete");
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
  assert.equal(status.statusText, "Community-source profile available. Source coverage is incomplete.");
  assert.equal(status.sourceCountLabel, "Sources 0 of 2");
  assert.equal(status.metricsLabel, "Metric coverage incomplete");

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

test("getFragranceDetails can request incomplete recovery", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ name: "Aventus" }), {
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
    source_url: "https://www.fragrantica.com/perfume/Creed/Aventus-9828.html",
    recover_incomplete: true,
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    source_url: "https://www.fragrantica.com/perfume/Creed/Aventus-9828.html",
    recover_incomplete: true,
  });
});

test("getFragranceDetails falls back to the app API when the engine fetch fails", async (t) => {
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
        throw new TypeError("Load failed");
      }
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

  const detail = await getFragranceDetails({
    id: "opaque-token",
    source_url: "https://www.fragrantica.com/perfume/Creed/Aventus-9828.html",
  });

  assert.equal(detail.name, "Aventus");
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://engine.example.test/api/fragrances/details",
      "https://app-api.example.test/api/fragrances/details",
    ],
  );
});

test("getFragranceDetails falls back to the app API when the engine returns an empty body", async (t) => {
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
        return new Response("", { status: 200 });
      }
      return new Response(JSON.stringify({ name: "Egoiste Platinum", house: "Chanel" }), {
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

  const detail = await getFragranceDetails({
    id: "opaque-token",
    source_url: "https://www.fragrantica.com/perfume/Chanel/Egoiste-Platinum-614.html",
  });

  assert.equal(detail.name, "Egoiste Platinum");
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://engine.example.test/api/fragrances/details",
      "https://app-api.example.test/api/fragrances/details",
    ],
  );
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

test("searchFragrances expands known brand acronyms before engine lookup", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: string[] = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      requests.push(url);
      return new Response(
        JSON.stringify({
          query: "Maison Francis Kurkdjian",
          results: [
            {
              id: "mfk-br540",
              name: "Baccarat Rouge 540",
              house: "Maison Francis Kurkdjian",
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

  const response = await searchFragrances("MFK");

  assert.deepEqual(requests, [
    "https://engine.example.test/api/fragrances/search?q=Maison%20Francis%20Kurkdjian",
    "https://app-api.example.test/api/fragrances/search?q=Maison%20Francis%20Kurkdjian",
  ]);
  assert.equal(response.query, "MFK");
  assert.equal(response.results[0]?.house, "Maison Francis Kurkdjian");
});

test("searchFragrances ranks exact scent-name hits above brand dumps", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify({
          query: "Tom Ford Lost Cherry",
          results: [
            { id: "oud-wood", name: "Oud Wood", house: "Tom Ford" },
            { id: "lost-cherry", name: "Lost Cherry", house: "Tom Ford" },
            { id: "tobacco-vanille", name: "Tobacco Vanille", house: "Tom Ford" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
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

  const response = await searchFragrances("Tom Ford Lost Cherry");

  assert.deepEqual(
    response.results.map((result) => result.name),
    ["Lost Cherry", "Oud Wood", "Tobacco Vanille"],
  );
});

test("searchFragrances retries with a sanitized query when the accented query is empty", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const sentQueries: string[] = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      const decoded = decodeURIComponent(String(url));
      sentQueries.push(decoded);
      const isEngine = String(url).startsWith("https://engine.example.test");
      const hasNonAscii = [...decoded].some((ch) => ch.charCodeAt(0) > 127);
      // The engine only resolves the plain-ASCII form. The accented raw query
      // and every app-search supplement come back empty, so the first pass is a
      // clean zero-result — exactly the condition the sanitized retry recovers.
      if (isEngine && !hasNonAscii) {
        return new Response(
          JSON.stringify({
            query: "LANCOME Idole Eau de Toilette",
            results: [{ id: "idole-edt", name: "Idole Eau de Toilette", house: "Lancome" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ query: "LANCÔME Idôle Eau de Toilette", results: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
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

  const response = await searchFragrances("LANCÔME Idôle Eau de Toilette");

  // The sanitized retry surfaced the result the accented query missed.
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.name, "Idole Eau de Toilette");
  // The caller's original (accented) query is preserved on the response.
  assert.equal(response.query, "LANCÔME Idôle Eau de Toilette");
  // The engine was actually asked the sanitized form at least once.
  assert.ok(sentQueries.some((q) => q.includes("LANCOME Idole")));
});

test("searchFragrances does not retry when a plain query is genuinely empty", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  let engineCalls = 0;

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      if (String(url).startsWith("https://engine.example.test")) engineCalls += 1;
      return new Response(
        JSON.stringify({ query: "zzzzznotathing", results: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
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

  const response = await searchFragrances("zzzzznotathing");

  assert.equal(response.results.length, 0);
  // Sanitizing a plain query is a no-op, so the engine is hit exactly once — no
  // wasteful duplicate round-trip for queries with no accents or symbols.
  assert.equal(engineCalls, 1);
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

test("searchFragrances falls back to app results when the engine proxy returns 502", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: string[] = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      requests.push(url);
      if (url.startsWith("https://engine.example.test")) {
        return new Response(JSON.stringify({ error: "Fragrance engine unreachable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          query: "Dior Sauvage",
          results: [{ id: "catalog:Dior::Sauvage", name: "Sauvage", brand: "Dior" }],
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

  assert.deepEqual(requests, [
    "https://engine.example.test/api/fragrances/search?q=Dior%20Sauvage",
    "https://app-api.example.test/api/fragrances/search?q=Dior%20Sauvage",
  ]);
  assert.equal(response.results[0]?.id, "catalog:Dior::Sauvage");
  assert.equal(response.results[0]?.origin, "app");
});

test("searchFragrances does not cache a degraded/fallback-sourced response (refetches to self-heal)", async (t) => {
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

  // The engine answered from a degraded path (diagnostics.fallback_source set),
  // so the response is intentionally NOT cached: the second call refetches both
  // tiers rather than replaying a fallback-sourced list for the full TTL.
  assert.deepEqual(requests, [
    "https://engine.example.test/api/fragrances/search?q=creed",
    "https://app-api.example.test/api/fragrances/search?q=creed",
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

test("searchFragrances drops brand-only placeholders carried by opaque engine ids", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  // Base64url of {"n":"Xerjoff","b":"Xerjoff","y":null,"bn":null,"fg":null} —
  // the shape api.py:_encode_id emits for a source-less brand placeholder.
  const brandPlaceholderId =
    "eyJuIjoiWGVyam9mZiIsImIiOiJYZXJqb2ZmIiwieSI6bnVsbCwiYm4iOm51bGwsImZnIjpudWxsfQ";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify({
          query: "xerjof",
          results: [{ id: brandPlaceholderId, name: "Xerjoff", house: "Xerjoff" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
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

test("accordProminenceTier maps relative bar widths onto qualitative tiers", () => {
  // The bar value is relative prominence (top accord normalized to 100), not an
  // absolute percentage -- the tier word communicates the ranking without the
  // misleading "%". Boundaries: 90 Dominant, 70 Strong, 50 Moderate, 30 Supporting.
  assert.equal(accordProminenceTier(100), "Dominant");
  assert.equal(accordProminenceTier(90), "Dominant");
  assert.equal(accordProminenceTier(89), "Strong");
  assert.equal(accordProminenceTier(70), "Strong");
  assert.equal(accordProminenceTier(69), "Moderate");
  assert.equal(accordProminenceTier(50), "Moderate");
  assert.equal(accordProminenceTier(49), "Supporting");
  assert.equal(accordProminenceTier(30), "Supporting");
  assert.equal(accordProminenceTier(29), "Trace");
  assert.equal(accordProminenceTier(0), "Trace");
  assert.equal(accordProminenceTier(Number.NaN), "Trace");
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

test("searchFragrances keeps the whole flow within a 3-call budget on an empty symbol query", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  let engineCalls = 0;
  let appCalls = 0;

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      if (String(url).startsWith("https://engine.example.test")) engineCalls += 1;
      else if (String(url).startsWith("https://app-api.example.test")) appCalls += 1;
      // Everything comes back empty so the search exhausts every recovery branch.
      return new Response(JSON.stringify({ query: "x", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    if (previousApiUrl === undefined) delete process.env.VITE_FRAGRANCE_API_URL;
    else process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    if (previousAppApiUrl === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousAppApiUrl;
  });

  const response = await searchFragrances("Idôle™ Spécial");

  assert.equal(response.results.length, 0);
  // pass 1: engine (accented) + one app supplement; pass 2 (sanitized): a single
  // lone engine call with the app supplement suppressed. Never a 4th round-trip.
  assert.equal(engineCalls, 2);
  assert.equal(appCalls, 1);
  assert.ok(engineCalls + appCalls <= 3, `expected <=3 calls, saw ${engineCalls + appCalls}`);
});

test("searchFragrances does not reject brand-acronym results the engine returned", async (t) => {
  // Guards the web token-coverage gate against re-rejecting the engine's brand-only
  // recall: a "jpg" search must surface the whole Jean Paul Gaultier lineup the
  // engine expanded, not silently drop it into a false empty state.
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
            query: "jpg",
            results: [
              { id: "jpg-le-male", name: "Le Male", house: "Jean Paul Gaultier" },
              { id: "jpg-ultra-male", name: "Ultra Male", house: "Jean Paul Gaultier" },
              { id: "jpg-le-beau", name: "Le Beau", house: "Jean Paul Gaultier" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    if (previousApiUrl === undefined) delete process.env.VITE_FRAGRANCE_API_URL;
    else process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    if (previousAppApiUrl === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousAppApiUrl;
  });

  const response = await searchFragrances("jpg");
  const names = response.results.map((result) => result.name).sort();

  assert.deepEqual(names, ["Le Beau", "Le Male", "Ultra Male"]);
});

test("isSearchResponseDegraded flags fallback-sourced answers only", () => {
  assert.equal(
    isSearchResponseDegraded({ diagnostics: { fallback_source: "designer_catalog" } }),
    true,
  );
  assert.equal(isSearchResponseDegraded({ diagnostics: { fallback_source: null } }), false);
  assert.equal(isSearchResponseDegraded({ diagnostics: {} }), false);
  assert.equal(isSearchResponseDegraded({ diagnostics: undefined }), false);
  assert.equal(isSearchResponseDegraded(undefined), false);
  assert.equal(isSearchResponseDegraded(null), false);
});

test("searchFragrances caches a clean, sufficiently broad response (no refetch)", async (t) => {
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
  delete process.env.VITE_API_BASE_URL;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      requests.push(url);
      return new Response(
        JSON.stringify({
          query: "Dior Sauvage",
          results: [
            { id: "source:https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html", name: "Sauvage", house: "Dior" },
            { id: "source:https://www.fragrantica.com/perfume/Dior/Sauvage-Elixir-66070.html", name: "Sauvage Elixir", house: "Dior" },
            { id: "source:https://www.fragrantica.com/perfume/Dior/Sauvage-EDT-25324.html", name: "Sauvage Eau de Toilette", house: "Dior" },
          ],
          diagnostics: { result_count: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    if (previousWindow === undefined) {
      delete (globalThis as typeof globalThis & { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
    if (previousApiUrl === undefined) delete process.env.VITE_FRAGRANCE_API_URL;
    else process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    if (previousAppApiUrl === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousAppApiUrl;
  });

  const first = await searchFragrances("Dior Sauvage");
  const second = await searchFragrances("Dior Sauvage");

  // Clean (no fallback_source) and >= 3 results → cached; the second call is served
  // from cache, so only the first call hit the network.
  assert.equal(requests.length, 1);
  assert.equal(first.results.length, 3);
  assert.equal(second.results.length, 3);
});

test("searchFragrances honors an already-aborted signal on a cache hit", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
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
  delete process.env.VITE_API_BASE_URL;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify({
          query: "Dior Sauvage",
          results: [
            { id: "source:https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html", name: "Sauvage", house: "Dior" },
            { id: "source:https://www.fragrantica.com/perfume/Dior/Sauvage-Elixir-66070.html", name: "Sauvage Elixir", house: "Dior" },
            { id: "source:https://www.fragrantica.com/perfume/Dior/Sauvage-EDT-25324.html", name: "Sauvage Eau de Toilette", house: "Dior" },
          ],
          diagnostics: { result_count: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    if (previousWindow === undefined) {
      delete (globalThis as typeof globalThis & { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
    if (previousApiUrl === undefined) delete process.env.VITE_FRAGRANCE_API_URL;
    else process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    if (previousAppApiUrl === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousAppApiUrl;
  });

  // Warm the cache, then a follow-up with an already-aborted signal must reject
  // (a stale query must not resolve after the user moved on) rather than replay.
  await searchFragrances("Dior Sauvage");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => searchFragrances("Dior Sauvage", { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("requeueFragranceDetails does not replay the POST after a transport failure", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: string[] = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      requests.push(String(url));
      // Engine connects but the response is lost in transit — the enqueue may
      // already have landed server-side, so it must NOT be retried or re-POSTed.
      throw new TypeError("Failed to fetch");
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    if (previousApiUrl === undefined) delete process.env.VITE_FRAGRANCE_API_URL;
    else process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    if (previousAppApiUrl === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousAppApiUrl;
  });

  await assert.rejects(() =>
    requeueFragranceDetails({
      id: "opaque-token",
      source_url: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
    }),
  );
  // Exactly one POST attempt: no backoff retry, no direct-fallback re-POST.
  assert.equal(requests.length, 1);
});

test("getFragranceDetails tags the local fallback with provenance on an engine 5xx", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;
  const requests: string[] = [];

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      requests.push(String(url));
      if (String(url).startsWith("https://engine.example.test")) {
        return new Response(JSON.stringify({ detail: "engine boom" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ name: "Sauvage", house: "Dior" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    if (previousApiUrl === undefined) delete process.env.VITE_FRAGRANCE_API_URL;
    else process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    if (previousAppApiUrl === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousAppApiUrl;
  });

  const detail = await getFragranceDetails({
    id: "opaque-token",
    source_url: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
  });

  assert.equal(detail.name, "Sauvage");
  assert.equal((detail as { fallback_source?: string }).fallback_source, ENGINE_FALLBACK_SOURCE);
  assert.ok(detail.enrichment?.message && detail.enrichment.message.length > 0);
});

test("getFragranceDetails surfaces the original engine error when the local fallback also fails", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      if (String(url).startsWith("https://engine.example.test")) {
        return new Response(JSON.stringify({ detail: "engine exploded" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Local fallback also fails — the engine fault is the real cause and must
      // be the surfaced error, not the app-API status.
      return new Response(JSON.stringify({ detail: "local also down" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    if (previousApiUrl === undefined) delete process.env.VITE_FRAGRANCE_API_URL;
    else process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    if (previousAppApiUrl === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousAppApiUrl;
  });

  // fetchFragranceEngine wraps a 5xx as "Fragrance engine request failed: <status>"
  // and (for this POST) throws it without re-POSTing. When the local fallback also
  // fails, that wrapped engine error — not the app-API 502 — is surfaced, so the
  // banner blames the engine outage that actually drove the fallback.
  await assert.rejects(
    () =>
      getFragranceDetails({
        id: "opaque-token",
        source_url: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
      }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("Fragrance engine request failed: 503") &&
      !err.message.includes("502"),
  );
});

test("APP_SEARCH_TIMEOUT_MS is configured to 10 seconds", () => {
  assert.equal(APP_SEARCH_TIMEOUT_MS, 10_000);
});

test("sanitizeSearchQuery handles surrogate safety, control characters, and length truncation", () => {
  // Lone surrogates are replaced with replacement character, never throwing URIError on encodeURIComponent
  const loneHigh = "Sauvage \uD800";
  const loneLow = "Sauvage \uDC00";
  assert.doesNotThrow(() => encodeURIComponent(sanitizeSearchQuery(loneHigh)));
  assert.doesNotThrow(() => encodeURIComponent(sanitizeSearchQuery(loneLow)));
  assert.equal(sanitizeSearchQuery(loneHigh), "Sauvage \uFFFD");
  assert.equal(sanitizeSearchQuery(loneLow), "Sauvage \uFFFD");

  // Valid surrogate pairs (emojis) are preserved
  assert.equal(sanitizeSearchQuery("Bleu de Chanel 🌊"), "Bleu de Chanel 🌊");
  assert.equal(sanitizeSearchQuery("🌸 Flowerbomb 🌸"), "🌸 Flowerbomb 🌸");

  // Control characters (\x00-\x1f and \x7f) are stripped
  assert.equal(
    sanitizeSearchQuery("Sau\x00vage\x07 \x1bElixir\x7f"),
    "Sauvage Elixir",
  );

  // Whitespace is normalized and trimmed
  assert.equal(
    sanitizeSearchQuery("  Tom \t\n Ford   Oud   Wood  "),
    "Tom Ford Oud Wood",
  );

  // Default length truncation to 160 characters
  const longQuery = "a".repeat(200);
  const sanitizedLong = sanitizeSearchQuery(longQuery);
  assert.equal(sanitizedLong.length, 160);
  assert.equal(sanitizedLong, "a".repeat(160));

  // Custom maxLength argument
  assert.equal(sanitizeSearchQuery("1234567890", 5), "12345");

  // Surrogate split at boundary remains well-formed
  const edgeCaseSurrogate = "a".repeat(159) + "🌸";
  const truncatedSurrogate = sanitizeSearchQuery(edgeCaseSurrogate);
  assert.doesNotThrow(() => encodeURIComponent(truncatedSurrogate));

  // Non-string inputs safely return empty string
  assert.equal(sanitizeSearchQuery(null as unknown as string), "");
  assert.equal(sanitizeSearchQuery(undefined as unknown as string), "");
});

test("searchFragrances bypasses network on empty or whitespace-only queries", async () => {
  let fetchCalled = false;
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called for empty query");
    },
  });

  try {
    const resEmpty = await searchFragrances("");
    assert.deepEqual(resEmpty, { query: "", results: [] });

    const resWhitespace = await searchFragrances("   \t\n  ");
    assert.deepEqual(resWhitespace, { query: "   \t\n  ", results: [] });

    const resControlOnly = await searchFragrances("\x00\x07\x1f");
    assert.deepEqual(resControlOnly, { query: "\x00\x07\x1f", results: [] });

    assert.equal(fetchCalled, false);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: previousFetch,
    });
  }
});

test("searchFragrances recovers and runs sanitized retry when supplemental app search fails on 0-result engine search", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousApiUrl = process.env.VITE_FRAGRANCE_API_URL;
  const previousAppApiUrl = process.env.VITE_API_BASE_URL;

  process.env.VITE_FRAGRANCE_API_URL = "https://engine.example.test";
  process.env.VITE_API_BASE_URL = "https://app-api.example.test";

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      // 1. First engine call with accented query returns 0 results
      if (url.includes("/api/fragrances/search?q=") && url.includes(encodeURIComponent("LANCÔME Idôle"))) {
        return new Response(
          JSON.stringify({
            query: "LANCÔME Idôle",
            results: [],
            diagnostics: { result_count: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // 2. Supplemental app search fails with 500
      if (url.startsWith("https://app-api.example.test/api/fragrances/search")) {
        return new Response(
          JSON.stringify({ error: "App search failed" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      // 3. Sanitized retry engine call succeeds with results
      if (url.includes("/api/fragrances/search?q=") && url.includes(encodeURIComponent("LANCOME Idole"))) {
        return new Response(
          JSON.stringify({
            query: "LANCOME Idole",
            results: [
              {
                id: "srt-idole",
                name: "Idole",
                house: "Lancome",
              },
            ],
            diagnostics: { result_count: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });

  t.after(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
    if (previousApiUrl === undefined) delete process.env.VITE_FRAGRANCE_API_URL;
    else process.env.VITE_FRAGRANCE_API_URL = previousApiUrl;
    if (previousAppApiUrl === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousAppApiUrl;
  });

  // Verify searchFragrances does not throw from supplemental app 500, but recovers and retries sanitized query
  const response = await searchFragrances("LANCÔME Idôle");
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.name, "Idole");
  assert.equal(response.query, "LANCÔME Idôle");
});

test("normalizeFragranceSearchResult supports 4-digit string years and guards against NaN", () => {
  const withStringYear = normalizeFragranceSearchResult(
    { id: "1", name: "Sauvage", house: "Dior", year: "2024" },
    "Sauvage",
  );
  assert.equal(withStringYear?.year, 2024);

  const withSpacedStringYear = normalizeFragranceSearchResult(
    { id: "2", name: "Aventus", house: "Creed", year: " 2010 " },
    "Aventus",
  );
  assert.equal(withSpacedStringYear?.year, 2010);

  const withInvalidYear = normalizeFragranceSearchResult(
    { id: "3", name: "Eros", house: "Versace", year: "circa 2012" },
    "Eros",
  );
  assert.equal(withInvalidYear?.year, null);

  const withNanYear = normalizeFragranceSearchResult(
    { id: "4", name: "Kouros", house: "YSL", year: NaN },
    "Kouros",
  );
  assert.equal(withNanYear?.year, null);

  const withNanMetrics = normalizeFragranceSearchResult(
    { id: "5", name: "La Nuit", house: "YSL", bn_positive_pct: NaN, bn_vote_count: NaN },
    "La Nuit",
  );
  assert.equal(withNanMetrics?.bn_positive_pct, undefined);
  assert.equal(withNanMetrics?.bn_vote_count, undefined);
});

test("firstNonEmptyString and scoreSearchResultForQuery guard against NaN", () => {
  assert.equal(firstNonEmptyString(NaN, undefined, "Dior"), "Dior");
  assert.equal(firstNonEmptyString(NaN, null), undefined);
  assert.equal(firstNonEmptyString(NaN), undefined);

  const score = scoreSearchResultForQuery("Dior Sauvage", {
    id: "1",
    name: "Sauvage",
    house: "Dior",
  });
  assert.equal(typeof score, "number");
  assert.equal(Number.isFinite(score), true);
  assert.ok(score > 0);

  const scoreEmpty = scoreSearchResultForQuery("xyz", {
    id: "2",
    name: "",
  });
  assert.equal(scoreEmpty, 0);
  assert.equal(Number.isFinite(scoreEmpty), true);
});

test("getCachedFragranceSearch rejects entries with invalid or NaN cachedAt timestamps", () => {
  const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
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

  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });

  try {
    const query = "test fragrance";
    const cacheKey = "test fragrance";
    const corruptEntry = {
      cachedAt: NaN,
      response: {
        query,
        results: [{ id: "1", name: "Test", house: "House" }],
      },
    };
    localStorageData.set(
      "scentcast.fragranceSearchCache.v4",
      JSON.stringify({ [cacheKey]: corruptEntry }),
    );

    const hit = getCachedFragranceSearch(query);
    assert.equal(hit, null);
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as typeof globalThis & { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  }
});

