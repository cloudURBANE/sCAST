/**
 * Concrete enrichment processor for the queue worker (enrichmentQueue.ts).
 *
 * Kept in its own module so the queue service stays free of the scent-engine
 * import graph and the worker's orchestration (enrichmentQueueCore.ts) remains
 * DB/engine-agnostic and unit-testable. This is the only place that knows what
 * "enriching a job" actually means: ask the Python fragrance engine for real
 * notes/family/pyramid, then persist the assembled profile to `global_fragrances`
 * (via buildProfile) so future detail fetches read as complete.
 *
 * Reuses the existing cross-service contract only (the engine's `/search` +
 * `/details` endpoints, per search_engine/API_CONTRACT.md) — no new scraper and
 * no new response shape. Fully degradable: any miss yields "failed", which the
 * failed-job sweeper reopens for a later retry.
 */
import type { EnrichmentJob } from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { buildProfile } from "./scentEngine";
import type { BuildProfileFallback } from "./scentEngineCore";
import { notifyBeamCurationComplete } from "./curationService";
import { stampEnrichmentProgress } from "./enrichmentQueue";
import {
  evaluateEnrichmentLevel,
  enrichmentAttemptsExhausted,
  maxEnrichmentAttempts,
  readEnrichAttempts,
  type EngineSourceCoverage,
  type EnrichmentLevel,
} from "./enrichmentCompleteness";

const DEFAULT_ENGINE_ORIGIN = "https://srt-scent-engine-production.up.railway.app";

const ENGINE_BASE = (
  process.env.FRAGRANCE_ENGINE_URL ??
  process.env.VITE_FRAGRANCE_API_URL ??
  DEFAULT_ENGINE_ORIGIN
)
  .trim()
  .replace(/\/+$/, "");

/** Wall-clock budget for the two-call resolve (search + live details fetch). */
const RESOLVE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ENRICHMENT_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15_000;
})();

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/** Best display identity for the job: explicit name/house, else the raw query. */
function jobIdentity(job: EnrichmentJob): { name: string; house: string } | null {
  const name = (job.name ?? "").trim();
  const house = (job.house ?? "").trim();
  if (name) return { name, house };
  const query = (job.query ?? "").trim();
  if (query) return { name: query, house: "" };
  return null;
}

/** What the engine resolve yielded: a usable fallback (if any), plus the honesty
 * signals we gate on (`source_coverage` + the collapsed completeness level). */
export type EngineResolveResult = {
  fallback: BuildProfileFallback | null;
  coverage: EngineSourceCoverage | null;
  level: EnrichmentLevel;
};

/**
 * Resolve `house`/`name` to a real fallback (notes + family + pyramid + image)
 * through the engine AND capture the `source_coverage` it reports. Mirrors the
 * SPA's two-step search→details flow against the same contract. Unlike before,
 * this no longer returns null just because notes are thin: the caller needs the
 * coverage to decide complete-vs-partial, and a partial result still updates the
 * card. `level` is "none" only when the engine gave us nothing usable at all.
 */
/** One resolvable engine candidate (any one of these identifies a detail body). */
type EngineCandidate = { id?: string; source_url?: string; fg_url?: string };

/** Build a `/details`-style body from a candidate (prefer id, then source url). */
function candidateDetailBody(top: EngineCandidate): Record<string, string> {
  return top.id ? { id: top.id } : { source_url: top.source_url || top.fg_url || "" };
}

/** Search the engine and return the top resolvable candidate, or null. */
async function engineSearchTop(query: string, timeoutMs: number): Promise<EngineCandidate | null> {
  const q = query.trim();
  if (!q) return null;
  const searchUrl = `${ENGINE_BASE}/api/fragrances/search?q=${encodeURIComponent(q)}`;
  const searchPayload = await fetchJson(searchUrl, { method: "GET" }, timeoutMs);
  const results = (searchPayload as { results?: unknown } | null)?.results;
  const candidates = Array.isArray(results) ? (results as EngineCandidate[]) : [];
  return candidates.find((r) => r && (r.id || r.source_url || r.fg_url)) ?? null;
}

