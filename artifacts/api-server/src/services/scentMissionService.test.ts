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
  assert.equal(request.mission.nodes["wardrobe-sync"], "locked");
  assert.equal(request.mission.premiumUnlocked, false);
  assert.equal(request.context.weather.temperature_f, 80);
  assert.equal(request.context.weather.uv_index, null);
  assert.equal(request.context.wardrobe!.length, 1);
  assert.deepEqual(request.context.wardrobe![0]!.families, ["woody"]);
});

test("parseScentMissionRequest repairs impossible downstream active nodes", () => {
  const parsed = parseScentMissionRequest(baseBody({
    action: "execute_node",
    nodeId: "resolution-standard",
    mission: {
      nodes: {
        onboarding: "active",
        "wardrobe-sync": "complete",
        "environment-scan": "complete",
        "resolution-standard": "active",
      },
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.mission.nodes.onboarding, "active");
  assert.equal(parsed.request.mission.nodes["resolution-standard"], "locked");
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

test("chat can fill calibration from natural language", async () => {
  const parsed = parseScentMissionRequest(baseBody({
    userMessage: "I have a client meeting at work and want to feel focused.",
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const response = await executeScentMission(parsed.request, { deps: {} });
  assert.deepEqual(response.missionPatch?.calibration, {
    destination: "Work",
    energy: "Focused",
  });
  // Reflects the captured setting/mood in the user's own framing — no internal
  // "node"/"mission tree" jargon (which the SPA strips, discarding the reply).
  assert.match(response.assistantMessage!, /work/i);
  assert.match(response.assistantMessage!, /focused/i);
  assert.doesNotMatch(response.assistantMessage!, /mission tree|node|execute analysis/i);
});

/* ---------------- intent-preserving deterministic fallback ---------------- */

// The phrases the SPA's safeAssistantText() rejects; if the scripted fallback
// emits any of these the user gets a generic substitute and their intent is
// lost. The degraded (no-model) path must never produce them.
const SPA_REJECTED = /mission tree|execute analysis|resolution node|sync node|hit execute|work through the mission/i;

// Internal mission-graph / product-state vocabulary that must never reach the
// user in any node-execution or fallback reply. Catches the prior offenders
// ("Calibration locked", "Environment scan", "Resolution is armed", "mission
// node", "execute again", "re-run this node") plus a bare "node".
const NODE_JARGON =
  /\bnode\b|mission tree|calibration|environment scan|resolution is armed|lock calibration|execute analysis|execute again|re-run this/i;

async function scriptedReply(userMessage: string, overrides: Record<string, unknown> = {}) {
  const parsed = parseScentMissionRequest(baseBody({ userMessage, ...overrides }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  const response = await executeScentMission(parsed.request, { deps: {} });
  return response.assistantMessage ?? "";
}

test("deterministic fallback never leaks mission-graph jargon the SPA strips", async () => {
  const probes = [
    "I want something clean, airy, woody, and expensive-smelling for humid Dallas nights.",
    "I need a fragrance for a dinner date tomorrow, intimate but memorable.",
    "I want something fresh aquatic but not basic, good for hot weather.",
    "I'm going to a wedding and want something elegant that projects but doesn't choke people out.",
    "what should I wear?",
    "hello there",
  ];
  for (const probe of probes) {
    const reply = await scriptedReply(probe);
    assert.ok(reply.length > 0, `empty reply for: ${probe}`);
    assert.doesNotMatch(reply, SPA_REJECTED, `leaked stripped jargon for: ${probe}`);
  }
});

test("deterministic fallback reflects the user's freeform scent/context intent", async () => {
  const fresh = await scriptedReply(
    "I want something clean, airy, woody for humid Dallas nights.",
  );
  assert.match(fresh, /fresh|clean/i);
  assert.match(fresh, /woody/i);
  assert.match(fresh, /humid/i);

  const date = await scriptedReply("something intimate but memorable for a dinner date");
  // "dinner date" is captured as the Date occasion and acknowledged in the
  // user's own framing (not collapsed into a canned mission-status line).
  assert.match(date, /date/i);
});

test("deterministic fallback only answers weather when actually asked about it", async () => {
  // A genuine conditions question gets the live atmosphere read.
  const asked = await scriptedReply("what's the weather like right now?");
  assert.match(asked, /75°F/);

  // "hot weather" used as scent context must NOT hijack into a weather readout;
  // it should preserve the fresh-aquatic intent instead.
  const context = await scriptedReply("something fresh aquatic, good for hot weather");
  assert.match(context, /fresh|clean/i);
  assert.doesNotMatch(context, /UV index/i);

  // A bare "is" near "weather" (scent context, not a question) must also not
  // trigger the readout — it would drop the user's intent.
  const statement = await scriptedReply("this is a clean scent for warm weather");
  assert.doesNotMatch(statement, /UV index/i);
  assert.match(statement, /fresh|clean|warm/i);
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
  assert.match(incomplete.assistantMessage!, /where you're headed|how you want/i);
  assert.doesNotMatch(incomplete.assistantMessage!, NODE_JARGON);

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

  const retryMission = {
    ...mission,
    nodes: { ...mission.nodes, "wardrobe-sync": "blocked" as const },
  };
  const retried = await runNode("wardrobe-sync", retryMission);
  assert.deepEqual(retried.nodeUpdates, [
    { nodeId: "wardrobe-sync", status: "complete" },
    { nodeId: "environment-scan", status: "active" },
  ]);

  const synced = await runNode("wardrobe-sync", mission);
  assert.match(synced.assistantMessage!, /2 fragrances/);
  assert.deepEqual(synced.nodeUpdates, [
    { nodeId: "wardrobe-sync", status: "complete" },
    { nodeId: "environment-scan", status: "active" },
  ]);
});

test("wardrobe-sync distinguishes an intentionally empty With Me set from an empty vault", async () => {
  const mission = completeScentMissionNode(calibratedMission(), "onboarding");
  const parsed = parseScentMissionRequest({
    action: "execute_node",
    nodeId: "wardrobe-sync",
    mission,
    context: { weather: HOT_HUMID, wardrobe: [], wardrobeAvailability: { enabled: true } },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");

  const blocked = await executeScentMission(parsed.request);
  assert.match(blocked.assistantMessage!, /With Me is active/i);
  assert.doesNotMatch(blocked.assistantMessage!, /collection's empty/i);
});

test("execute_node refuses locked nodes without leaking a recommendation", async () => {
  const parsed = parseScentMissionRequest({
    action: "execute_node",
    nodeId: "resolution-standard",
    mission: createScentMissionState(),
    context: { weather: HOT_HUMID, wardrobe: WARDROBE },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const response = await executeScentMission(parsed.request, { deps: {} });
  // Refuses an out-of-order node, in natural language (no "mission node" jargon).
  assert.match(response.assistantMessage!, /finish this step|need a little more/i);
  assert.doesNotMatch(response.assistantMessage!, NODE_JARGON);
  assert.equal(response.recommendation, undefined);
  assert.equal(response.nodeUpdates, undefined);
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

test("resolution-standard attaches runner-up alternates after the winner (A6-GAP3)", async () => {
  let mission = calibratedMission();
  for (const nodeId of ["onboarding", "wardrobe-sync", "environment-scan"] as const) {
    mission = completeScentMissionNode(mission, nodeId);
  }

  const resolved = await runNode("resolution-standard", mission);
  // Winner is the fresh scent in hot/humid weather; the oud is the alternate.
  assert.equal(resolved.recommendation?.fragranceId, "fresh");
  assert.ok(Array.isArray(resolved.alternates));
  assert.equal(resolved.alternates?.length, 1);
  assert.equal(resolved.alternates?.[0].fragranceId, "heavy");
  // The winner is never duplicated into the alternates list.
  assert.ok(!resolved.alternates?.some((alt) => alt.fragranceId === "fresh"));
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

test("every node-execution reply is free of internal mission-graph jargon", async () => {
  // Walk the full graph plus its degraded branches and assert each user-facing
  // message reads like a concierge, not a developer console.
  const messages: string[] = [];
  const push = (m: string | undefined) => { if (m) messages.push(m); };

  // onboarding: incomplete + completed
  push((await runNode("onboarding", createScentMissionState())).assistantMessage);
  push((await runNode("onboarding", calibratedMission())).assistantMessage);

  // wardrobe-sync: empty (blocked) + synced summary
  const afterOnboarding = completeScentMissionNode(calibratedMission(), "onboarding");
  push((await runNode("wardrobe-sync", afterOnboarding, [])).assistantMessage);
  push((await runNode("wardrobe-sync", afterOnboarding)).assistantMessage);

  // environment-scan
  let env = completeScentMissionNode(afterOnboarding, "wardrobe-sync");
  push((await runNode("environment-scan", env)).assistantMessage);

  // resolution-standard: empty vault (blocked) + winner
  let resolveReady = calibratedMission();
  for (const nodeId of ["onboarding", "wardrobe-sync", "environment-scan"] as const) {
    resolveReady = completeScentMissionNode(resolveReady, nodeId);
  }
  push((await runNode("resolution-standard", resolveReady, [])).assistantMessage);
  push((await runNode("resolution-standard", resolveReady)).assistantMessage);

  // resolution-premium conversion copy + a locked / already-complete refusal
  push((await runNode("resolution-premium", completeScentMissionNode(resolveReady, "resolution-standard"))).assistantMessage);
  push((await runNode("resolution-standard", createScentMissionState())).assistantMessage); // locked refusal

  assert.ok(messages.length >= 8, "expected to exercise every node message");
  for (const message of messages) {
    assert.doesNotMatch(message, NODE_JARGON, `leaked node jargon: ${message}`);
    assert.doesNotMatch(message, SPA_REJECTED, `leaked SPA-stripped jargon: ${message}`);
  }
});
