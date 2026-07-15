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
 * Run state is in-memory (the local `runs` Map = the fast path) AND mirrored to
 * Redis when `REDIS_URL` is configured (Phase 5, `beamRunStore.ts`). Same-replica
 * attaches stream from memory exactly as before (incl. live message_delta). When
 * `POST /runs` and the follow-up `GET /runs/:id/events` land on DIFFERENT replicas
 * (or the process restarted), the GET falls back to Redis — replaying the durable
 * event stream and poll-tailing to completion — instead of 404'ing. This lifts the
 * single-replica requirement: once `REDIS_URL` is set and SSE-through-the-proxy is
 * verified in staging, `railway.json` → `deploy.numReplicas` may be raised (see
 * docs/beam-agent/09-deploy-checklist.md). With Redis OFF the behavior is unchanged:
 * the run lives only in this process, so a cross-instance/restart attach 404s and is
 * logged as a warning, and the client falls back to the scripted mission.
 */
import { Router } from "express";
import type { Express } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userFragrancesTable } from "@workspace/db/schema";
import {
  rankScentMissionRecommendations,
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
import { searchCatalogCandidates, searchCatalogProfileCandidates, flattenProfile, getCatalogEntry } from "../services/catalogService";
import { getScentFacts } from "../lib/scent-facts/engine";
import { getBeamUserUsageSince, recordBeamRunUsage } from "../services/apiUsageLedger";
import {
  BeamFeedbackUnavailableError,
  applyFeedbackToScentPreferences,
  beamAnswerLogExistsForUser,
  recordBeamAnswerFeedback,
  recordBeamAnswerLog,
} from "../services/beamAnswerLog";
import { loadBeamConversationHistory, persistBeamConversationTurn } from "../services/beamConversationStore";
import { enqueueBeamCuration } from "../services/curationService";
import { fetchEngineEnrichmentState } from "../services/enrichmentProcessor";
import { createBeamTools, type BeamCatalogHit, type BeamToolDeps } from "./beamTools.ts";
import { fragranceIdentityKey } from "./fragranceIdentity.ts";
import { runBeamAgent } from "./beamAgentLoop.ts";
import { packetFromWardrobeRow, redactEventForClient } from "./beamToolCore.ts";
import { isBeamAgentEnabled, resolveBeamBudget, resolveBeamModels, validateBeamModelConfig } from "./provider.ts";
import {
  buildObservatoryFeed,
  isObservatoryAuthorized,
  isObservatoryEnabled,
  recordObservatoryRun,
} from "./beamObservatory.ts";
import { selectConciergeLane } from "./laneSelector.ts";
import { candidateMatchesAvoid, excludeAvoidedHits, parseAvoidTerms } from "./avoidFilter.ts";
import { discoverExternalCandidates } from "../services/engineDiscover";
import { externalDetailRunCap, isDiscoverExternalEnabled } from "./discoveryConfig.ts";
import { parseBudgetCeiling } from "./budgetGate.ts";
import { validateBeamFeedbackInput } from "./beamFeedbackCore.ts";
import { appendSessionTurn, loadSession, saveSessionState } from "./beamSessionStore.ts";
import {
  appendRunEvent,
  clearActiveSession,
  createRunMeta,
  isRunDone,
  isRunStopped,
  loadRunMeta,
  markRunDone,
  markRunStopped,
  readRunEventsAfter,
  tryAcquireActiveSession,
} from "./beamRunStore.ts";
import { isRedisConfigured } from "../lib/redisClient.ts";
import { deriveBeamSessionState, inferPendingSlotFromAssistant } from "./missionState.ts";
import type { BeamEmit, BeamRunContext, BeamRunEvent, BeamSessionState, CandidatePacket } from "./types.ts";
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
const runRateLimit = rateLimitMiddleware({ name: "beam-runs", limit: 20, windowMs: 5 * 60_000 });

/* ------------------------------------------------------------------ */
/* Per-user daily quota (cost guardrail, complements the per-IP limit) */
/* ------------------------------------------------------------------ */

// The per-IP rate limit above caps burst abuse; this per-USER daily cap is the
// billing guardrail against a single account (or a runaway client loop) racking
// up model spend over a day. Both a run-count and a USD cap are enforced off the
// already-captured ledger usage; whichever trips first blocks the run. Tunable
// per environment; the defaults are generous for a normal concierge session.
const BEAM_USER_DAILY_WINDOW_MS = 24 * 60 * 60_000;

function positiveNumberFromEnv(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const BEAM_USER_DAILY_RUN_CAP = positiveNumberFromEnv(process.env.BEAM_USER_DAILY_RUN_CAP, 60);
const BEAM_USER_DAILY_SPEND_USD = positiveNumberFromEnv(process.env.BEAM_USER_DAILY_SPEND_USD, 2);
// Tag stored in the ledger's `provider` column so beam rows are cleanly
// separable (via the provider/operation index) from the image-generation rows.
const BEAM_USAGE_PROVIDER = "beam-agent";
const BEAM_DISABLED_MESSAGE = "Beam Agent is currently turned off.";

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
// How often the producing replica polls the shared Redis stopped flag into its
// local record (cross-replica cooperative stop). A few seconds is responsive
// enough for a cancel while costing ~one cheap GET per active run per tick.
const STOP_REFRESH_MS = 4_000;
// Poll cadence for the cross-replica SSE tail (consumer replay path). Tight
// enough that structural events feel live, loose enough to keep Redis load low.
const SSE_POLL_MS = 250;

function pruneRuns(): void {
  const now = Date.now();
  for (const [id, record] of runs) {
    if (now - record.createdAt > RUN_TTL_MS) runs.delete(id);
  }
}

function hasActiveSessionRun(ctx: BeamRunContext): boolean {
  for (const record of runs.values()) {
    if (
      !record.done &&
      !record.stopped &&
      record.ctx.tenantId === ctx.tenantId &&
      record.ctx.userId === ctx.userId &&
      record.ctx.sessionId === ctx.sessionId
    ) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Conversation memory lives in beamSessionStore (in-memory or Redis). */
/* ------------------------------------------------------------------ */

/** Short, stable, non-reversible user tag for logs — never log the raw user id. */
function hashUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

function makeEmit(record: RunRecord): BeamEmit {
  return (event) => {
    record.events.push(event);
    const terminal = event.type === "completed" || event.type === "failed";
    if (terminal) record.done = true;
    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE client must never break the agent run.
      }
    }
    // Durable cross-replica mirror (Phase 5). Fire-and-forget and best-effort:
    // a Redis hiccup must never affect the run or the local stream. `appendRunEvent`
    // skips `message_delta` internally; on a terminal event we flip the shared
    // done flag (so a tailing consumer can stop) and release the session lock.
    void appendRunEvent(record.ctx.runId, event);
    if (terminal) {
      void markRunDone(record.ctx.runId);
      void clearActiveSession(record.ctx);
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

async function loadVaultForOwnership(ctx: BeamRunContext): Promise<ScentMissionWardrobeItem[]> {
  const rows = await db
    .select({ id: userFragrancesTable.id, fragranceData: userFragrancesTable.fragranceData })
    .from(userFragrancesTable)
    .where(and(eq(userFragrancesTable.tenantId, ctx.tenantId), eq(userFragrancesTable.userId, ctx.userId)))
    .orderBy(asc(userFragrancesTable.createdAt), asc(userFragrancesTable.id));
  const items: ScentMissionWardrobeItem[] = [];
  for (const row of rows) {
    const projected = missionItemFromWardrobeRow(row.id, row.fragranceData);
    if (!projected) continue;
    const item = sanitizeScentMissionWardrobe([projected])[0];
    if (item) items.push(item);
  }
  return items;
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
  const hits = await searchCatalogProfileCandidates(query, { limit });
  return hits.map((hit) => {
    const flat = flattenProfile(hit.profile) as Record<string, unknown>;
    const brand = typeof flat.brand === "string" ? flat.brand : "";
    const name = typeof flat.name === "string" ? flat.name : "";
    const id =
      typeof flat.id === "string" && flat.id ? flat.id : `${brand}::${name}`.toLowerCase();
    return { id, flat, score: hit.score };
  });
}

/**
 * Resolve ONE catalog fragrance to its full flattened profile for an add-ready
 * proposal: exact brand+name lookup first, then a top-hit search fallback so a
 * brandless or slightly-off name still resolves to a real catalog record.
 */
async function resolveCatalogEntryForBeam(
  name: string,
  brand?: string,
): Promise<Record<string, unknown> | null> {
  if (brand) {
    const exact = await getCatalogEntry(brand, name).catch(() => null);
    if (exact) return flattenProfile(exact) as Record<string, unknown>;
  }
  const query = `${brand ?? ""} ${name}`.trim();
  const hits = await searchCatalogCandidates(query, { limit: 1 }).catch(() => []);
  if (hits.length > 0) return flattenProfile(hits[0].profile) as Record<string, unknown>;
  return null;
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

function buildDeps(ctx: BeamRunContext, weather: ScentMissionWeather, sessionState?: BeamSessionState): BeamToolDeps {
  // Per-run identity registry: maps a recommended fragrance's brand+name key to
  // the version-precise engine source URL captured when discovery surfaced it.
  // The verify (`checkEnrichmentState`) and enqueue (`enqueueCuration`) paths
  // consult it so they act on the EXACT recommended version instead of
  // re-resolving by free-text name — which collapsed flankers/concentrations
  // ("Sauvage" vs "Sauvage Elixir") onto whatever a fresh search ranked first.
  // The model never sees these URLs; the key is reproduced from the name+brand
  // it already passes, so the tool surface stays unchanged.
  const candidateSourceUrls = new Map<string, string>();
  const rememberSourceUrl = (
    name: string,
    brand: string | null | undefined,
    sourceUrl: string | null | undefined,
  ): void => {
    const url = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
    if (!url) return;
    const key = fragranceIdentityKey(brand, name);
    if (key) candidateSourceUrls.set(key, url);
  };
  const lookupSourceUrl = (name: string, brand: string | null | undefined): string | null =>
    candidateSourceUrls.get(fragranceIdentityKey(brand, name)) ?? null;

  // Captured dislikes shape retrieval, not just wording (audit A3): wrap catalog
  // search so candidates built around an avoided note/family are dropped before
  // the model ever sees them. Over-fetch a little then trim, so the requested
  // limit is still met after exclusion when possible.
  const avoid = sessionState?.slots.avoid;
  const searchCatalog: typeof searchCatalogForBeam = avoid
    ? async (query, limit) => {
        const hits = await searchCatalogForBeam(query, Math.min(limit * 2, limit + 12));
        return excludeAvoidedHits(hits, avoid).slice(0, limit);
      }
    : searchCatalogForBeam;

  // Hybrid-corpus external discovery (opt-in per env). Stack a per-RUN /details
  // budget on the per-call cap so a multi-call run can't multiply Decodo spend,
  // and drop avoided notes/families the same way catalog search does. Left
  // undefined when disabled so `beam_discover_external` is simply not exposed.
  const avoidTerms = avoid ? parseAvoidTerms(avoid) : [];
  let externalDetailBudget = externalDetailRunCap();
  // H2: reserve the /details grant SYNCHRONOUSLY before the await so the
  // read-clamp and the write-decrement don't straddle the round-trip. The prior
  // check-then-act was only safe while tool dispatch stayed strictly sequential;
  // reserving up-front keeps the per-run Decodo cap correct even if calls ever
  // run concurrently. We reconcile (refund) the unspent grant after the await.
  const reserveDetailBudget = (want: number): number => {
    const grant = Math.max(0, Math.min(Math.floor(want), externalDetailBudget));
    externalDetailBudget -= grant;
    return grant;
  };
  const discoverExternal: BeamToolDeps["discoverExternal"] = isDiscoverExternalEnabled()
    ? async (query, opts) => {
        const detailLimit = reserveDetailBudget(opts.detailLimit);
        const candidates = await discoverExternalCandidates(query, { limit: opts.limit, detailLimit });
        // Capture each discovered pick's version-precise engine source URL so a
        // later verify/enqueue for it acts on THIS exact version, not a re-search.
        for (const candidate of candidates) {
          rememberSourceUrl(candidate.name, candidate.brand, candidate.sourceUrl);
        }
        // Count ATTEMPTS, not successes: enrichCandidate marks `detailed` on every
        // /details attempt (incl. thin bodies) so the spend is debited. Refund the
        // reserved grant we didn't actually spend back into the run budget.
        const spent = candidates.filter((c) => c.detailed).length;
        externalDetailBudget += detailLimit - spent;
        if (avoidTerms.length === 0) return candidates;
        return candidates.filter(
          (c) =>
            !candidateMatchesAvoid(
              { name: c.name, brand: c.brand, family: c.family, accords: c.accords, notes: c.notes },
              avoidTerms,
            ),
        );
      }
    : undefined;

  // Honest price/budget gating (audit F): a NUMERIC ceiling from the `budget`
  // slot lets discovery downrank known-over-budget picks. Qualitative budgets
  // ("Premium") yield null — no fake number is enforced. `avoidTerms` is also
  // handed to the tools so `beam_find_similar` honors dislikes explicitly.
  const budgetCeiling = parseBudgetCeiling(sessionState?.slots.budget);

  return {
    loadVault,
    loadVaultForOwnership,
    loadWardrobePackets,
    searchCatalog,
    discoverExternal,
    budgetCeiling,
    avoidTerms,
    resolveCatalogEntry: resolveCatalogEntryForBeam,
    research: researchForBeam,
    researchWeb: beamResearchWeb,
    // Curation hook: when a proposed fragrance isn't in our catalog, enqueue it
    // for enrichment tagged to THIS authenticated user (scope comes from ctx, never
    // model args). Fire-and-forget — the beam loop must not wait on (or fail from)
    // a queue write — so we kick the promise and swallow any error.
    enqueueCuration: (fragrance, opts) => {
      void enqueueBeamCuration({
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        name: fragrance.name,
        brand: fragrance.brand,
        // Pin the EXACT recommended version when discovery captured its source URL,
        // so the enrichment job is keyed on the canonical fg_url and the worker
        // enriches this version instead of re-resolving the name into a sibling.
        fgUrl: lookupSourceUrl(fragrance.name, fragrance.brand),
        runId: opts?.runId ?? null,
        notify: opts?.notify,
      }).catch((err) => {
        logger.warn({ err, user: hashUser(ctx.userId) }, "beam curation enqueue failed");
      });
    },
    // Enrichment-state verification: report whether a fragrance is fully enriched
    // using the cheap CACHED engine state (no billed live scrape), so the agent can
    // gate what it presents and defer un-enriched picks to "researching, will notify".
    checkEnrichmentState: (fragrance) => {
      // Verify the EXACT recommended version: when discovery captured this pick's
      // source URL, read its cached enrichment state directly instead of probing
      // whatever a fresh name search ranks first (a flanker/concentration sibling).
      const sourceUrl = lookupSourceUrl(fragrance.name, fragrance.brand);
      return fetchEngineEnrichmentState(
        fragrance.name,
        fragrance.brand ?? null,
        sourceUrl ? { sourceUrl } : undefined,
      );
    },
    scoreVault: (items, calibration, currentWeather) =>
      selectScentMissionRecommendation(items, calibration, currentWeather),
    rankVault: (items, calibration, currentWeather) =>
      rankScentMissionRecommendations(items, calibration, currentWeather),
    getWeather: async () => weather,
    ...(sessionState?.mission?.intent === "travel_kit" && sessionState.mission.destination
      ? { requiredDestinationClimate: {
          destination: sessionState.mission.destination,
          ...(sessionState.mission.month ? { month: sessionState.mission.month } : {}),
        } }
      : {}),
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

  // Global runtime kill-switch (env-driven; default ON). When an operator sets
  // BEAM_AGENT_ENABLED to a falsey value the agent is OFF for ALL users without a
  // code change: we emit one graceful `beam_disabled` failure and the SPA silently
  // falls back to the scripted mission (the code is in its fallback set). No model
  // call, tool work, ledger write, or quota read happens on a disabled run.
  if (!isBeamAgentEnabled()) {
    pruneRuns();
    const runId = `run_${randomUUID()}`;
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId ? body.sessionId : `beam_${randomUUID()}`;
    const ctx: BeamRunContext = { runId, sessionId, tenantId: getTenantId(req), userId: req.user.id };
    const record: RunRecord = {
      ctx,
      weather: sanitizeScentMissionWeather(undefined),
      events: [],
      listeners: new Set(),
      done: false,
      stopped: false,
      createdAt: Date.now(),
    };
    runs.set(runId, record);
    makeEmit(record)({ type: "failed", code: "beam_disabled", message: BEAM_DISABLED_MESSAGE });
    res.status(202).json({ runId, sessionId, eventsUrl: `/api/beam-agent/runs/${runId}/events` });
    return;
  }

  // Per-user daily cost guardrail. Read the user's last-24h beam usage off the
  // ledger and refuse a new run once either the run-count or the spend cap is
  // hit. Fail-open by construction: getBeamUserUsageSince returns zeros when the
  // ledger is unavailable, so a DB hiccup never locks users out of the agent.
  const usageWindow = await getBeamUserUsageSince(req.user.id, Date.now() - BEAM_USER_DAILY_WINDOW_MS);
  if (
    usageWindow.runCount >= BEAM_USER_DAILY_RUN_CAP ||
    usageWindow.totalUsd >= BEAM_USER_DAILY_SPEND_USD
  ) {
    logger.warn(
      {
        user: hashUser(req.user.id),
        runCount: usageWindow.runCount,
        totalUsd: Number(usageWindow.totalUsd.toFixed(4)),
        runCap: BEAM_USER_DAILY_RUN_CAP,
        spendCapUsd: BEAM_USER_DAILY_SPEND_USD,
      },
      "beam agent per-user daily quota reached",
    );
    res.status(429).json({
      error: "You've reached today's Beam Agent limit. It resets tomorrow — meanwhile the scripted mission still works.",
      code: "user_daily_quota_exceeded",
    });
    return;
  }

  pruneRuns();
  const runId = `run_${randomUUID()}`;
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : `beam_${randomUUID()}`;
  const ctx: BeamRunContext = { runId, sessionId, tenantId: getTenantId(req), userId: req.user.id };
  // One active Beam turn per session. The local guard catches same-replica
  // concurrency; `tryAcquireActiveSession` is the cross-replica guard (a Redis
  // SET NX lock). `||` short-circuits so we never take a lock for a run we then
  // reject locally; the lock is permissive (returns true) when Redis is absent,
  // so single-replica behavior is unchanged. Released on the terminal event.
  if (hasActiveSessionRun(ctx) || !(await tryAcquireActiveSession(ctx))) {
    res.status(409).json({ error: "A Beam turn is already running for this session.", code: "session_run_in_progress" });
    return;
  }

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
  // Persist run metadata BEFORE returning 202, so a follow-up SSE attach that
  // lands on another replica can authorize and bound the stream. Awaited (one
  // Redis round-trip) to win the race with the client's immediate GET; a no-op
  // when Redis is absent.
  await createRunMeta(ctx);

  const emit = makeEmit(record);
  const session = await loadSession(ctx);
  const history = session.turns;
  const lastAssistantText = [...history]
    .reverse()
    .find((turn) => turn.role === "assistant" && typeof turn.content === "string")?.content;
  const pendingSlot = typeof lastAssistantText === "string"
    ? inferPendingSlotFromAssistant(lastAssistantText)
    : undefined;
  const sessionState = deriveBeamSessionState(session.state, message, pendingSlot);
  await saveSessionState(ctx, sessionState);
  const tools = createBeamTools(buildDeps(ctx, weather, sessionState));
  // Surface the freshly-merged structured slots/mission to the client up front,
  // BEFORE the loop runs — so the panel can advance its captured-cue count and
  // mission-aware header straight from free-text (the agent path never calls the
  // SPA's setFacets). Emitted ahead of the loop so it lands even on a failed or
  // timed-out turn, matching the backend's persist-before-run guarantee.
  emit({ type: "slots", slots: sessionState.slots, mission: sessionState.mission });
  // Pick the cost lane deterministically (brief §03.2) from the message + how much
  // context the session already carries — no extra router LLM call. The premium
  // lane runs MiniMax M3 end-to-end; the default lane runs cheap M2.5 orchestration.
  const lane = selectConciergeLane({ message, historyTurns: history.length, activeMissionIntent: sessionState.mission?.intent });
  const models = resolveBeamModels(lane);
  // Per-lane run guardrails (tool-round + output-token caps). Defaults match the
  // historical hardcoded limits; env can lower them per lane to bound the bill when
  // a cheaper/reasoning closer is in play (brief §03.2). See resolveBeamBudget.
  const budget = resolveBeamBudget(lane);

  // Cross-replica stop: a `POST /stop` can land on a different replica than the
  // one running this loop. That replica only sets the shared Redis stopped flag,
  // so the producing replica polls it into `record.stopped` here, keeping the
  // loop's `shouldStop` a cheap synchronous read. Only armed when Redis is
  // configured (otherwise a same-replica stop sets `record.stopped` directly);
  // unref'd so it never holds the process open. Cleared when the run settles.
  const stopRefresh = isRedisConfigured()
    ? setInterval(() => {
        void isRunStopped(runId).then((stopped) => {
          if (stopped) record.stopped = true;
        });
      }, STOP_REFRESH_MS)
    : null;
  if (stopRefresh && typeof stopRefresh.unref === "function") stopRefresh.unref();

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
    maxTurns: budget.maxTurns,
    orchestrationMaxTokens: budget.orchestrationMaxTokens,
    synthesisMaxTokens: budget.synthesisMaxTokens,
    history,
    sessionState,
    onComplete: (assistantText) => {
      // Hot path: Redis/in-memory session memory (1h TTL) the loop reads each turn.
      void appendSessionTurn(ctx, message, assistantText, sessionState);
      // Durable path (W-11): survives TTL expiry / restart, reloadable via
      // GET /conversations/:sessionId. Best-effort — never blocks or fails the run.
      void persistBeamConversationTurn({ ctx, userMessage: message, assistantText });
    },
    onSummary: (summary) => {
      // Coarse, non-PII scenario label for the observatory feed.
      const scenario =
        sessionState.mission?.intent === "travel_kit"
          ? "travel_kit"
          : sessionState.mission?.intent === "recommendation"
            ? "recommendation"
            : "chat";
      logger.info(
        {
          beam: {
            runId: summary.runId,
            user: hashUser(ctx.userId),
            lane,
            scenario,
            outcome: summary.outcome,
            failureCode: summary.failureCode,
            turns: summary.turns,
            tools: summary.tools,
            modelCalls: summary.modelCalls,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            usedSynthesis: summary.usedSynthesis,
            synthesisFailed: summary.synthesisFailed,
            synthesisFailureReason: summary.synthesisFailureReason,
            // Model slugs make the latency/cost audit (brief §C) diagnosable from logs:
            // whether a slow/failed turn ran an unexpectedly heavy orchestration/closer.
            orchestrationModel: summary.orchestrationModel,
            synthesisModel: summary.synthesisModel,
            groundedNames: summary.groundedNames,
            estimatedCostUsd: summary.estimatedCostUsd,
            qualityGatePassed: summary.qualityGatePassed,
            qualityViolations: summary.qualityViolations,
            ms: summary.ms,
          },
        },
        "beam agent run finished",
      );
      // Feed the redacted summary to the beta observatory ring buffer. The buffer
      // records regardless of the enabled flag (cheap, bounded, no PII); the GATE
      // is the read endpoint. Never let observability affect the run.
      recordObservatoryRun({
        summary,
        lane,
        orchestrationModel: models?.model,
        synthesisModel: models?.synthesisModel,
        scenario,
      });
      // Persist the run to the shared usage ledger so the per-user daily cap and
      // the daily-spend metric have data to read. Best-effort + non-blocking: a
      // ledger write must never affect the run or its SSE stream.
      void recordBeamRunUsage({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        provider: BEAM_USAGE_PROVIDER,
        model: models?.synthesisModel ?? models?.model ?? lane,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        estimatedCostUsd: summary.estimatedCostUsd,
        status: summary.outcome === "completed" ? "success" : "failure",
        failureReason: summary.failureCode ?? null,
      }).catch(() => {
        // Best-effort ledger write: tenant resolution can reject outside the
        // function's own try/catch, so guard the floating promise here too.
      });
      // Persist the durable per-turn answer log keyed by the run id (= the
      // answerLogId the client received in the completed event). This is the
      // record a user feedback report attaches to, and the reproducible input →
      // candidates → answer a downvote becomes a regression fixture from. Best-
      // effort + non-blocking: a logging failure must never affect the run.
      // A failed run skips onComplete/appendSessionTurn, but the loop may still
      // have mutated the shared session state in a way the user SAW — e.g. a
      // validated travel-kit card flushed before a prose gate failure sets
      // mission.kitPresented. Re-persist so the next turn treats the presented
      // kit as presented instead of re-running creation gates. Best-effort.
      if (summary.outcome === "failed") {
        void saveSessionState(ctx, sessionState).catch(() => {});
      }
      void recordBeamAnswerLog({
        id: summary.runId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        userMessage: message,
        derivedState: sessionState,
        lane,
        orchestrationModel: summary.orchestrationModel ?? models?.model ?? null,
        synthesisModel: summary.synthesisModel ?? models?.synthesisModel ?? null,
        groundedCandidates: summary.groundedFragranceList.map((f) => ({
          canonicalName: f.canonicalName,
          ...(f.brand ? { brand: f.brand } : {}),
          owned: f.owned,
        })),
        finalAnswer: summary.finalAnswer,
        gatePassed: summary.qualityGatePassed,
        gateViolations: summary.qualityViolations,
        shippedWithSoftViolations: summary.shippedWithSoftViolations,
        outcome: summary.outcome,
        failureCode: summary.failureCode ?? null,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
      }).catch(() => {
        // Best-effort answer log: never let a rejected write surface as an
        // unhandled rejection or affect the run.
      });
    },
    shouldStop: () => record.stopped,
  }).catch((err) => {
    logger.error({ err }, "beam agent run crashed");
    emit({ type: "failed", code: "agent_error", message: "Beam Agent failed unexpectedly." });
  }).finally(() => {
    if (stopRefresh) clearInterval(stopRefresh);
  });

  res.status(202).json({ runId, sessionId, eventsUrl: `/api/beam-agent/runs/${runId}/events` });
});

router.get("/runs/:runId/events", requireAuth, async (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).end();
    return;
  }
  const runId = String(req.params.runId);
  const record = runs.get(runId);

  /* --- Fast path: the run lives in THIS process's registry (same replica, the
     common case and always true at numReplicas:1). Stream from the in-memory
     buffer + live listener, including live message_delta tokens — unchanged. --- */
  if (record) {
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
    return;
  }

  /* --- Cross-replica / post-restart fallback (Phase 5). The run was created by
     POST /runs on a DIFFERENT replica (or this process restarted mid-run). If
     Redis holds the run's metadata, authorize against it and stream from the
     durable event stream — replay the buffer, then poll-tail to the terminal
     event. This is the case that used to 404 `run_not_found` every time under
     >1 replica. message_delta isn't mirrored, so this path delivers structural
     events + the full `completed` response, just without live token preview. --- */
  const meta = await loadRunMeta(runId);
  if (!meta) {
    // Genuinely unknown: Redis is off (single-replica invariant still holds and
    // the run aged out / restarted), or the id is bogus. Same observable result
    // as before — log it and let the client fall back to the scripted mission.
    logger.warn({ runId, knownRuns: runs.size }, "beam agent run not found for SSE attach");
    res.status(404).json({ error: "Run not found.", code: "run_not_found" });
    return;
  }
  if (meta.ctx.userId !== req.user.id || meta.ctx.tenantId !== getTenantId(req)) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": beam-agent stream open (shared)\n\n");

  let ended = false;
  let lastId = "0";
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const heartbeat = setInterval(() => {
    if (ended) return;
    try {
      res.write(": ping\n\n");
    } catch {
      // Write after close — the close handler cleans up.
    }
  }, 15_000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const finish = (): void => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    if (pollTimer) clearTimeout(pollTimer);
  };
  // Returns true once a terminal event was written (the stream is closed).
  const send = (event: BeamRunEvent): boolean => {
    if (ended) return false;
    const safe = redactEventForClient(event);
    res.write(`data: ${JSON.stringify(safe)}\n\n`);
    if (safe.type === "completed" || safe.type === "failed") {
      finish();
      res.end();
      return true;
    }
    return false;
  };

  const poll = async (): Promise<void> => {
    if (ended || polling) return;
    polling = true;
    try {
      const entries = await readRunEventsAfter(runId, lastId);
      for (const { id, event } of entries) {
        lastId = id;
        if (send(event) || ended) return;
      }
      // Drained with no terminal frame yet. If the producer marked the run done,
      // the terminal event may not have mirrored (best-effort) — close gracefully
      // so the client falls back rather than hanging forever on a finished run.
      if (!ended && (await isRunDone(runId))) {
        finish();
        res.end();
        return;
      }
    } catch {
      // Best-effort: a transient Redis error just retries on the next tick.
    } finally {
      polling = false;
      if (!ended) pollTimer = setTimeout(() => void poll(), SSE_POLL_MS);
    }
  };

  req.on("close", finish);
  void poll();
});

router.post("/runs/:runId/stop", requireAuth, async (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).end();
    return;
  }
  const runId = String(req.params.runId);
  const record = runs.get(runId);
  if (record) {
    // Match the SSE attach check: ownership is keyed by (userId, tenantId), not
    // userId alone — otherwise a same-id principal under another tenant could stop
    // a run that isn't theirs.
    if (record.ctx.userId !== req.user.id || record.ctx.tenantId !== getTenantId(req)) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }
    record.stopped = true;
    // Also flip the shared flag so a same-session attach on another replica
    // observes the stop too (harmless when Redis is absent).
    void markRunStopped(runId);
    res.json({ ok: true });
    return;
  }

  // Cross-replica: the run is executing on another replica. Authorize against the
  // shared metadata, then set the shared stopped flag — the producing replica
  // polls it into its local record (see STOP_REFRESH_MS).
  const meta = await loadRunMeta(runId);
  if (!meta) {
    res.status(404).json({ error: "Run not found.", code: "run_not_found" });
    return;
  }
  if (meta.ctx.userId !== req.user.id || meta.ctx.tenantId !== getTenantId(req)) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }
  await markRunStopped(runId);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Answer feedback (the report-this-answer loop)                      */
