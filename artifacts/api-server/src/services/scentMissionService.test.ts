import assert from "node:assert/strict";
import test from "node:test";
import { createScentMissionState, completeScentMissionNode } from "@workspace/scent-weather-engine";
import {
  executeScentMission,
  missionItemFromWardrobeRow,
  parseScentMissionRequest,
} from "./scentMissionService.ts";

function calibratedMission() {
  const mission = createScentMissionState();
  mission.calibration = { destination: "Going Out", energy: "Confident" };
  return mission;
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "chat",
    userMessage: "hello",
    mission: createScentMissionState(),
    context: { weather: { temperature_f: 75 } },
    ...overrides,
  };
}

const WARDROBE = [
  {
    id: "heavy",
    name: "Midnight Oud",
    brand: "Example",
    families: ["oud", "amber"],
    accords: ["oud", "tobacco", "vanilla"],
    sillage: "strong",
  },
  {
    id: "fresh",
    name: "Citrus Breeze",
    brand: "Example",
    families: ["citrus", "fresh"],
    accords: ["bergamot", "marine"],
    sillage: "light",
  },
];

const HOT_HUMID = { temperature_f: 92, humidity_percent: 80, wind_speed_mph: 2, is_raining: false };

/* ----------------------------- validation ----------------------------- */

test("parseScentMissionRequest rejects bad envelopes", () => {
  assert.equal(parseScentMissionRequest(null).ok, false);
  assert.equal(parseScentMissionRequest({ action: "destroy" }).ok, false);
  assert.equal(parseScentMissionRequest(baseBody({ action: "execute_node", nodeId: "bogus" })).ok, false);
  assert.equal(parseScentMissionRequest(baseBody({ userMessage: undefined })).ok, false);
  assert.equal(parseScentMissionRequest(baseBody({ userMessage: "   " })).ok, false);
  assert.equal(parseScentMissionRequest(baseBody({ userMessage: 42 })).ok, false);
});

