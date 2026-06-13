/**
 * Beam Agent — HTTP surface (Phase 1, read-only).
 *
 *   POST /api/beam-agent/runs              start a run, returns { runId, eventsUrl }
 *   GET  /api/beam-agent/runs/:id/events   Server-Sent Events progress stream
 *   POST /api/beam-agent/runs/:id/stop     cooperatively stop a run
 *
 * This router is ADDITIVE and NOT mounted anywhere by default — see
 * `mountBeamAgent` and docs/beam-agent/. Mounting is a deliberate, one-line
 * opt-in so the existing app is untouched until you choose to enable it.
 *
 * Run state is in-memory (one process). That is fine for an owner/beta rollout;
 * Phase 5 moves session/run state into Postgres (see the migration plan).
 */
import { Router } from "express";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
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
import { redactEventForClient } from "./beamToolCore.ts";
import type { BeamEmit, BeamRunContext, BeamRunEvent } from "./types.ts";

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

function buildDeps(weather: ScentMissionWeather): BeamToolDeps {
  return {
    loadVault,
    searchCatalog: searchCatalogForBeam,
    research: researchForBeam,
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

  // Fire-and-forget: the client consumes progress over SSE. runBeamAgent never
  // throws, but we guard anyway so a registry record can't be left half-open.
  void runBeamAgent({
    ctx,
    userMessage: message,
    tools,
    emit,
    model: typeof body.model === "string" ? body.model : undefined,
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
  const record = runs.get(req.params.runId);
  if (!record) {
    res.status(404).json({ error: "Run not found." });
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
  const send = (event: BeamRunEvent): void => {
    if (ended) return;
    const safe = redactEventForClient(event);
    res.write(`data: ${JSON.stringify(safe)}\n\n`);
    if (safe.type === "completed" || safe.type === "failed") {
      ended = true;
      record.listeners.delete(send);
      res.end();
    }
  };

  // Replay buffered events first (the run starts before the SSE attaches).
  for (const event of record.events) {
    send(event);
    if (ended) break;
  }
  if (!ended && !record.done) record.listeners.add(send);
  else if (!ended) res.end();

  req.on("close", () => {
    ended = true;
    record.listeners.delete(send);
  });
});

router.post("/runs/:runId/stop", requireAuth, (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).end();
    return;
  }
  const record = runs.get(req.params.runId);
  if (!record) {
    res.status(404).json({ error: "Run not found." });
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