/* ------------------------------------------------------------------ */

// Light throttle: feedback is a single small insert, but a user (or a runaway
// client) shouldn't be able to hammer it.
const feedbackRateLimit = rateLimitMiddleware({ name: "beam-feedback", limit: 40, windowMs: 5 * 60_000 });

/**
 * POST /feedback — record a user's verdict on a delivered Beam answer.
 *
 * Body: { answerLogId, rating?: "down"|"up", reasonCode?, detail? }.
 * Validates the id belongs to THIS user's real answer log before inserting, so a
 * verdict can never attach to nothing or to another user's turn. Returns a small
 * success payload. Degrades gracefully if the feedback table isn't provisioned.
 */
router.post("/feedback", feedbackRateLimit, requireAuth, async (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const validated = validateBeamFeedbackInput(req.body);
  if (!validated.ok) {
    res.status(validated.status).json({ error: validated.error, code: validated.code });
    return;
  }
  const { answerLogId, rating, reasonCode, detail } = validated.value;

  // The verdict must attach to a real answer this user owns. If the log isn't
  // found (unknown id, another user's turn, or the rare case where the best-
  // effort log write hasn't landed/failed), reject clearly rather than orphaning.
  const exists = await beamAnswerLogExistsForUser(answerLogId, req.user.id);
  if (!exists) {
    res.status(404).json({ error: "No answer found to attach this feedback to.", code: "answer_log_not_found" });
    return;
  }

  try {
    await recordBeamAnswerFeedback({
      answerLogId,
      tenantId: getTenantId(req),
      userId: req.user.id,
      rating,
      reasonCode,
      detail,
    });
  } catch (err) {
    if (err instanceof BeamFeedbackUnavailableError) {
      res.status(503).json({ error: "Feedback is temporarily unavailable.", code: "feedback_unavailable" });
      return;
    }
    logger.warn({ err, user: hashUser(req.user.id) }, "beam feedback insert failed");
    res.status(500).json({ error: "Could not record feedback." });
    return;
  }

  logger.info(
    { beam: { feedback: true, user: hashUser(req.user.id), rating, reasonCode } },
    "beam answer feedback recorded",
  );

  // A5-GAP3: close the learning loop. Fold the user's accumulated feedback back
  // into their scent-taste profile. Best-effort and fire-and-forget — it must
  // never delay or fail the feedback response.
  void applyFeedbackToScentPreferences(req.user.id, getTenantId(req)).catch(() => {});

  res.status(201).json({ ok: true });
});

