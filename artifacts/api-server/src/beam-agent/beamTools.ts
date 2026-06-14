/**
 * Beam Agent — Phase 1 READ-ONLY tool surface.
 *
 * Tool *bodies* are decoupled from the rest of the app via the `BeamToolDeps`
 * interface: the route layer injects concrete implementations that call the real
 * services (catalog search, scent-facts research, the deterministic weather
 * engine, the vault). That keeps this file free of DB wiring, makes it reusable
 * by a future Hermes/MCP runtime, and lets it be tested with fakes.
 *
 * IMPORTANT: no tool here writes anything. Tenant/user scope always comes from
 * `ctx`, never from model-supplied arguments. Server-enforced limits in
 * `BEAM_LIMITS` cannot be widened by the model.
 */
import type {
  ScentMissionCalibration,
  ScentMissionDestination,
  ScentMissionEnergy,
  ScentMissionRecommendation,
  ScentMissionWardrobeItem,
  ScentMissionWeather,
} from "@workspace/scent-weather-engine";
import type { BeamRunContext, BeamToolDefinition, CandidatePacket } from "./types.ts";
import {
  BEAM_LIMITS,
  asString,
  clampLimit,
  packetFromFlatProfile,
  packetFromOwnedItem,
} from "./beamToolCore.ts";

/** A flattened catalog hit the search dep returns (loose by design). */
export type BeamCatalogHit = { id: string; flat: Record<string, unknown>; score: number };

/**
 * Everything the tools need from the rest of the app. Each implementation is
 * scoped/validated on the server side; the tools just orchestrate.
 */
export type BeamToolDeps = {
  /** The user's sanitized vault, scoped to ctx.tenantId + ctx.userId. */
  loadVault: (ctx: BeamRunContext) => Promise<ScentMissionWardrobeItem[]>;
  /** Catalog (global_fragrances) search → flattened profiles. */
  searchCatalog: (query: string, limit: number) => Promise<BeamCatalogHit[]>;
  /** Best-effort research for one fragrance name (read-only; never persists). */
  research: (name: string) => Promise<Record<string, unknown> | null>;
  /**
   * Cost-capped live web research (freshness-gated, cached). OPTIONAL: when
   * absent, the `beam_research_web` tool is not exposed at all — keeping Phase-1
   * deploys (and the tool tests) on the original 5-tool surface. Returns a
   * synthesized fact + sources, or a `{ note }` when live research is off/failed.
   */
  researchWeb?: (
    query: string,
    opts?: { entityType?: string; depth?: string },
  ) => Promise<unknown>;
  /** Deterministic weather scoring over the vault (kept in code, not the LLM). */
  scoreVault: (
    items: ScentMissionWardrobeItem[],
    calibration: ScentMissionCalibration,
    weather: ScentMissionWeather,
  ) => ScentMissionRecommendation | null;
  /** Current weather context for the run (best-effort; engine has fallbacks). */
  getWeather: (ctx: BeamRunContext) => Promise<ScentMissionWeather>;
};

const DESTINATIONS = new Set<ScentMissionDestination>([
  "Staying In",
  "Going Out",
  "Work",
  "Night Out",
  "Date",
  "Gym",
]);
const ENERGIES = new Set<ScentMissionEnergy>(["Calm", "Focused", "Confident", "Social", "Relaxed"]);

function parseCalibration(input: unknown): ScentMissionCalibration {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const calibration: ScentMissionCalibration = {};
  const destination = asString(record.destination) as ScentMissionDestination | undefined;
  const energy = asString(record.energy) as ScentMissionEnergy | undefined;
  if (destination && DESTINATIONS.has(destination)) calibration.destination = destination;
  if (energy && ENERGIES.has(energy)) calibration.energy = energy;
  return calibration;
}

function topFamilies(items: ScentMissionWardrobeItem[], limit = 4): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const family of item.families ?? []) {
      const key = family.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([family]) => family);
}

