import { logger } from "../lib/logger";
import type { BuildProfileFallback } from "./scentEngineCore";

/**
 * Server-side "hybrid" resolve against the Python scent engine.
 *
 * The engine's POST /api/fragrances/details fetches the live Fragrantica page
 * over Decodo's unblocked egress (the deployed datacenter IP is Cloudflare-
 * blocked, so the engine transparently routes through Decodo's rotating
 * premium-proxy pool on a direct-fetch challenge). That means the api-server
 * can obtain real notes/family/pyramid for a freshly-clicked fragrance
 * *immediately*, instead of landing a minimal pending card and waiting for the
 * operator's offline worker to reach it.
 *
 * This module is a thin, fully-degradable client: search for the best
 * candidate, fetch its detail bundle, and map the engine response onto the
 * BuildProfileFallback shape the scent engine already understands. Any failure
 * — unreachable engine, timeout, no candidate, or an engine result that itself
 * still has no notes (the engine couldn't resolve it either) — returns null so
 * the caller falls through to its existing behavior.
 */

const DEFAULT_ENGINE_ORIGIN = "https://srt-scent-engine-production.up.railway.app";

const ENGINE_BASE = (
  process.env.FRAGRANCE_ENGINE_URL ??
  process.env.VITE_FRAGRANCE_API_URL ??
  DEFAULT_ENGINE_ORIGIN
)
  .trim()
  .replace(/\/+$/, "");

// Overall wall-clock budget for the two-call resolve (search + details). The
// details call can include a live Decodo egress round-trip, so allow a
// generous-but-bounded window; on-demand views await this synchronously.
const RESOLVE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ENGINE_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 12_000;
})();

interface EngineSearchResult {
  id?: string;
  source_url?: string;
  fg_url?: string;
  image_url?: string | null;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown | null> {
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

/**
 * Resolve `brand`/`name` to a full fallback (notes + family + pyramid + image)
 * via the engine, or null when nothing real could be obtained.
 */
export async function resolveProfileViaEngine(
  brand: string,
  name: string,
): Promise<BuildProfileFallback | null> {
  const query = [brand, name].filter((p) => p && p.trim()).join(" ").trim();
  if (!query) return null;

  const startedAt = Date.now();

  // 1. Search for the best candidate.
  const searchUrl = `${ENGINE_BASE}/api/fragrances/search?q=${encodeURIComponent(query)}`;
  const searchPayload = await fetchJson(searchUrl, { method: "GET" }, RESOLVE_TIMEOUT_MS);
  const results = (searchPayload as { results?: unknown } | null)?.results;
  const candidates = Array.isArray(results) ? (results as EngineSearchResult[]) : [];
  const top = candidates.find((r) => r && (r.id || r.source_url || r.fg_url));
  if (!top) return null;

  // 2. Fetch the full detail bundle. The engine does the live Decodo-egress
  // fetch here on a cold miss. Identify the candidate by its opaque id when
  // present (the engine's own contract), else by source URL.
  const remainingMs = Math.max(1_000, RESOLVE_TIMEOUT_MS - (Date.now() - startedAt));
  const detailBody = top.id
    ? { id: top.id }
    : { source_url: top.source_url || top.fg_url };
  const detail = await fetchJson(
    `${ENGINE_BASE}/api/fragrances/details`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(detailBody),
    },
    remainingMs,
  );
  if (!detail || typeof detail !== "object") return null;

  const d = detail as {
    family?: unknown;
    image_url?: unknown;
    raw?: {
      description?: unknown;
      notes?: { has_pyramid?: unknown; top?: unknown; heart?: unknown; base?: unknown; flat?: unknown };
    };
  };

  const rawNotes = d.raw?.notes ?? {};
  const topNotes = asStringArray(rawNotes.top);
  const heartNotes = asStringArray(rawNotes.heart);
  const baseNotes = asStringArray(rawNotes.base);
  const flatNotes = asStringArray(rawNotes.flat);
  const notes = flatNotes.length > 0 ? flatNotes : [...topNotes, ...heartNotes, ...baseNotes];

  // The engine returned but still has no notes (e.g. even Decodo could not
  // reach the page and it enqueued a background job). Treat as a miss so the
  // caller keeps the graceful pending behavior.
  if (notes.length === 0) {
    logger.info({ brand, name }, "engine resolve returned no notes; deferring to pending");
    return null;
  }

  const family = typeof d.family === "string" && d.family.trim() ? d.family : undefined;
  const description = typeof d.raw?.description === "string" ? d.raw.description : undefined;
  const imageUrl = typeof d.image_url === "string" && d.image_url.trim() ? d.image_url : undefined;
  const hasPyramid =
    Boolean(rawNotes.has_pyramid) &&
    topNotes.length + heartNotes.length + baseNotes.length > 0;

  return {
    notes,
    ...(family ? { family } : {}),
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(hasPyramid ? { pyramid: { top: topNotes, heart: heartNotes, base: baseNotes } } : {}),
  };
}
