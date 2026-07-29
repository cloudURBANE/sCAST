/**
 * Beam Agent — shared service dependency wiring for the MCP tool server.
 *
 * Mirrors the dependency wiring the in-process route uses (see
 * `beamAgentRoutes.ts` → buildDeps), factored into a reusable factory so the MCP
 * server reuses the SAME real services (vault, catalog search, scent-facts
 * research, deterministic weather scoring) with NO duplicated business logic.
 * Tenant/user scope is applied by the caller via the BeamRunContext that
 * `createBeamTools` threads into each handler; nothing here trusts model input.
 *
 * Weather note: a browser run supplies live weather via uiContext. The MCP server
 * has no browser, so getWeather returns the engine's sanitized default (seasonal
 * fallback). A server-side location→weather lookup is a tracked follow-up
 * (plan §7 `beam_get_weather_context`); the deterministic scorer already
 * tolerates absent live weather.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { userFragrancesTable } from "@workspace/db/schema";
import {
  rankScentMissionRecommendations,
  sanitizeScentMissionWardrobe,
  sanitizeScentMissionWeather,
  selectScentMissionRecommendation,
  type ScentMissionWardrobeItem,
} from "@workspace/scent-weather-engine";
import type { BeamRunContext, CandidatePacket } from "../types.ts";
import type { BeamCatalogHit, BeamToolDeps } from "../beamTools.ts";
import { packetFromWardrobeRow } from "../beamToolCore.ts";
import { missionItemFromWardrobeRow } from "../../services/scentMissionService";
import { scopeRowsWithMe } from "../../services/withMeCore";
import { loadWithMeState } from "../../services/withMeWardrobe";
import { searchCatalogCandidates, searchCatalogProfileCandidates, flattenProfile, getCatalogEntry } from "../../services/catalogService";
import { discoverExternalCandidates } from "../../services/engineDiscover";
import { fetchEngineEnrichmentState } from "../../services/enrichmentProcessor";
import { fragranceIdentityKey } from "../fragranceIdentity.ts";
import { isDiscoverExternalEnabled } from "../discoveryConfig.ts";
import { mcpDetailBudget } from "./mcpDiscoveryBudget.ts";
import { getScentFacts } from "../../lib/scent-facts/engine";
import { createBeamResearcher } from "../research/beamResearch.ts";
import { loadResearchCache, saveResearchCache } from "../research/researchCache.ts";
import { runWebResearch } from "../research/researchProvider.ts";
import {
  degradedResearchModel,
  isResearchEnabled,
  researchEngine,
  researchIncludeDomains,
  researchModelFor,
} from "../research/researchConfig.ts";

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

async function searchCatalogForBeam(query: string, limit: number): Promise<BeamCatalogHit[]> {
  const hits = await searchCatalogProfileCandidates(query, { limit });
  return hits.map((hit) => {
    const flat = flattenProfile(hit.profile) as Record<string, unknown>;
    const brand = typeof flat.brand === "string" ? flat.brand : "";
    const name = typeof flat.name === "string" ? flat.name : "";
    const id = typeof flat.id === "string" && flat.id ? flat.id : `${brand}::${name}`.toLowerCase();
    return { id, flat, score: hit.score };
  });
}

async function researchForBeam(name: string): Promise<Record<string, unknown> | null> {
  try {
    const facts = await getScentFacts({ fragranceName: name, save: false });
    return facts as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Owned bottles as full candidate packets WITH note pyramids (richer overlap). */
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

async function loadAvailableVault(ctx: BeamRunContext) {
  const [rows, withMe] = await Promise.all([
    db
      .select({ id: userFragrancesTable.id, fragranceData: userFragrancesTable.fragranceData })
      .from(userFragrancesTable)
      .where(and(eq(userFragrancesTable.tenantId, ctx.tenantId), eq(userFragrancesTable.userId, ctx.userId)))
      .orderBy(asc(userFragrancesTable.createdAt), asc(userFragrancesTable.id)),
    loadWithMeState(ctx.tenantId, ctx.userId),
  ]);
  const items = sanitizeScentMissionWardrobe(
    scopeRowsWithMe(rows, withMe)
      .map((row) => missionItemFromWardrobeRow(row.id, row.fragranceData))
      .filter((item) => item !== null),
  );
  return { enabled: withMe.enabled, totalCount: rows.length, items };
}

async function loadAvailableWardrobePackets(ctx: BeamRunContext) {
  const [rows, withMe] = await Promise.all([
    db
      .select({ id: userFragrancesTable.id, fragranceData: userFragrancesTable.fragranceData })
      .from(userFragrancesTable)
      .where(and(eq(userFragrancesTable.tenantId, ctx.tenantId), eq(userFragrancesTable.userId, ctx.userId)))
      .orderBy(asc(userFragrancesTable.createdAt), asc(userFragrancesTable.id)),
    loadWithMeState(ctx.tenantId, ctx.userId),
  ]);
  const items = scopeRowsWithMe(rows, withMe)
    .map((row) => packetFromWardrobeRow(row.id, row.fragranceData))
    .filter((packet): packet is CandidatePacket => packet !== null);
  return { enabled: withMe.enabled, totalCount: rows.length, items };
}

/**
 * Resolve ONE catalog fragrance to its flattened profile: exact brand+name first,
 * then a top-hit search fallback. Mirrors the in-process route so the MCP surface
 * builds the same proposal + UI-card tools (gated on this dep) instead of staying
 * a strictly read-only retrieval subset.
 */