/** Build the Phase-1 read-only tool definitions from injected deps. */
export function createBeamTools(deps: BeamToolDeps): BeamToolDefinition[] {
  const tools: BeamToolDefinition[] = [
    {
      name: "beam_get_user_context",
      description:
        "Get a compact summary of the signed-in user's situation: how many fragrances they own, the dominant scent families in their vault, and today's weather context. Call this first to ground recommendations.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_input, ctx) => {
        const [vault, weather] = await Promise.all([deps.loadVault(ctx), deps.getWeather(ctx)]);
        return {
          wardrobeSummary: { count: vault.length, topFamilies: topFamilies(vault) },
          weather: {
            temperature_f: weather.temperature_f ?? null,
            humidity_percent: weather.humidity_percent ?? null,
            condition: weather.condition ?? null,
            location: weather.location ?? null,
          },
        };
      },
    },

    {
      name: "beam_get_wardrobe",
      description:
        "List the fragrances the signed-in user already owns, as candidate packets (id, name, brand, accords). Use these ids when reasoning about what they own.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_input, ctx) => {
        const vault = await deps.loadVault(ctx);
        const items: CandidatePacket[] = vault.map((item) => packetFromOwnedItem(item));
        return { count: items.length, items };
      },
    },

    {
      name: "beam_search_catalog",
      description:
        "Search the local fragrance catalog (global_fragrances) for REAL fragrances matching a query. Returns candidate packets. Prefer this over guessing — never invent a fragrance that is not in a result.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Brand and/or fragrance name to search for." },
          limit: { type: "number", description: `Max results (server caps at ${BEAM_LIMITS.maxCatalogResults}).` },
          excludeOwned: { type: "boolean", description: "Drop fragrances already in the user's vault." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        const query = asString(record.query);
        if (!query) return { items: [], note: "query is required" };
        const limit = clampLimit(record.limit, BEAM_LIMITS.maxCatalogResults);
        const hits = await deps.searchCatalog(query, limit);
        let items: CandidatePacket[] = hits.map((hit) => packetFromFlatProfile(hit.id, hit.flat, false));

        if (record.excludeOwned === true) {
          const vault = await deps.loadVault(ctx);
          const owned = new Set(
            vault.map((item) => `${(item.brand ?? "").toLowerCase()}::${item.name.toLowerCase()}`),
          );
          items = items.filter(
            (packet) => !owned.has(`${packet.brand.toLowerCase()}::${packet.canonicalName.toLowerCase()}`),
          );
        }
        return { count: items.length, items };
      },
    },

    {
      name: "beam_get_fragrance_details",
      description:
        "Fetch best-effort research facts (notes, accords, performance) for up to a handful of fragrances by name. Read-only: nothing is saved. Use to deepen evidence before recommending.",
      inputSchema: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: `Fragrance names to research (server caps at ${BEAM_LIMITS.maxDetailNames}).`,
          },
        },
        required: ["names"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        const rawNames = Array.isArray(record.names) ? record.names : [];
        const names: string[] = [];
        for (const value of rawNames) {
          const name = asString(value);
          if (name) names.push(name);
          if (names.length >= BEAM_LIMITS.maxDetailNames) break;
        }
        const items = await Promise.all(
          names.map(async (name) => {
            const facts = await deps.research(name).catch(() => null);
            return { name, found: facts !== null, facts: facts ?? null };
          }),
        );
        return { count: items.length, items };
      },
    },

    {
      name: "beam_score_candidates",
      description:
        "Deterministically rank the user's vault for a given destination/energy and today's weather, returning the single best pick with the engine's reasoning. The scoring math runs in code — do not compute scores yourself.",
      inputSchema: {
        type: "object",
        properties: {
          destination: {
            type: "string",
            enum: ["Staying In", "Going Out", "Work", "Night Out", "Date", "Gym"],
          },
          energy: { type: "string", enum: ["Calm", "Focused", "Confident", "Social", "Relaxed"] },
        },
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const [vault, weather] = await Promise.all([deps.loadVault(ctx), deps.getWeather(ctx)]);
        if (vault.length === 0) return { recommendation: null, note: "vault is empty" };
        const calibration = parseCalibration(input);
        const recommendation = deps.scoreVault(vault, calibration, weather);
        if (!recommendation) return { recommendation: null };
        return {
          recommendation: {
            fragranceId: recommendation.fragranceId,
            canonicalName: recommendation.name,
            brand: recommendation.brand ?? "",
            score: recommendation.score,
            reason: recommendation.reason,
          },
        };
      },
    },
  ];

  // Live web research is additive and opt-in: only exposed when the route wires
  // a `researchWeb` dep (which itself no-ops unless BEAM_RESEARCH_ENABLED +
  // OPENROUTER_API_KEY are set). Absent it, the surface is the original 5 tools.
  const { researchWeb } = deps;
  if (researchWeb) {
    tools.push({
      name: "beam_research_web",
      description:
        "Look up CURRENT external facts via a cost-capped web search: live price, " +
        "availability, discontinued / reformulated / newly-released status, unknown " +
        "metadata (perfumer, release year, concentration), sample/decant sellers, or " +
        "when the user explicitly asks for cited sources. Do NOT use it for normal " +
        "recommendations, weather/occasion fits, ranking owned bottles, or comparing " +
        "common scents — answer those from the catalog and wardrobe tools. Returns a " +
        "short synthesized fact plus its sources; if it returns a `note` instead, live " +
        "research is unavailable, so answer from cached knowledge and say it is not " +
        "freshly verified.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The specific fact to look up, e.g. 'current price of Creed Aventus 100ml'.",
          },
          entityType: {
            type: "string",
            enum: ["fragrance", "brand", "seller", "price", "availability", "note_claim", "general"],
            description: "Optional hint that scopes the cache key and its freshness TTL.",
          },
          depth: {
            type: "string",
            enum: ["auto", "single", "standard", "premium"],
            description: "Optional research depth; default 'auto' lets the server pick the cheapest lane that fits.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        const query = asString(record.query);
        if (!query) return { note: "query is required", synthesizedFact: "", sources: [] };
        return researchWeb(query, { entityType: asString(record.entityType), depth: asString(record.depth) });
      },
    });
  }

  return tools;
}
