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

/**
 * Resolve `house`/`name` to a real fallback (notes + family + pyramid + image)
 * through the engine, or null when nothing real could be obtained. Mirrors the
 * SPA's two-step search→details flow against the same contract.
 */
async function resolveFallbackViaEngine(house: string, name: string): Promise<BuildProfileFallback | null> {
  const query = [house, name].filter((p) => p && p.trim()).join(" ").trim();
  if (!query) return null;

  const startedAt = Date.now();
  const searchUrl = `${ENGINE_BASE}/api/fragrances/search?q=${encodeURIComponent(query)}`;
  const searchPayload = await fetchJson(searchUrl, { method: "GET" }, RESOLVE_TIMEOUT_MS);
  const results = (searchPayload as { results?: unknown } | null)?.results;
  const candidates = Array.isArray(results)
    ? (results as Array<{ id?: string; source_url?: string; fg_url?: string }>)
    : [];
  const top = candidates.find((r) => r && (r.id || r.source_url || r.fg_url));
  if (!top) return null;

  const remainingMs = Math.max(1_000, RESOLVE_TIMEOUT_MS - (Date.now() - startedAt));
  const detailBody = top.id ? { id: top.id } : { source_url: top.source_url || top.fg_url };
  const detail = await fetchJson(
    `${ENGINE_BASE}/api/fragrances/details`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(detailBody) },
    remainingMs,
  );
  if (!detail || typeof detail !== "object") return null;

  const d = detail as {
    family?: unknown;
    image_url?: unknown;
    raw?: { description?: unknown; notes?: { has_pyramid?: unknown; top?: unknown; heart?: unknown; base?: unknown; flat?: unknown } };
  };
  const rawNotes = d.raw?.notes ?? {};
  const topNotes = asStringArray(rawNotes.top);
  const heartNotes = asStringArray(rawNotes.heart);
  const baseNotes = asStringArray(rawNotes.base);
  const flatNotes = asStringArray(rawNotes.flat);
  const notes = flatNotes.length > 0 ? flatNotes : [...topNotes, ...heartNotes, ...baseNotes];
  // The engine answered but still has no notes (even its proxy egress couldn't
  // reach the page, or it enqueued its own background scrape). Treat as a miss.
  if (notes.length === 0) return null;

  const family = typeof d.family === "string" && d.family.trim() ? d.family : undefined;
  const description = typeof d.raw?.description === "string" ? d.raw.description : undefined;
  const imageUrl = typeof d.image_url === "string" && d.image_url.trim() ? d.image_url : undefined;
  const hasPyramid = Boolean(rawNotes.has_pyramid) && topNotes.length + heartNotes.length + baseNotes.length > 0;

  return {
    notes,
    ...(family ? { family } : {}),
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(hasPyramid ? { pyramid: { top: topNotes, heart: heartNotes, base: baseNotes } } : {}),
  };
}

/**
 * Enrich one claimed job. Returns the terminal status the worker should record:
 *  - "completed" once the engine returned real data and the profile was persisted;
 *  - "failed" when there is nothing actionable, or the engine could not resolve it
 *    yet (the failed-job sweeper reopens it for a later retry).
 */
export async function enrichJobViaEngine(job: EnrichmentJob): Promise<"completed" | "failed"> {
  const identity = jobIdentity(job);
  if (!identity) {
    logger.info({ jobKey: job.jobKey }, "enrichment: job has no usable identity; marking failed");
    return "failed";
  }

  const fallback = await resolveFallbackViaEngine(identity.house, identity.name);
  if (!fallback) return "failed";

  // Persist the assembled profile to global_fragrances (best-effort inside
  // buildProfile). Only an outright build error counts as a failure — a
  // persistence hiccup must not discard a real enrichment.
  try {
    const result = await buildProfile(identity.name, identity.house, fallback, { allowCatalogFuzzy: false });
    if ("error" in result) {
      logger.warn({ jobKey: job.jobKey, error: result.error }, "enrichment: buildProfile returned an error");
      return "failed";
    }
  } catch (err) {
    logger.warn(
      { jobKey: job.jobKey, err: err instanceof Error ? err.message : String(err) },
      "enrichment: buildProfile threw",
    );
    return "failed";
  }

  return "completed";
}
