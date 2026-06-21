/**
 * Server-side EXTERNAL fragrance discovery against the Python scent engine.
 *
 * `beam_discover_external` reaches beyond our local `global_fragrances` catalog
 * by querying the engine's `GET /api/fragrances/search` (the same contract
 * `engineResolve.ts` and `enrichmentProcessor.ts` already speak). Search alone is
 * cheap and returns real identities (name/brand/source_url). A FEW of those are
 * then enriched with notes/family via `POST /api/fragrances/details` — the call
 * that can incur a live Decodo egress round-trip — so detail fetches are HARD
 * capped per invocation by `detailLimit` to bound spend. The caller (route) layers
 * a per-RUN budget on top.
 *
 * Fully degradable, like engineResolve: any failure (unreachable engine, timeout,
 * malformed body, no candidates) yields fewer/zero candidates and NEVER throws, so
 * a lean/local/offline environment keeps working — discovery just returns nothing.
 *
 * This module does NOT change the engine HTTP contract; it only consumes existing
 * search/details endpoints (see cross-service-contract).
 */
import { logger } from "../lib/logger";
import type { ExternalDiscoveryCandidate } from "../beam-agent/types.ts";

const DEFAULT_ENGINE_ORIGIN = "https://srt-scent-engine-production.up.railway.app";

const ENGINE_BASE = (
  process.env.FRAGRANCE_ENGINE_URL ??
  process.env.VITE_FRAGRANCE_API_URL ??
  DEFAULT_ENGINE_ORIGIN
)
  .trim()
  .replace(/\/+$/, "");

/** Per-call wall-clock budget for the search step (no Decodo egress). */
const SEARCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.BEAM_DISCOVER_SEARCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6_000;
})();

/** Per-detail wall-clock budget (can include a live Decodo egress round-trip). */
const DETAIL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.BEAM_DISCOVER_DETAIL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 9_000;
})();

interface EngineSearchResult {
  id?: string;
  name?: string;
  house?: string;
  brand?: string;
  brand_name?: string;
  source_url?: string;
  fg_url?: string;
  image_url?: string | null;
}

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
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

/** Map one raw engine search row to a base (search-only) candidate, or null. */
function baseCandidateFromSearchRow(row: EngineSearchResult): ExternalDiscoveryCandidate | null {
  const name = str(row.name);
  if (!name) return null;
  const brand = str(row.house) ?? str(row.brand) ?? str(row.brand_name) ?? "";
  const sourceUrl = str(row.source_url) ?? str(row.fg_url);
  const id = str(row.id) ?? sourceUrl ?? `${brand}::${name}`.toLowerCase();
  return {
    id,
    name,
    brand,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(typeof row.image_url === "string" && row.image_url.trim() ? { imageUrl: row.image_url.trim() } : {}),
    detailed: false,
  };
}

/** Enrich one candidate via /details, mutating notes/family/accords. Best-effort. */
async function enrichCandidate(candidate: ExternalDiscoveryCandidate): Promise<void> {
  const detailBody = candidate.id && !candidate.id.includes("::")
    ? { id: candidate.id }
    : candidate.sourceUrl
      ? { source_url: candidate.sourceUrl }
      : null;
  if (!detailBody) return;

  const detail = await fetchJson(
    `${ENGINE_BASE}/api/fragrances/details`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(detailBody) },
    DETAIL_TIMEOUT_MS,
  );
  // A detail ATTEMPT was made (cost incurred) — mark detailed even on a thin body
  // so the per-run cap counts the spend, not just the successes.
  candidate.detailed = true;
  if (!detail || typeof detail !== "object") return;

  const d = detail as {
    family?: unknown;
    image_url?: unknown;
    accords?: unknown;
    raw?: { notes?: { top?: unknown; heart?: unknown; base?: unknown }; accords?: unknown };
  };
  const rawNotes = d.raw?.notes ?? {};
  const top = asStringArray(rawNotes.top);
  const heart = asStringArray(rawNotes.heart);
  const base = asStringArray(rawNotes.base);
  if (top.length + heart.length + base.length > 0) candidate.notes = { top, heart, base };

  const accords = asStringArray(d.accords ?? d.raw?.accords);
  if (accords.length > 0) candidate.accords = accords;

  const family = str(d.family);
  if (family) candidate.family = family;

  const imageUrl = str(d.image_url);
  if (imageUrl && !candidate.imageUrl) candidate.imageUrl = imageUrl;
}

export type DiscoverExternalOptions = {
  /** Max search candidates to surface (already server-capped by the caller). */
  limit: number;
  /** HARD cap on /details fetches this call — the Decodo-spend bound. */
  detailLimit: number;
};

/**
 * Discover real fragrances matching `query` from the engine, beyond the local
 * catalog. Returns up to `limit` candidates; the first `detailLimit` of them are
 * enriched with notes/accords/family (bounded Decodo spend), the rest carry only
 * the search-row identity (`detailed: false`). Never throws.
 */
export async function discoverExternalCandidates(
  query: string,
  opts: DiscoverExternalOptions,
): Promise<ExternalDiscoveryCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(Math.floor(opts.limit), 20));
  const detailLimit = Math.max(0, Math.min(Math.floor(opts.detailLimit), limit));

  const searchUrl = `${ENGINE_BASE}/api/fragrances/search?q=${encodeURIComponent(q)}`;
  const payload = await fetchJson(searchUrl, { method: "GET" }, SEARCH_TIMEOUT_MS);
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];

  const candidates: ExternalDiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const row of results as EngineSearchResult[]) {
    const candidate = baseCandidateFromSearchRow(row ?? {});
    if (!candidate) continue;
    const key = `${candidate.brand}::${candidate.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= limit) break;
  }

  // Enrich the leading `detailLimit` candidates in parallel — the hard spend cap.
  const toEnrich = candidates.slice(0, detailLimit);
  if (toEnrich.length > 0) {
    await Promise.all(
      toEnrich.map((candidate) =>
        enrichCandidate(candidate).catch((err) => {
          logger.warn({ err }, "beam external-discovery detail enrich failed");
        }),
      ),
    );
  }
  return candidates;
}