async function resolveCatalogEntryForBeam(name: string, brand?: string): Promise<Record<string, unknown> | null> {
  if (brand) {
    const exact = await getCatalogEntry(brand, name).catch(() => null);
    if (exact) return flattenProfile(exact) as Record<string, unknown>;
  }
  const query = `${brand ?? ""} ${name}`.trim();
  const hits = await searchCatalogCandidates(query, { limit: 1 }).catch(() => []);
  if (hits.length > 0) return flattenProfile(hits[0].profile) as Record<string, unknown>;
  return null;
}

// Cost-capped live research, shared with the in-process route. No-ops to a
// `note` unless BEAM_RESEARCH_ENABLED + OPENROUTER_API_KEY are set, so Hermes
// gets the tool but it stays inert until the lane is turned on server-side.
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

/**
 * Process-wide registry of each discovered fragrance's version-precise engine
 * source URL, keyed by brand+name. The MCP deps are built once at startup (no
 * per-run ctx), and a Fragrantica URL is identity-, not user-, specific — so a
 * bounded shared map is safe and lets `checkEnrichmentState` verify the EXACT
 * version a discovery surfaced instead of re-resolving the name into a sibling
 * ("Sauvage" vs "Sauvage Elixir"). Bounded (oldest-evicted) so it can't grow
 * unbounded on a long-lived process.
 */
const MCP_SOURCE_URL_CACHE_MAX = 2048;
const mcpCandidateSourceUrls = new Map<string, string>();
function rememberMcpSourceUrl(
  name: string,
  brand: string | null | undefined,
  sourceUrl: string | null | undefined,
): void {
  const url = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
  if (!url) return;
  const key = fragranceIdentityKey(brand, name);
  if (!key) return;
  // Refresh recency: re-inserting moves the key to the end of the iteration order.
  mcpCandidateSourceUrls.delete(key);
  mcpCandidateSourceUrls.set(key, url);
  if (mcpCandidateSourceUrls.size > MCP_SOURCE_URL_CACHE_MAX) {
    const oldest = mcpCandidateSourceUrls.keys().next().value;
    if (oldest !== undefined) mcpCandidateSourceUrls.delete(oldest);
  }
}
function lookupMcpSourceUrl(name: string, brand: string | null | undefined): string | null {
  return mcpCandidateSourceUrls.get(fragranceIdentityKey(brand, name)) ?? null;
}

/**
 * Build the concrete tool dependencies for the MCP server. Stateless: safe to
 * construct once at startup and reuse across requests (per-request scope comes
 * from the BeamRunContext, not from these closures).
 */
export function createBeamServiceDeps(): BeamToolDeps {
  return {
    loadVault,
    loadVaultForOwnership,
    loadWardrobePackets,
    loadAvailableVault,
    loadAvailableWardrobePackets,
    searchCatalog: searchCatalogForBeam,
    // External discovery mirrors the in-process route, gated on the same env flag.
    // H1: these startup-built deps have no per-run ctx, so instead of an unbounded
    // per-call passthrough we bound /details (Decodo) spend process-wide with a
    // refilling token bucket (BEAM_EXTERNAL_DETAIL_RUN_CAP capacity). Reserve the
    // grant synchronously, then refund the unspent portion after the await — the
    // same reserve/refund discipline the route uses (H2), kept correct under
    // concurrent tools/call dispatch.
    //
    // `budgetCeiling` and `avoidTerms` remain intentionally absent here: they come
    // from per-run session slots the MCP surface never sees. So on MCP, discovery
    // budget-gating degrades to "unknown" and `beam_find_similar`'s explicit dislike
    // gate is a no-op — the Hermes/MCP *client* owns budget, dislikes and the safety
    // prompt (BEAM_SAFETY_RULES is injected by the in-process loop, not this tool
    // surface). See README.md "Safety & run-context".
    discoverExternal: isDiscoverExternalEnabled()
      ? async (query, opts) => {
          const detailLimit = mcpDetailBudget.reserve(opts.detailLimit);
          const candidates = await discoverExternalCandidates(query, { limit: opts.limit, detailLimit });
          const spent = candidates.filter((c) => c.detailed).length;
          mcpDetailBudget.refund(detailLimit - spent);
          // Capture each pick's version-precise source URL so a later verify acts
          // on THIS exact version rather than a fresh name search.
          for (const candidate of candidates) {
            rememberMcpSourceUrl(candidate.name, candidate.brand, candidate.sourceUrl);
          }
          return candidates;
        }
      : undefined,
    resolveCatalogEntry: resolveCatalogEntryForBeam,
    research: researchForBeam,
    researchWeb: beamResearchWeb,
    // Enrichment-state verification is ctx-free (identity in, state out), so it is
    // safe to expose on the MCP/Hermes surface too — a promoted Hermes agent can
    // verify a pick is fully enriched before presenting it, using the cheap cached
    // engine state (no billed live scrape).
    checkEnrichmentState: (fragrance) => {
      const sourceUrl = lookupMcpSourceUrl(fragrance.name, fragrance.brand);
      return fetchEngineEnrichmentState(
        fragrance.name,
        fragrance.brand ?? null,
        sourceUrl ? { sourceUrl } : undefined,
      );
    },
    scoreVault: (items, calibration, weather) =>
      selectScentMissionRecommendation(items, calibration, weather),
    rankVault: (items, calibration, weather) =>
      rankScentMissionRecommendations(items, calibration, weather),
    getWeather: async () => sanitizeScentMissionWeather(undefined),
    // No `enqueueCuration` here: it must bind the run's tenant/user, but these
    // deps are built once at startup with no ctx. Unresolved proposal/kit names
    // are simply dropped on the MCP surface (the in-process route curates them).
  };
}
