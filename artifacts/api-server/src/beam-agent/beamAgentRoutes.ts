/**
 * Beam Agent — HTTP surface (Phase 1, read-only).
 *
 *   POST /api/beam-agent/runs              start a run, returns { runId, eventsUrl }
 *   GET  /api/beam-agent/runs/:id/events   Server-Sent Events progress stream
 *   POST /api/beam-agent/runs/:id/stop     cooperatively stop a run
 *
 * This router is mounted by `mountBeamAgent(app)` in app.ts. With no model key
 * configured the loop emits a graceful `model_unavailable` event and the SPA
 * falls back to the scripted /api/scent-mission path.
 *
 * Run state is in-memory (one process). `POST /runs` and the follow-up
 * `GET /runs/:id/events` MUST land on the same instance, so the deploy is pinned
 * to a single replica (`railway.json` → `deploy.numReplicas: 1`; see
 * docs/beam-agent/09-deploy-checklist.md). If that invariant is ever broken the
 * SSE attach 404s — so a missing run is logged as a warning here to make the
 * misconfiguration visible rather than a silent client-side fallback. Phase 5
 * moves session/run state into Postgres and lifts the single-replica limit (see
 * the migration plan).
 */
import { Router } from "express";
import type { Express } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userFragrancesTable } from "@workspace/db/schema";
import {
  sanitizeScentMissionWardrobe,
  sanitizeScentMissionWeather,
  selectScentMissionRecommendation,
  type ScentMissionWardrobeItem,
  type ScentMissionWeather,
} from "@workspace/scent-weather-engine";
import { AuthRequest, requireAuth } from "../middlewares/auth";
import { getTenantId } from "../middlewares/tenant";
import { rateLimitMiddleware } from "../lib/rateLimit";
import { logger } from "../lib/logger";
import { missionItemFromWardrobeRow } from "../services/scentMissionService";
import { searchCatalogCandidates, flattenProfile } from "../services/catalogService";
import { getScentFacts } from "../lib/scent-facts/engine";
import { createBeamTools, type BeamCatalogHit, type BeamToolDeps } from "./beamTools.ts";
import { runBeamAgent } from "./beamAgentLoop.ts";
import { packetFromWardrobeRow, redactEventForClient } from "./beamToolCore.ts";
import { resolveBeamModels } from "./provider.ts";
import type { BeamEmit, BeamRunContext, BeamRunEvent, CandidatePacket, ClaudeMessage } from "./types.ts";
import { createBeamResearcher } from "./research/beamResearch.ts";
import { loadResearchCache, saveResearchCache } from "./research/researchCache.ts";
import { runWebResearch } from "./research/researchProvider.ts";
import {
  degradedResearchModel,
  isResearchEnabled,
  researchEngine,
  researchIncludeDomains,
  researchModelFor,
} from "./research/researchConfig.ts";

const router = Router();

// Runs fan out to an LLM plus catalog/research calls, so throttle well below the
// general API surface. Per-IP fixed window, matching the scent-mission route.
const runRateLimit = rateLimitMiddleware({ limit: 20, windowMs: 5 * 60_000 });

/* ------------------------------------------------------------------ */
/* In-memory run registry                                             */
/* ------------------------------------------------------------------ */

type RunRecord = {
  ctx: BeamRunContext;
  weather: ScentMissionWeather;
  events: BeamRunEvent[];
  listeners: Set<(event: BeamRunEvent) => void>;
  done: boolean;
  stopped: boolean;
  createdAt: number;
};

const runs = new Map<string, RunRecord>();
const RUN_TTL_MS = 30 * 60_000;

function pruneRuns(): void {
  const now = Date.now();
  for (const [id, record] of runs) {
    if (now - record.createdAt > RUN_TTL_MS) runs.delete(id);
  }
}

/* ------------------------------------------------------------------ */
/* In-memory conversation memory (per session, tenant/user scoped)    */
/* ------------------------------------------------------------------ */

/**
 * Clean conversational history — only the user/assistant TEXT turns, never the
 * intermediate tool plumbing — so follow-ups in a session keep context. In-memory
 * and TTL-bounded, mirroring the run registry; Phase 5 moves this to Postgres.
 */
type SessionRecord = { turns: ClaudeMessage[]; updatedAt: number };
const sessions = new Map<string, SessionRecord>();
const SESSION_TTL_MS = 60 * 60_000;
const MAX_SESSION_TURNS = 16;

function sessionKey(ctx: BeamRunContext): string {
  return `${ctx.tenantId}:${ctx.userId}:${ctx.sessionId}`;
}

