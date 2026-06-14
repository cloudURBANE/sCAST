/**
 * Unit tests for the PURE research policy (no DB, no network). Run with:
 *   node --experimental-strip-types --test src/beam-agent/research/researchPolicy.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEntityType,
  estimateCostUsd,
  inferResearchSignals,
  isBannedResearchModel,
  modeFromDepth,
  normalizeResearchQuery,
  searchCostUsd,
  selectResearchMode,
  ttlMsForEntityType,
} from "./researchPolicy.ts";

test("normalizeResearchQuery lowercases, collapses whitespace, trims punctuation", () => {
  assert.equal(normalizeResearchQuery("  Is  Aventus   DISCONTINUED?  "), "is aventus discontinued");
  assert.equal(normalizeResearchQuery('"Creed Aventus"'), "creed aventus");
  assert.equal(normalizeResearchQuery("   "), "");
});

test("classifyEntityType keys off intent words", () => {
  assert.equal(classifyEntityType("price of aventus"), "price");
  assert.equal(classifyEntityType("is bleu de chanel in stock"), "availability");
  assert.equal(classifyEntityType("samples of mfk baccarat"), "seller");
  assert.equal(classifyEntityType("who is the perfumer of sauvage"), "note_claim");
  assert.equal(classifyEntityType("the house amouage"), "brand");
  assert.equal(classifyEntityType("aventus"), "fragrance");
});

test("inferResearchSignals detects freshness, citation, unknown-entity intents", () => {
  const price = inferResearchSignals("cheapest price for aventus");
  assert.equal(price.requiresFreshness, true);
  assert.equal(price.intent, "price_compare");

  const cite = inferResearchSignals("give me cited sources for the release year");
  assert.equal(cite.requiresCitation, true);

  const calm = inferResearchSignals("what should i wear today");
  assert.equal(calm.requiresFreshness, false);
  assert.equal(calm.requiresCitation, false);
  assert.equal(calm.hasUnknownEntity, false);
});

test("selectResearchMode follows the spec ladder", () => {
  assert.equal(
    selectResearchMode({ requiresFreshness: false, requiresCitation: false, hasUnknownEntity: false }),
    "no_search_use_cache",
  );
  assert.equal(
    selectResearchMode({
      requiresFreshness: true,
      requiresCitation: false,
      hasUnknownEntity: false,
      intent: "check_availability",
    }),
    "single_source_check",
  );
  assert.equal(
    selectResearchMode({
      requiresFreshness: true,
      requiresCitation: false,
      hasUnknownEntity: false,
      intent: "price_compare",
    }),
    "standard_research",
  );
  assert.equal(
    selectResearchMode({
      requiresFreshness: false,
      requiresCitation: false,
      hasUnknownEntity: false,
      collectorTier: true,
    }),
    "premium_research",
  );
});

test("modeFromDepth maps explicit hints, null for auto/unknown", () => {
  assert.equal(modeFromDepth("single"), "single_source_check");
  assert.equal(modeFromDepth("standard"), "standard_research");
  assert.equal(modeFromDepth("premium"), "premium_research");
  assert.equal(modeFromDepth("auto"), null);
  assert.equal(modeFromDepth(undefined), null);
  assert.equal(modeFromDepth("garbage"), null);
});

test("ttlMsForEntityType: price short, notes long", () => {
  const HOUR = 60 * 60 * 1000;
  assert.equal(ttlMsForEntityType("price"), 12 * HOUR);
  assert.equal(ttlMsForEntityType("availability"), 48 * HOUR);
  assert.ok(ttlMsForEntityType("note_claim") > ttlMsForEntityType("availability"));
  assert.ok(ttlMsForEntityType("fragrance") >= 30 * 24 * HOUR);
});

test("isBannedResearchModel rejects the cost-opaque defaults", () => {
  assert.equal(isBannedResearchModel("openai/gpt-4o:online"), true);
  assert.equal(isBannedResearchModel("openrouter/auto"), true);
  assert.equal(isBannedResearchModel("openrouter/fusion"), true);
  assert.equal(isBannedResearchModel(""), true);
  assert.equal(isBannedResearchModel("minimax/minimax-m3"), false);
  assert.equal(isBannedResearchModel("moonshotai/kimi-k2.7-code"), false);
});

test("cost estimate: flat search fee under 10 results + token cost", () => {
  assert.equal(searchCostUsd(2), 0.005);
  assert.equal(searchCostUsd(12), 0.007);
  const cost = estimateCostUsd({ model: "minimax/minimax-m3", inputTokens: 1000, outputTokens: 700, maxResults: 2 });
  assert.ok(cost >= 0.005, "includes the search fee");
  assert.ok(cost < 0.06, `stays within the standard hard cap, got ${cost}`);
});