export async function resolveDetailViaEngine(house: string, name: string): Promise<EngineResolveResult> {
  const empty: EngineResolveResult = { fallback: null, coverage: null, level: "none" };
  const query = [house, name].filter((p) => p && p.trim()).join(" ").trim();
  if (!query) return empty;

  const startedAt = Date.now();
  const top = await engineSearchTop(query, RESOLVE_TIMEOUT_MS);
  if (!top) return empty;

  const remainingMs = Math.max(1_000, RESOLVE_TIMEOUT_MS - (Date.now() - startedAt));
  const detail = await fetchJson(
    `${ENGINE_BASE}/api/fragrances/details`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(candidateDetailBody(top)) },
    remainingMs,
  );
  if (!detail || typeof detail !== "object") return empty;

  const d = detail as {
    family?: unknown;
    image_url?: unknown;
    source_coverage?: unknown;
    raw?: { description?: unknown; notes?: { has_pyramid?: unknown; top?: unknown; heart?: unknown; base?: unknown; flat?: unknown } };
  };
  const coverage =
    d.source_coverage && typeof d.source_coverage === "object"
      ? (d.source_coverage as EngineSourceCoverage)
      : null;
  const rawNotes = d.raw?.notes ?? {};
  const topNotes = asStringArray(rawNotes.top);
  const heartNotes = asStringArray(rawNotes.heart);
  const baseNotes = asStringArray(rawNotes.base);
  const flatNotes = asStringArray(rawNotes.flat);
  const notes = flatNotes.length > 0 ? flatNotes : [...topNotes, ...heartNotes, ...baseNotes];
  const level = evaluateEnrichmentLevel(coverage, notes.length > 0);

  if (notes.length === 0) {
    // Engine answered but with no displayable notes; nothing to persist, but the
    // coverage still informs whether a retry is worthwhile.
    return { fallback: null, coverage, level };
  }

  const family = typeof d.family === "string" && d.family.trim() ? d.family : undefined;
  const description = typeof d.raw?.description === "string" ? d.raw.description : undefined;
  const imageUrl = typeof d.image_url === "string" && d.image_url.trim() ? d.image_url : undefined;
  const hasPyramid = Boolean(rawNotes.has_pyramid) && topNotes.length + heartNotes.length + baseNotes.length > 0;

  return {
    coverage,
    level,
    fallback: {
      notes,
      ...(family ? { family } : {}),
      ...(description ? { description } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(hasPyramid ? { pyramid: { top: topNotes, heart: heartNotes, base: baseNotes } } : {}),
    },
  };
}

/**
 * Read-only enrichment-state probe for a fragrance identity, for on-demand
 * callers (e.g. the Beam/Hermes `beam_check_enrichment_state` tool) that want to
 * know "is this complete?" before surfacing or recommending it. Reuses the same
 * engine resolve + completeness rule as the worker, so the agent's gate and the
 * worker's gate can never disagree. Returns `level: "none"` on any miss.
 */
export async function fetchEngineEnrichmentState(
  name: string,
  brand: string | null | undefined,
): Promise<{ level: EnrichmentLevel; coverage: EngineSourceCoverage | null; complete: boolean }> {
  const cleanName = (name ?? "").trim();
  const cleanBrand = (brand ?? "").trim();
  const none = { level: "none" as EnrichmentLevel, coverage: null, complete: false };
  const query = [cleanBrand, cleanName].filter((p) => p).join(" ").trim();
  if (!query) return none;

  // Cheap path: resolve identity via /search (no egress), then read the CACHED
  // enrichment state via /api/fragrances/enrichment-state — which never triggers a
  // billed live scrape. This is what keeps on-demand agent verification from
  // hammering the paid /details endpoint.
  const top = await engineSearchTop(query, RESOLVE_TIMEOUT_MS).catch(() => null);
  if (top) {
    const state = await fetchJson(
      `${ENGINE_BASE}/api/fragrances/enrichment-state`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(candidateDetailBody(top)) },
      RESOLVE_TIMEOUT_MS,
    );
    if (state && typeof state === "object") {
      const s = state as { level?: unknown; complete?: unknown; source_coverage?: unknown };
      const level: EnrichmentLevel =
        s.level === "full" || s.level === "partial" ? s.level : "none";
      const coverage =
        s.source_coverage && typeof s.source_coverage === "object"
          ? (s.source_coverage as EngineSourceCoverage)
          : null;
      return { level, coverage, complete: level === "full" || s.complete === true };
    }
  }

  // Fallback: the cheap endpoint isn't deployed yet (404/empty). Use the full
  // resolve so the agent still gets a correct answer; bounded by RESOLVE_TIMEOUT_MS.
  const result = await resolveDetailViaEngine(cleanBrand, cleanName);
  return { level: result.level, coverage: result.coverage, complete: result.level === "full" };
}