/** Short, stable, non-reversible user tag for logs — never log the raw user id. */
function hashUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [key, record] of sessions) {
    if (now - record.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

function loadSessionHistory(ctx: BeamRunContext): ClaudeMessage[] {
  pruneSessions();
  return sessions.get(sessionKey(ctx))?.turns.slice() ?? [];
}

function appendSessionTurn(ctx: BeamRunContext, userMessage: string, assistantText: string): void {
  const key = sessionKey(ctx);
  const record = sessions.get(key) ?? { turns: [], updatedAt: Date.now() };
  record.turns.push({ role: "user", content: userMessage });
  record.turns.push({ role: "assistant", content: assistantText });
  if (record.turns.length > MAX_SESSION_TURNS) record.turns = record.turns.slice(-MAX_SESSION_TURNS);
  record.updatedAt = Date.now();
  sessions.set(key, record);
}

function makeEmit(record: RunRecord): BeamEmit {
  return (event) => {
    record.events.push(event);
    if (event.type === "completed" || event.type === "failed") record.done = true;
    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE client must never break the agent run.
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Dependency wiring (real services)                                  */
/* ------------------------------------------------------------------ */

async function loadVault(ctx: BeamRunContext): Promise<ScentMissionWardrobeItem[]> {
  const rows = await db
    .select({ id: userFragrancesTable.id, fragranceData: userFragrancesTable.fragranceData })
    .from(userFragrancesTable)
    .where(and(eq(userFragrancesTable.tenantId, ctx.tenantId), eq(userFragrancesTable.userId, ctx.userId)))
    .orderBy(asc(userFragrancesTable.createdAt), asc(userFragrancesTable.id));

  return sanitizeScentMissionWardrobe(
    rows
      .map((row) => missionItemFromWardrobeRow(row.id, row.fragranceData))
      .filter((item) => item !== null),
  );
}

async function loadWardrobePackets(ctx: BeamRunContext): Promise<CandidatePacket[]> {
  const rows = await db
    .select({ id: userFragrancesTable.id, fragranceData: userFragrancesTable.fragranceData })
    .from(userFragrancesTable)
    .where(and(eq(userFragrancesTable.tenantId, ctx.tenantId), eq(userFragrancesTable.userId, ctx.userId)))
    .orderBy(asc(userFragrancesTable.createdAt), asc(userFragrancesTable.id));

  const packets: CandidatePacket[] = [];
  for (const row of rows) {
    const packet = packetFromWardrobeRow(row.id, row.fragranceData);
    if (packet) packets.push(packet);
  }
  return packets;
}

async function searchCatalogForBeam(query: string, limit: number): Promise<BeamCatalogHit[]> {
  const hits = await searchCatalogCandidates(query, { limit });
  return hits.map((hit) => {
    const flat = flattenProfile(hit.profile) as Record<string, unknown>;
    const brand = typeof flat.brand === "string" ? flat.brand : "";
    const name = typeof flat.name === "string" ? flat.name : "";
    const id =
      typeof flat.id === "string" && flat.id ? flat.id : `${brand}::${name}`.toLowerCase();
    return { id, flat, score: hit.score };
  });
}

async function researchForBeam(name: string): Promise<Record<string, unknown> | null> {
  try {
    const facts = await getScentFacts({ fragranceName: name, save: false });
    return facts as unknown as Record<string, unknown>;
  } catch {
    // Research is best-effort; a failed lookup just yields no extra facts.
    return null;
  }
}

// Stateless across runs, so build the researcher once. Internally it no-ops
// (returns a `note`) unless BEAM_RESEARCH_ENABLED + OPENROUTER_API_KEY are set,
// so wiring it here is safe before the lane is turned on in any environment.
const beamResearchWeb = createBeamResearcher({
  loadCache: loadResearchCache,
  saveCache: saveResearchCache,
  runWebResearch,
  modelFor: researchModelFor,
  degradedModel: degradedResearchModel,
  engine: researchEngine,
  includeDomains: researchIncludeDomains,
  isEnabled: isResearchEnabled,
});

function buildDeps(weather: ScentMissionWeather): BeamToolDeps {
  return {
    loadVault,
    loadWardrobePackets,
    searchCatalog: searchCatalogForBeam,
    research: researchForBeam,
    researchWeb: beamResearchWeb,
    scoreVault: (items, calibration, currentWeather) =>
      selectScentMissionRecommendation(items, calibration, currentWeather),
    getWeather: async () => weather,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

router.post("/runs", runRateLimit, requireAuth, async (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  pruneRuns();
  const runId = `run_${randomUUID()}`;
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : `beam_${randomUUID()}`;
  const ctx: BeamRunContext = { runId, sessionId, tenantId: getTenantId(req), userId: req.user.id };

  const uiContext = (typeof body.uiContext === "object" && body.uiContext !== null
    ? body.uiContext
    : {}) as Record<string, unknown>;
  const weather = sanitizeScentMissionWeather(uiContext.weather);

  const record: RunRecord = {
    ctx,
    weather,
    events: [],
    listeners: new Set(),
    done: false,
    stopped: false,
    createdAt: Date.now(),
  };
  runs.set(runId, record);

  const tools = createBeamTools(buildDeps(weather));
  const emit = makeEmit(record);
  const history = loadSessionHistory(ctx);
  const models = resolveBeamModels();

  // Fire-and-forget: the client consumes progress over SSE. runBeamAgent never
  // throws, but we guard anyway so a registry record can't be left half-open.
  // The model is chosen server-side (cheap orchestration tier + strong synthesis
  // tier); a client-supplied `body.model` is intentionally NOT honored so a caller
  // can't pin an expensive or unprovisioned slug.
  void runBeamAgent({
    ctx,
    userMessage: message,
    tools,
    emit,
    model: models?.model,
    synthesisModel: models?.synthesisModel,
    history,
    onComplete: (assistantText) => appendSessionTurn(ctx, message, assistantText),
    onSummary: (summary) => {
      logger.info(
        {
          beam: {
            runId: summary.runId,
            user: hashUser(ctx.userId),
            outcome: summary.outcome,
            failureCode: summary.failureCode,
            turns: summary.turns,
            tools: summary.tools,
            modelCalls: summary.modelCalls,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            usedSynthesis: summary.usedSynthesis,
            synthesisFailed: summary.synthesisFailed,
            ms: summary.ms,
          },
        },
        "beam agent run finished",
      );
    },
    shouldStop: () => record.stopped,
  }).catch((err) => {
    logger.error({ err }, "beam agent run crashed");
    emit({ type: "failed", code: "agent_error", message: "Beam Agent failed unexpectedly." });
  });

  res.status(202).json({ runId, sessionId, eventsUrl: `/api/beam-agent/runs/${runId}/events` });
});

router.get("/runs/:runId/events", requireAuth, (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).end();
    return;
  }
  const runId = String(req.params.runId);
  const record = runs.get(runId);
  if (!record) {
    // The run was created by POST /runs but isn't in THIS process's registry.
    // Almost always one of: (a) the deploy is running >1 replica and the SSE
    // attach landed on a different instance than the POST — the single-replica
    // invariant (railway.json numReplicas:1) is broken; (b) the run aged out of
    // the TTL window; (c) the process restarted mid-run. Log it so the topology
    // bug is visible in Railway logs instead of only as a silent client fallback.
    logger.warn({ runId, knownRuns: runs.size }, "beam agent run not found for SSE attach");
    res.status(404).json({ error: "Run not found.", code: "run_not_found" });
    return;
  }
  if (record.ctx.userId !== req.user.id || record.ctx.tenantId !== getTenantId(req)) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": beam-agent stream open\n\n");

  let ended = false;
  // Heartbeat: idle proxies (Railway/Vercel/Cloudflare) can drop a connection
  // with no traffic, and an agent run can go many seconds between events. A
  // comment frame every 15s keeps the stream alive without affecting the client.
  const heartbeat = setInterval(() => {
    if (ended) return;
    try {
      res.write(": ping\n\n");
    } catch {
      // Write after close — let the close handler clean up.
    }
  }, 15_000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const finish = (): void => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    record.listeners.delete(send);
  };
  const send = (event: BeamRunEvent): void => {
    if (ended) return;
    const safe = redactEventForClient(event);
    res.write(`data: ${JSON.stringify(safe)}\n\n`);
    if (safe.type === "completed" || safe.type === "failed") {
      finish();
      res.end();
    }
  };

  // Replay buffered events first (the run starts before the SSE attaches).
  for (const event of record.events) {
    send(event);
    if (ended) break;
  }
  if (!ended && !record.done) record.listeners.add(send);
  else if (!ended) {
    finish();
    res.end();
  }

  req.on("close", finish);
});

router.post("/runs/:runId/stop", requireAuth, (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).end();
    return;
  }
  const record = runs.get(String(req.params.runId));
  if (!record) {
    res.status(404).json({ error: "Run not found.", code: "run_not_found" });
    return;
  }
  if (record.ctx.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }
  record.stopped = true;
  res.json({ ok: true });
});

export const beamAgentRouter = router;

/** One-line opt-in mount. Call from app.ts when you're ready to enable Beam. */
export function mountBeamAgent(app: Express): void {
  app.use("/api/beam-agent", router);
}

export default router;
