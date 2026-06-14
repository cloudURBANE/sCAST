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
  sanitizeScentMissionWardrobe,
  sanitizeScentMissionWeather,
  selectScentMissionRecommendation,
  type ScentMissionWardrobeItem,
} from "@workspace/scent-weather-engine";
import type { BeamRunContext } from "../types.ts";
import type { BeamCatalogHit, BeamToolDeps } from "../beamTools.ts";
import { missionItemFromWardrobeRow } from "../../services/scentMissionService";
import { searchCatalogCandidates, flattenProfile } from "../../services/catalogService";
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

async function searchCatalogForBeam(query: string, limit: number): Promise<BeamCatalogHit[]> {
  const hits = await searchCatalogCandidates(query, { limit });
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
 * Build the concrete tool dependencies for the MCP server. Stateless: safe to
 * construct once at startup and reuse across requests (per-request scope comes
 * from the BeamRunContext, not from these closures).
 */
export function createBeamServiceDeps(): BeamToolDeps {
  return {
    loadVault,
    searchCatalog: searchCatalogForBeam,
    research: researchForBeam,
    researchWeb: beamResearchWeb,
    scoreVault: (items, calibration, weather) =>
      selectScentMissionRecommendation(items, calibration, weather),
    getWeather: async () => sanitizeScentMissionWeather(undefined),
  };
}