/**
 * Enrich one claimed job. Returns the terminal status the worker should record:
 *  - "completed" ONLY when the engine reports the fragrance is fully complete
 *    (Basenotes + Fragrantica + full derived metrics). This is the only state
 *    that flips a curation `ready` and fires the "ready to add" notification, so
 *    users never get force-shown or notified about an under-enriched fragrance.
 *  - "failed" when still partial/missing AND attempts remain — the sweeper
 *    reopens it after backoff and the engine's own /details self-heal keeps
 *    scraping in the background. No notification.
 *  - "ignored" when the attempt budget is exhausted (or there's no usable
 *    identity): give up quietly. Terminal — never reopened, surfaced, or notified.
 */
export async function enrichJobViaEngine(job: EnrichmentJob): Promise<"completed" | "failed" | "ignored"> {
  const identity = jobIdentity(job);
  if (!identity) {
    logger.info({ jobKey: job.jobKey }, "enrichment: job has no usable identity; ignoring");
    return "ignored";
  }

  const metadata = (job.metadataJson as Record<string, unknown> | null) ?? null;
  const attempts = readEnrichAttempts(metadata) + 1;
  const maxAttempts = maxEnrichmentAttempts(process.env.BEAM_ENRICHMENT_MAX_ATTEMPTS);

  const { fallback, level } = await resolveDetailViaEngine(identity.house, identity.name);

  // Persist whatever real data we got (best-effort). Even a partial profile
  // improves the card for next time; only an outright build error is fatal.
  if (fallback) {
    try {
      const result = await buildProfile(identity.name, identity.house, fallback, { allowCatalogFuzzy: false });
      if ("error" in result) {
        logger.warn({ jobKey: job.jobKey, error: result.error }, "enrichment: buildProfile returned an error");
      }
    } catch (err) {
      logger.warn(
        { jobKey: job.jobKey, err: err instanceof Error ? err.message : String(err) },
        "enrichment: buildProfile threw",
      );
    }
  }

  // Record progress so the bounded-retry budget and the pending-list completeness
  // survive across worker passes. Best-effort — a stamp failure must not change
  // the outcome routing below.
  await stampEnrichmentProgress(job.jobKey, { enrichAttempts: attempts, enrichLevel: level }).catch((err) => {
    logger.warn(
      { jobKey: job.jobKey, err: err instanceof Error ? err.message : String(err) },
      "enrichment: progress stamp failed (ignored)",
    );
  });

  // Not yet complete: retry on backoff while the budget lasts, then give up.
  if (level !== "full") {
    if (enrichmentAttemptsExhausted(attempts, maxAttempts)) {
      logger.info(
        { jobKey: job.jobKey, attempts, maxAttempts, level },
        "enrichment: attempt budget exhausted while still incomplete; ignoring",
      );
      return "ignored";
    }
    logger.info(
      { jobKey: job.jobKey, attempts, maxAttempts, level },
      "enrichment: incomplete — deferring for a later retry (no notification)",
    );
    return "failed";
  }

  // Complete. Beam curation hand-off: nudge the user who asked for it now that the
  // fragrance is fully enriched and addable. Best-effort and isolated — a push
  // failure (or a beam-unrelated job) must NOT change the "completed" result.
  if ((job.metadataJson as { source?: unknown } | null)?.source === "beam") {
    await notifyBeamCurationComplete(job).catch((err) => {
      logger.warn(
        { jobKey: job.jobKey, err: err instanceof Error ? err.message : String(err) },
        "enrichment: beam curation completion push failed (ignored)",
      );
    });
  }

  return "completed";
}