test("parseScentMissionRequest sanitizes mission state, wardrobe, weather, and session id", () => {
  const parsed = parseScentMissionRequest({
    action: "execute_node",
    nodeId: "wardrobe-sync",
    sessionId: "###invalid###",
    userMessage: ` ${"m".repeat(5000)} `,
    mission: { nodes: { onboarding: "exploded" }, premiumUnlocked: true },
    context: {
      weather: { temp: 80, humidity: 65, uv_index: "11" },
      wardrobe: [{ id: "a", name: "Frag A", families: ["woody", 7] }, { id: "", name: "drop me" }],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const request = parsed.request;
  assert.notEqual(request.sessionId, "###invalid###");
  assert.ok(request.userMessage!.length <= 2000);
  assert.equal(request.mission.nodes.onboarding, "active");
  assert.equal(request.mission.premiumUnlocked, false);
  assert.equal(request.context.weather.temperature_f, 80);
  assert.equal(request.context.weather.uv_index, null);
  assert.equal(request.context.wardrobe!.length, 1);
  assert.deepEqual(request.context.wardrobe![0]!.families, ["woody"]);
});

test("parseScentMissionRequest keeps a well-formed session id", () => {
  const parsed = parseScentMissionRequest(baseBody({ sessionId: "session-1234" }));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.request.sessionId, "session-1234");
});

/* ------------------------- wardrobe row mapping ------------------------ */

test("missionItemFromWardrobeRow projects vault JSONB into mission items", () => {
  const item = missionItemFromWardrobeRow("row-1", {
    id: "client-1",
    name: "Oud Wood",
    brand: "Tom Ford",
    concentration: "EDP",
    family: "Woody",
    accords: ["oud", "sandalwood"],
    notes: ["rosewood"],
    pyramid: { top: ["cardamom"], heart: ["oud"], base: ["amber"] },
    performance: { sillage: 9, longevity: 8 },
  });
  assert.ok(item);
  assert.equal(item!.id, "client-1");
  assert.equal(item!.dbId, "row-1");
  assert.equal(item!.brand, "Tom Ford");
  assert.deepEqual(item!.families, ["Woody"]);
  assert.deepEqual(item!.accords, ["oud", "sandalwood", "rosewood", "cardamom", "oud", "amber"]);
  assert.equal(item!.sillage, "strong");
  assert.equal(item!.longevity, 8);
});

test("missionItemFromWardrobeRow falls back to product.name and rejects nameless rows", () => {
  const legacy = missionItemFromWardrobeRow("row-2", { product: { name: "Legacy", brand: "House" } });
  assert.equal(legacy!.name, "Legacy");
  assert.equal(legacy!.id, "row-2");

  assert.equal(missionItemFromWardrobeRow("row-3", { brand: "No Name" }), null);
  assert.equal(missionItemFromWardrobeRow("row-4", "garbage"), null);
});

/* -------------------------- deterministic chat ------------------------- */

test("chat falls back to a deterministic reply when no LLM is configured", async () => {
  const parsed = parseScentMissionRequest(baseBody({ userMessage: "what's the weather like?" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const response = await executeScentMission(parsed.request, { deps: {} });
  assert.ok(response.assistantMessage);
  assert.match(response.assistantMessage!, /75°F/);
  assert.match(response.assistantMessage!, /UV index unavailable/);
});

test("chat uses the injected LLM and falls back when it throws", async () => {
  const parsed = parseScentMissionRequest(baseBody({ userMessage: "hello there" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const viaLlm = await executeScentMission(parsed.request, {
    deps: { llmChat: async () => " LLM says hi. " },
  });
  assert.equal(viaLlm.assistantMessage, "LLM says hi.");

  const fallback = await executeScentMission(parsed.request, {
    deps: { llmChat: async () => { throw new Error("outage"); } },
  });
  assert.ok(fallback.assistantMessage);
  assert.doesNotMatch(fallback.assistantMessage!, /LLM says hi/);
});

/* ---------------------------- node execution --------------------------- */

async function runNode(
  nodeId: string,
  mission: ReturnType<typeof createScentMissionState>,
  wardrobe: unknown[] = WARDROBE,
  weather: Record<string, unknown> = HOT_HUMID,
  opts: { serverWardrobe?: typeof WARDROBE; research?: (name: string) => Promise<unknown> } = {},
) {
  const parsed = parseScentMissionRequest({
    action: "execute_node",
    nodeId,
    mission,
    context: { weather, wardrobe },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return executeScentMission(parsed.request, {
    serverWardrobe: opts.serverWardrobe,
    deps: { research: opts.research },
  });
}

test("onboarding execution requires calibration, then advances the graph", async () => {
  const incomplete = await runNode("onboarding", createScentMissionState());
  assert.equal(incomplete.nodeUpdates, undefined);
  assert.match(incomplete.assistantMessage!, /Calibration incomplete/);

  const complete = await runNode("onboarding", calibratedMission());
  assert.deepEqual(complete.nodeUpdates, [
    { nodeId: "onboarding", status: "complete" },
    { nodeId: "wardrobe-sync", status: "active" },
  ]);
  assert.deepEqual(complete.missionPatch?.calibration, {
    destination: "Going Out",
    energy: "Confident",
  });
});

test("wardrobe-sync blocks on an empty vault and completes with a summary otherwise", async () => {
  let mission = completeScentMissionNode(calibratedMission(), "onboarding");

  const blocked = await runNode("wardrobe-sync", mission, []);
  assert.deepEqual(blocked.nodeUpdates, [{ nodeId: "wardrobe-sync", status: "blocked" }]);

  const synced = await runNode("wardrobe-sync", mission);
  assert.match(synced.assistantMessage!, /2 fragrances/);
  assert.deepEqual(synced.nodeUpdates, [
    { nodeId: "wardrobe-sync", status: "complete" },
    { nodeId: "environment-scan", status: "active" },
  ]);
});

test("environment-scan reports UV availability honestly", async () => {
  let mission = completeScentMissionNode(calibratedMission(), "onboarding");
  mission = completeScentMissionNode(mission, "wardrobe-sync");

  const noUv = await runNode("environment-scan", mission, WARDROBE, HOT_HUMID);
  assert.match(noUv.assistantMessage!, /UV index unavailable/);

  const withUv = await runNode("environment-scan", mission, WARDROBE, { ...HOT_HUMID, uv_index: 8.2 });
  assert.match(withUv.assistantMessage!, /UV index 8\.2/);
});

test("resolution-standard returns the engine winner and unlocks the premium gate as blocked", async () => {
  let mission = calibratedMission();
  for (const nodeId of ["onboarding", "wardrobe-sync", "environment-scan"] as const) {
    mission = completeScentMissionNode(mission, nodeId);
  }

  const resolved = await runNode("resolution-standard", mission);
  assert.equal(resolved.recommendation?.fragranceId, "fresh");
  assert.equal(resolved.recommendation?.name, "Citrus Breeze");
  assert.ok(resolved.recommendation!.reason.length > 0);
  assert.deepEqual(resolved.nodeUpdates, [
    { nodeId: "resolution-standard", status: "complete" },
    { nodeId: "resolution-premium", status: "blocked" },
  ]);
});

test("resolution-standard prefers the server wardrobe over client-sent items", async () => {
  let mission = calibratedMission();
  for (const nodeId of ["onboarding", "wardrobe-sync", "environment-scan"] as const) {
    mission = completeScentMissionNode(mission, nodeId);
  }

  const serverOnly = [{ id: "srv", name: "Server Vetiver", families: ["green", "fresh"], accords: ["vetiver"] }];
  const resolved = await runNode("resolution-standard", mission, WARDROBE, HOT_HUMID, {
    serverWardrobe: serverOnly,
  });
  assert.equal(resolved.recommendation?.fragranceId, "srv");
});

test("resolution-standard attaches research when available and survives research failure", async () => {
  let mission = calibratedMission();
  for (const nodeId of ["onboarding", "wardrobe-sync", "environment-scan"] as const) {
    mission = completeScentMissionNode(mission, nodeId);
  }

  const withResearch = await runNode("resolution-standard", mission, WARDROBE, HOT_HUMID, {
    research: async (name) => ({ ok: true, researched: name }),
  });
  assert.deepEqual(withResearch.research, { ok: true, researched: "Example Citrus Breeze" });

  const researchDown = await runNode("resolution-standard", mission, WARDROBE, HOT_HUMID, {
    research: async () => { throw new Error("jina down"); },
  });
  assert.equal(researchDown.research, undefined);
  assert.equal(researchDown.recommendation?.fragranceId, "fresh");
});

test("resolution-premium stays locked with conversion copy and no node updates", async () => {
  let mission = calibratedMission();
  for (const nodeId of ["onboarding", "wardrobe-sync", "environment-scan", "resolution-standard"] as const) {
    mission = completeScentMissionNode(mission, nodeId);
  }

  const premium = await runNode("resolution-premium", mission);
  assert.equal(premium.premiumLock?.locked, true);
  assert.equal(premium.nodeUpdates, undefined);
  assert.equal(premium.recommendation, undefined);
});