/**
 * GET /observatory/feed — gated, authenticated beta-observability feed.
 *
 * OFF by default. Returns honest, redacted run summaries ONLY when
 * `BEAM_OBSERVATORY_ENABLED` is set AND the caller presents `BEAM_OBSERVATORY_TOKEN`
 * (via `x-observatory-token` or `Authorization: Bearer <token>`). Otherwise it
 * reports `offline` / `unauthorized` and returns no events. Intentionally NOT on
 * the user-auth path: this is an ops/cockpit surface keyed by a separate token, and
 * it never carries user ids, message text, prompts, or tool arguments.
 */
router.get("/observatory/feed", (req, res) => {
  const headerToken =
    (typeof req.headers["x-observatory-token"] === "string"
      ? req.headers["x-observatory-token"]
      : undefined) ??
    (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined);
  const parsedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const feed = buildObservatoryFeed({
    enabled: isObservatoryEnabled(),
    authorized: isObservatoryAuthorized(headerToken),
    ...(Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
  });
  res.status(feed.status === "unauthorized" ? 401 : 200).json(feed);
});

/**
 * GET /conversations/:sessionId — reload the durable transcript for a session.
 *
 * Scoped to the caller (`requireAuth` + a `user_id` filter in the store), so a
 * user can only read their own thread. Returns the most recent turns as ordered
 * `{ role, content }` pairs; `[]` when nothing is persisted yet, the table is
 * missing (pre-migration), or the session belongs to someone else. This is the
 * server surface the SPA rehydrates from after a reload (W-11 follow-up).
 */
router.get("/conversations/:sessionId", requireAuth, async (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required", code: "unauthorized" });
    return;
  }
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required", code: "missing_session_id" });
    return;
  }
  const turns = await loadBeamConversationHistory({ userId: req.user.id, sessionId });
  res.status(200).json({ sessionId, turns });
});

export const beamAgentRouter = router;

/** One-line opt-in mount. Call from app.ts when you're ready to enable Beam. */
export function mountBeamAgent(app: Express): void {
  if (!isBeamAgentEnabled()) {
    logger.warn(
      { beam: { enabled: false } },
      "Beam Agent is DISABLED via BEAM_AGENT_ENABLED — all runs fall back to the scripted mission.",
    );
  }
  // Surface model-configuration footguns once at startup (non-fatal, brief §C).
  for (const warning of validateBeamModelConfig()) {
    logger.warn({ beam: { config: true } }, `beam agent config: ${warning}`);
  }
  app.use("/api/beam-agent", router);
}

export default router;
