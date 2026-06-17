/**
 * Pure unit tests for the Beam Agent tool/runtime helpers.
 *
 * Runs with Node's built-in test runner, no workspace deps required:
 *   node --experimental-strip-types --test src/beam-agent/beamToolCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEAM_LIMITS,
  asString,
  boundToolResultForTranscript,
  buildProposalItem,
  clampLimit,
  cleanStringList,
  collectGroundedFragranceNames,
  computeOverlap,
  extractAgentCues,
  extractText,
  extractToolUses,
  jaccard,
  packetFromFlatProfile,
  packetFromOwnedItem,
  packetFromWardrobeRow,
  redactEventForClient,
  sanitizeSuggestions,
  summarizeToolResult,
  toClaudeTools,
} from "./beamToolCore.ts";
import type { BeamToolDefinition, ClaudeContentBlock } from "./types.ts";

test("jaccard is case/whitespace-insensitive and 0 when either side is empty", () => {
  assert.equal(jaccard(["Musk", "Amber"], ["amber", "musk"]), 1);
  assert.equal(jaccard([" Vanilla "], ["vanilla"]), 1);
  assert.equal(jaccard(["a", "b", "c", "d"], ["a", "b"]), 0.5);
  assert.equal(jaccard([], ["musk"]), 0);
  assert.equal(jaccard([], []), 0);
});

test("computeOverlap weights base notes + accords, bands by drydown similarity", () => {
  const candidate = {
    top: ["bergamot"],
    middle: ["birch"],
    base: ["musk", "oakmoss", "ambergris"],
    accords: ["fruity", "smoky"],
  };
  const twin = computeOverlap(candidate, {
    top: ["pineapple"],
    middle: ["birch"],
    base: ["musk", "oakmoss", "ambergris"],
    accords: ["fruity", "smoky"],
  });
  assert.equal(twin.band, "high");
  assert.ok(twin.combined >= 0.6);
  assert.deepEqual(twin.sharedBaseNotes.sort(), ["ambergris", "musk", "oakmoss"]);

  const unrelated = computeOverlap(candidate, {
    top: ["lemon"],
    middle: ["lavender"],
    base: ["ambroxan"],
    accords: ["fresh", "aromatic"],
  });
  assert.equal(unrelated.band, "low");
  assert.ok(unrelated.combined < twin.combined);
  assert.deepEqual(unrelated.sharedBaseNotes, []);
});

test("computeOverlap falls back to accords-only when note pyramids are absent", () => {
  const noNotes = { top: [], middle: [], base: [], accords: ["woody", "spicy"] };
  const result = computeOverlap(noNotes, { top: [], middle: [], base: [], accords: ["woody", "spicy"] });
  assert.equal(result.accords, 1);
  assert.equal(result.combined, 1);
  assert.equal(result.band, "high");
});

test("clampLimit enforces server ceiling and floor", () => {
  assert.equal(clampLimit(1000, BEAM_LIMITS.maxCatalogResults), BEAM_LIMITS.maxCatalogResults);
  assert.equal(clampLimit(0, 12), 1);
  assert.equal(clampLimit(-5, 12), 1);
  assert.equal(clampLimit(5, 12), 5);
  assert.equal(clampLimit("nope", 12, 3), 3);
  assert.equal(clampLimit(undefined, 12, 7), 7);
});

test("collectGroundedFragranceNames pulls names from each tool-result shape", () => {
  // search / wardrobe — CandidatePacket items
  assert.deepEqual(
    collectGroundedFragranceNames({ items: [{ canonicalName: "Aventus" }, { canonicalName: "Bleu de Chanel" }] }),
    ["Aventus", "Bleu de Chanel"],
  );
  // score — recommendation + picks, deduped case-insensitively
  assert.deepEqual(
    collectGroundedFragranceNames({
      recommendation: { canonicalName: "Sauvage" },
      picks: [{ canonicalName: "Sauvage" }, { canonicalName: "Aventus" }],
    }),
    ["Sauvage", "Aventus"],
  );
  // propose — proposed[].name
  assert.deepEqual(
    collectGroundedFragranceNames({ proposed: [{ name: "Silver Mountain Water" }] }),
    ["Silver Mountain Water"],
  );
});

test("collectGroundedFragranceNames does NOT ground an un-found details lookup", () => {
  // A details result echoes the model's queried names; only found ones ground.
  assert.deepEqual(
    collectGroundedFragranceNames({
      items: [
        { name: "Real Juice", found: true },
        { name: "Made Up Juice", found: false },
      ],
    }),
    ["Real Juice"],
  );
  // Odd shapes never throw.
  assert.deepEqual(collectGroundedFragranceNames(null), []);
  assert.deepEqual(collectGroundedFragranceNames({ wardrobeSummary: { count: 3 } }), []);
});

test("asString trims and rejects non-strings/empties", () => {
  assert.equal(asString("  hi  "), "hi");
  assert.equal(asString("   "), undefined);
  assert.equal(asString(42), undefined);
  assert.equal(asString(null), undefined);
});

test("cleanStringList dedupes case-insensitively, trims, and caps", () => {
  assert.deepEqual(cleanStringList(["Vanilla", "vanilla", " Amber ", 5, ""]), ["Vanilla", "Amber"]);
  assert.deepEqual(cleanStringList("not-an-array"), []);
  assert.equal(cleanStringList(Array.from({ length: 100 }, (_, i) => `n${i}`), 24).length, 24);
});

test("extractToolUses / extractText split a Claude content array", () => {
  const content: ClaudeContentBlock[] = [
    { type: "text", text: "Let me check. " },
    { type: "tool_use", id: "tu_1", name: "beam_get_wardrobe", input: {} },
    { type: "text", text: "One moment." },
  ];
  const uses = extractToolUses(content);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].name, "beam_get_wardrobe");
  assert.equal(extractText(content), "Let me check. One moment.");
});

test("redactEventForClient passes safe events and never leaks unknown types", () => {
  assert.deepEqual(
    redactEventForClient({ type: "tool_started", tool: "beam_search_catalog" }),
    { type: "tool_started", tool: "beam_search_catalog" },
  );
  assert.deepEqual(
    redactEventForClient({ type: "failed", code: "max_turns", message: "budget reached" }),
    { type: "failed", code: "max_turns", message: "budget reached" },
  );
  // An unexpected/internal event shape collapses to a generic status.
  const sneaky = { type: "debug", secret: "DB_PASSWORD" } as unknown as Parameters<typeof redactEventForClient>[0];
  assert.deepEqual(redactEventForClient(sneaky), { type: "status", label: "Working" });
});

test("redactEventForClient sanitizes a slots event through the canonical sanitizer", () => {
  const out = redactEventForClient({
    type: "slots",
    slots: {
      month: "August",
      destination: "Tokyo",
      // An unknown key must be dropped by the sanitizer (whitelist only).
      ["leaked" as "vibe"]: "DB_PASSWORD",
    },
    mission: { intent: "travel_kit", ownedCount: 2, newCount: 2, destination: "Tokyo", month: "August" },
  });
  assert.equal(out.type, "slots");
  if (out.type !== "slots") return;
  assert.equal(out.slots.month, "August");
  assert.equal(out.slots.destination, "Tokyo");
  assert.equal((out.slots as Record<string, unknown>).leaked, undefined);
  assert.equal(out.mission?.intent, "travel_kit");
  assert.equal(out.mission?.ownedCount, 2);
  assert.equal(out.mission?.newCount, 2);
});

test("summarizeToolResult produces safe one-liners", () => {
  assert.equal(summarizeToolResult("beam_search_catalog", { items: [1, 2, 3] }), "3 result(s)");
  assert.equal(summarizeToolResult("beam_score_candidates", { recommendation: { canonicalName: "Aventus" } }), "picked Aventus");
  assert.equal(summarizeToolResult("beam_score_candidates", { recommendation: null }), "no match");
  assert.equal(
    summarizeToolResult("beam_get_user_context", {
      wardrobeSummary: { count: 8, topFamilies: ["woody", "amber", "fresh"] },
    }),
    "8 bottles · woody, amber",
  );
  assert.equal(
    summarizeToolResult("beam_get_user_context", { wardrobeSummary: { count: 1, topFamilies: [] } }),
    "1 bottle",
  );
  assert.equal(
    summarizeToolResult("beam_get_user_context", { wardrobeSummary: { count: 0, topFamilies: [] } }),
    "vault is empty",
  );
  assert.equal(summarizeToolResult("x", "whatever"), "done");
});

test("extractAgentCues splits a trailing cues block from the answer", () => {
  const text =
    "Tell me the vibe and I'll line up your Tokyo picks.\n\n```cues\nTemple mornings\nShibuya nights\nBusiness meetings\n```";
  const { text: clean, cues } = extractAgentCues(text);
  assert.equal(clean, "Tell me the vibe and I'll line up your Tokyo picks.");
  assert.deepEqual(cues, ["Temple mornings", "Shibuya nights", "Business meetings"]);
});

test("extractAgentCues accepts a JSON-array cues block", () => {
  const { cues } = extractAgentCues('Pick one.\n```cues\n["Day", "Night"]\n```');
  assert.deepEqual(cues, ["Day", "Night"]);
});

test("extractAgentCues leaves plain answers untouched", () => {
  const { text, cues } = extractAgentCues("Wear Aventus today.");
  assert.equal(text, "Wear Aventus today.");
  assert.deepEqual(cues, []);
});

test("buildProposalItem maps a flattened catalog profile to an add-ready item", () => {
  const item = buildProposalItem({
    name: "Silver Mountain Water",
    brand: "Creed",
    family: "fresh",
    notes: ["bergamot", "green tea", "black currant"],
    pyramid: { top: ["bergamot"], heart: ["green tea"], base: ["musk"] },
    accords: ["fresh", "green"],
    scent_vector: { freshness: 8, sweetness: 2, woodiness: 4, spice: 1, warmth: 3, musk: 5 },
    performance: { sillage: 5, longevity: 6 },
    concentration: "EDP",
    imageUrl: "https://img/smw.webp",
    storagePath: "catalog/smw.webp",
  });
  assert.ok(item);
  assert.equal(item?.name, "Silver Mountain Water");
  assert.equal(item?.brand, "Creed");
  assert.equal(item?.scentVector?.freshness, 8);
  assert.deepEqual(item?.pyramid?.top, ["bergamot"]);
  assert.equal(item?.performance?.longevity, 6);
  assert.equal(item?.imageUrl, "https://img/smw.webp");
});

test("buildProposalItem returns null without a usable name", () => {
  assert.equal(buildProposalItem({ brand: "Creed" }), null);
});

test("redactEventForClient clamps a proposal to the item cap", () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ name: `F${i}`, brand: "B", notes: [], accords: [] }));
  const out = redactEventForClient({ type: "proposal", proposalId: "prop_1", items });
  assert.equal(out.type, "proposal");
  assert.equal(out.type === "proposal" ? out.items.length : -1, BEAM_LIMITS.maxProposalItems);
});

test("redactEventForClient clamps an over-long card (accords + caption)", () => {
  const out = redactEventForClient({
    type: "card",
    card: {
      kind: "scent_profile",
      fragrance: {
        name: "Aventus",
        brand: "Creed",
        accords: Array.from({ length: 20 }, (_, i) => `accord ${i}`),
        scentVector: { freshness: 5, sweetness: -1, woodiness: 0.7, spice: 0.5, warmth: 0.6, musk: 0.4 },
      },
      caption: "x".repeat(400),
    },
  });
  assert.equal(out.type, "card");
  if (out.type === "card" && out.card.kind === "scent_profile") {
    assert.ok(out.card.fragrance.accords.length <= BEAM_LIMITS.maxCardAccords);
    assert.ok((out.card.caption ?? "").length <= BEAM_LIMITS.maxCardCaption);
    // Axes are clamped into 0..1.
    assert.equal(out.card.fragrance.scentVector?.freshness, 1);
    assert.equal(out.card.fragrance.scentVector?.sweetness, 0);
  } else {
    assert.fail("expected a scent_profile card");
  }
});

test("sanitizeSuggestions clamps count, length, empties, and dupes", () => {
  const items = [
    { label: "  Keep  ", value: "keep-it" },
    { label: "Keep" }, // dupe (case-insensitive), dropped
    { label: "" }, // empty, dropped
    { label: "B" },
    { label: "C" },
    { label: "D" },
    { label: "E" }, // beyond maxSuggestions (4), dropped
  ];
  const out = sanitizeSuggestions(items);
  assert.equal(out.length, BEAM_LIMITS.maxSuggestions);
  assert.deepEqual(out[0], { label: "Keep", value: "keep-it" });
  assert.equal(out[1].value, "B"); // value defaults to label
});

test("packetFromOwnedItem marks ownership and merges traits", () => {
  const packet = packetFromOwnedItem({
    id: "frag-1",
    name: "Sauvage",
    brand: "Dior",
    families: ["fresh"],
    accords: ["pepper", "fresh"],
    longevity: 7,
    sillage: "strong",
  });
  assert.equal(packet.owned, true);
  assert.equal(packet.fragranceId, "frag-1");
  assert.deepEqual(packet.accords, ["fresh", "pepper"]);
  assert.equal(packet.performance.longevity, 7);
  assert.equal(packet.performance.projection, "strong");
  assert.deepEqual(packet.missingFields, []);
});

test("packetFromFlatProfile defends against thin/untrusted records", () => {
  const thin = packetFromFlatProfile("g-1", {}, false);
  assert.equal(thin.owned, false);
  assert.deepEqual(thin.missingFields.sort(), ["accords", "brand", "name", "notes"]);
  assert.ok(thin.sourceConfidence < 0.9);

  const full = packetFromFlatProfile(
    "g-2",
    { name: "Aventus", brand: "Creed", accords: ["fruity", "smoky"], pyramid: { top: ["pineapple"], base: ["musk"] } },
    false,
  );
  assert.equal(full.canonicalName, "Aventus");
  assert.equal(full.brand, "Creed");
  assert.deepEqual(full.notes.top, ["pineapple"]);
  assert.equal(full.missingFields.length, 0);
  assert.equal(full.sourceConfidence, 0.9);
});

test("packetFromWardrobeRow preserves the note pyramid from the raw row", () => {
  const packet = packetFromWardrobeRow("row-9", {
    id: "frag-9",
    name: "Aventus",
    brand: "Creed",
    accords: ["fruity"],
    pyramid: { top: ["pineapple"], heart: ["birch"], base: ["musk", "musk"] },
    longevity: 8,
    sillage: "strong",
  });
  assert.ok(packet);
  assert.equal(packet!.owned, true);
  assert.equal(packet!.fragranceId, "frag-9");
  assert.deepEqual(packet!.notes, { top: ["pineapple"], middle: ["birch"], base: ["musk"] });
  assert.deepEqual(packet!.accords, ["fruity"]);
  assert.equal(packet!.performance.longevity, 8);
  assert.equal(packet!.performance.projection, "strong");
  assert.deepEqual(packet!.missingFields, []);
});

test("packetFromWardrobeRow returns null without a name and flags thin rows", () => {
  assert.equal(packetFromWardrobeRow("row-x", { brand: "Creed" }), null);
  assert.equal(packetFromWardrobeRow("row-x", null), null);

  const thin = packetFromWardrobeRow("row-y", { name: "Mystery Juice" });
  assert.ok(thin);
  assert.equal(thin!.canonicalName, "Mystery Juice");
  assert.deepEqual(thin!.missingFields.sort(), ["accords", "notes"]);
  assert.ok(thin!.sourceConfidence < 0.95);
});

test("toClaudeTools maps name/description/input_schema", () => {
  const defs: BeamToolDefinition[] = [
    {
      name: "beam_get_wardrobe",
      description: "List the user's vault.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ items: [] }),
    },
  ];
  const tools = toClaudeTools(defs);
  assert.equal(tools[0].name, "beam_get_wardrobe");
  assert.equal(tools[0].description, "List the user's vault.");
  assert.deepEqual(tools[0].input_schema, { type: "object", properties: {} });
});

test("boundToolResultForTranscript caps array counts and string lengths but keeps valid JSON", () => {
  const big = {
    items: Array.from({ length: 50 }, (_, i) => ({
      name: `Frag ${i}`,
      description: "x".repeat(5000),
      accords: ["amber", "musk"],
    })),
  };
  const bounded = boundToolResultForTranscript(big) as { items: unknown[] };
  // The result must still be serializable (no mid-record truncation -> valid JSON).
  const serialized = JSON.stringify(bounded);
  assert.doesNotThrow(() => JSON.parse(serialized));
  // Array capped to the configured item budget + a single "…more" marker.
  assert.equal(bounded.items.length, BEAM_LIMITS.maxToolResultArrayItems + 1);
  const first = bounded.items[0] as { name: string; description: string; accords: string[] };
  // Short identifying fields survive intact; long prose is bounded.
  assert.equal(first.name, "Frag 0");
  assert.deepEqual(first.accords, ["amber", "musk"]);
  assert.ok(first.description.length <= BEAM_LIMITS.maxToolResultStringChars + 1);
  // The whole bounded payload is far smaller than the raw one.
  assert.ok(serialized.length < JSON.stringify(big).length / 10);
});

test("boundToolResultForTranscript preserves a grounded fragrance name through trimming", () => {
  const result = {
    items: Array.from({ length: 30 }, (_, i) => ({ name: `Filler ${i}`, found: true })),
    recommendation: { canonicalName: "Creed Aventus", brand: "Creed" },
  };
  const bounded = boundToolResultForTranscript(result);
  // The pick that grounds the closing answer must still be present after trimming.
  assert.ok(JSON.stringify(bounded).includes("Creed Aventus"));
  // And the grounding extractor (run on the UNTRIMMED result in the loop) is
  // unaffected — the headline name is collectible either way.
  assert.ok(collectGroundedFragranceNames(result).includes("Creed Aventus"));
});
