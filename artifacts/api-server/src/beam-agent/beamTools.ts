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
import type { BeamProposalItem, BeamRunContext, BeamToolDefinition, CandidatePacket } from "./types.ts";
import {
  BEAM_LIMITS,
  asString,
  buildProposalItem,
  clampLimit,
  computeOverlap,
  packetFromFlatProfile,
  packetFromOwnedItem,
} from "./beamToolCore.ts";
import type { OverlapProfile } from "./beamToolCore.ts";

/** A flattened catalog hit the search dep returns (loose by design). */
export type BeamCatalogHit = { id: string; flat: Record<string, unknown>; score: number };

/** Map a CandidatePacket to the note/accord profile the overlap math consumes. */
function overlapProfileFromPacket(packet: CandidatePacket): OverlapProfile {
  return {
    top: packet.notes.top,
    middle: packet.notes.middle,
    base: packet.notes.base,
    accords: packet.accords,
  };
}

/**
 * Everything the tools need from the rest of the app. Each implementation is
 * scoped/validated on the server side; the tools just orchestrate.
 */
export type BeamToolDeps = {
  /** The user's sanitized vault, scoped to ctx.tenantId + ctx.userId. */
  loadVault: (ctx: BeamRunContext) => Promise<ScentMissionWardrobeItem[]>;
  /**
   * OPTIONAL richer wardrobe loader that returns owned bottles as full candidate
   * packets WITH note pyramids (read from the raw row, not the mission shape). When
   * present, `beam_get_wardrobe` uses it so the model reasons over real top/middle/
   * base notes; when absent it falls back to `loadVault` + accord-only packets,
   * keeping the tool tests and any lean deploy on the original surface.
   */
  loadWardrobePackets?: (ctx: BeamRunContext) => Promise<CandidatePacket[]>;
  /** Catalog (global_fragrances) search → flattened profiles. */
  searchCatalog: (query: string, limit: number) => Promise<BeamCatalogHit[]>;
  /**
   * OPTIONAL: resolve ONE catalog fragrance (by name, optionally brand) to its
   * full flattened profile, for building add-ready collection proposals. When
   * absent, `beam_propose_collection` is not exposed (keeps the read-only deploys
   * and the tool tests on the original surface).
   */
  resolveCatalogEntry?: (name: string, brand?: string) => Promise<Record<string, unknown> | null>;
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
  /**
   * OPTIONAL deterministic ranking over the vault — the same math as `scoreVault`
   * but returning every bottle best-first, so `beam_score_candidates` can ground
   * a multi-bottle pick ("two from your vault") instead of only the single
   * winner. When absent, the tool falls back to `scoreVault` (one pick), keeping
   * lean deploys and the tool tests on the original surface.
   */
  rankVault?: (
    items: ScentMissionWardrobeItem[],
    calibration: ScentMissionCalibration,
    weather: ScentMissionWeather,
  ) => ScentMissionRecommendation[];
  /** Current weather context for the run (best-effort; engine has fallbacks). */
  getWeather: (ctx: BeamRunContext) => Promise<ScentMissionWeather>;
};

/** Largest number of ranked vault picks `beam_score_candidates` will return. */
const MAX_SCORE_PICKS = 3;

/**
 * Coerce the model-supplied destination-climate override into a sanitized weather
 * patch. Lets the agent score a trip kit against where the user is GOING (e.g.
 * warm, humid Tokyo in June) rather than today's weather at home. Only known,
 * finite fields survive; anything else is dropped so the engine's own fallbacks
 * apply. Returns null when nothing usable was supplied.
 */
function parseWeatherOverride(input: unknown): Partial<ScentMissionWeather> | null {
  if (typeof input !== "object" || input === null) return null;
  const r = input as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const patch: Partial<ScentMissionWeather> = {};
  const temp = num(r.temperature_f);
  if (temp !== undefined) patch.temperature_f = Math.max(-60, Math.min(140, temp));
  const humidity = num(r.humidity_percent);
  if (humidity !== undefined) patch.humidity_percent = Math.max(0, Math.min(100, humidity));
  const wind = num(r.wind_speed_mph);
  if (wind !== undefined) patch.wind_speed_mph = Math.max(0, Math.min(120, wind));
  if (typeof r.is_raining === "boolean") patch.is_raining = r.is_raining;
  const condition = asString(r.condition);
  if (condition) patch.condition = condition.slice(0, 120);
  return Object.keys(patch).length > 0 ? patch : null;
}

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
        "List the fragrances the signed-in user already owns, as candidate packets (id, name, brand, note pyramid, accords, performance). Use these ids when reasoning about what they own.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_input, ctx) => {
        if (deps.loadWardrobePackets) {
          const items = await deps.loadWardrobePackets(ctx);
          return { count: items.length, items };
        }
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
      name: "beam_compare_overlap",
      description:
        "Redundancy radar. Check whether a fragrance overlaps with what the user already owns " +
        "BEFORE recommending a purchase, or when they ask 'do I already own something like this?'. " +
        "Resolves the query to a REAL catalog fragrance, then deterministically compares its note " +
        "pyramid (base notes weighted most — they drive the lasting drydown) and accords against " +
        "every bottle in the vault. Returns per-bottle overlap scores, the shared notes/accords, " +
        "and the single closest match with a band (high/moderate/some/low). Do NOT estimate overlap " +
        "yourself — always call this tool so the numbers are grounded. The score is a likelihood that " +
        "two bottles fill the same wardrobe slot, not a claim of identical formula.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Brand and/or fragrance name to evaluate against the vault.",
          },
          limit: {
            type: "number",
            description: `Max owned bottles to return, ranked by overlap (server caps at ${BEAM_LIMITS.maxCatalogResults}).`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        const query = asString(record.query);
        if (!query) return { resolved: false, note: "query is required", items: [] };

        const hits = await deps.searchCatalog(query, 1);
        if (hits.length === 0) {
          return {
            resolved: false,
            note: `No catalog match for "${query}". Cannot compare an unknown fragrance — search the catalog first.`,
            items: [],
          };
        }
        const candidate = packetFromFlatProfile(hits[0].id, hits[0].flat, false);

        const owned = deps.loadWardrobePackets
          ? await deps.loadWardrobePackets(ctx)
          : (await deps.loadVault(ctx)).map((item) => packetFromOwnedItem(item));

        if (owned.length === 0) {
          return {
            resolved: true,
            candidate: { name: candidate.canonicalName, brand: candidate.brand },
            vaultCount: 0,
            note: "The vault is empty — nothing to overlap against.",
            items: [],
          };
        }

        const limit = clampLimit(record.limit, BEAM_LIMITS.maxCatalogResults, 5);
        const candidateProfile = overlapProfileFromPacket(candidate);
        const scored = owned
          .map((ownedPacket) => ({
            fragranceId: ownedPacket.fragranceId,
            name: ownedPacket.canonicalName,
            brand: ownedPacket.brand,
            overlap: computeOverlap(candidateProfile, overlapProfileFromPacket(ownedPacket)),
          }))
          .sort((a, b) => b.overlap.combined - a.overlap.combined);

        const closest = scored[0];
        return {
          resolved: true,
          candidate: {
            fragranceId: candidate.fragranceId,
            name: candidate.canonicalName,
            brand: candidate.brand,
            sourceConfidence: candidate.sourceConfidence,
            missingFields: candidate.missingFields,
          },
          vaultCount: owned.length,
          closestMatch: closest
            ? {
                name: closest.name,
                brand: closest.brand,
                band: closest.overlap.band,
                combined: closest.overlap.combined,
              }
            : null,
          count: Math.min(scored.length, limit),
          items: scored.slice(0, limit),
        };
      },
    },

    {
      name: "beam_score_candidates",
      description:
        "Deterministically rank the user's vault for a destination/energy and weather, returning the " +
        "best picks (up to " + MAX_SCORE_PICKS + ") with the engine's reasoning. Ask for `limit: 2` " +
        "when you need two bottles from the vault — the second pick is then grounded, not guessed. " +
        "By default it scores against the user's CURRENT local weather; when you're planning for a " +
        "trip or a place with a different climate, pass `weatherOverride` (typical temperature/" +
        "humidity/condition for the destination and travel dates) plus a `locationLabel` like " +
        "'Tokyo, June' so the scoring reflects where they're going, not where they are. The scoring " +
        "math runs in code — do not compute scores yourself.",
      inputSchema: {
        type: "object",
        properties: {
          destination: {
            type: "string",
            enum: ["Staying In", "Going Out", "Work", "Night Out", "Date", "Gym"],
          },
          energy: { type: "string", enum: ["Calm", "Focused", "Confident", "Social", "Relaxed"] },
          limit: {
            type: "number",
            description: `How many ranked picks to return (server caps at ${MAX_SCORE_PICKS}).`,
          },
          locationLabel: {
            type: "string",
            description: "Human label for the climate being scored, e.g. 'Tokyo, June'. Echoed back for grounding.",
          },
          weatherOverride: {
            type: "object",
            description: "Destination climate to score against instead of today's local weather.",
            properties: {
              temperature_f: { type: "number" },
              humidity_percent: { type: "number" },
              wind_speed_mph: { type: "number" },
              is_raining: { type: "boolean" },
              condition: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const [vault, localWeather] = await Promise.all([deps.loadVault(ctx), deps.getWeather(ctx)]);
        if (vault.length === 0) return { recommendation: null, picks: [], note: "vault is empty" };
        const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        const calibration = parseCalibration(input);

        // Score against the destination's climate when the agent supplies one,
        // otherwise the run's local weather. The override only patches the fields
        // it provides, so partial hints still inherit sane local defaults.
        const override = parseWeatherOverride(record.weatherOverride);
        const weather: ScentMissionWeather = override ? { ...localWeather, ...override } : localWeather;
        const locationLabel = asString(record.locationLabel);

        const limit = clampLimit(record.limit, MAX_SCORE_PICKS, 1);
        const ranked = deps.rankVault
          ? deps.rankVault(vault, calibration, weather)
          : ([deps.scoreVault(vault, calibration, weather)].filter(Boolean) as ScentMissionRecommendation[]);
        if (ranked.length === 0) return { recommendation: null, picks: [] };

        const picks = ranked.slice(0, limit).map((rec) => ({
          fragranceId: rec.fragranceId,
          canonicalName: rec.name,
          brand: rec.brand ?? "",
          score: rec.score,
          reason: rec.reason,
        }));
        return {
          // `recommendation` stays the single top pick for back-compat; `picks` is
          // the grounded ranked set the agent draws a multi-bottle kit from.
          recommendation: picks[0],
          picks,
          scoredFor: {
            locationLabel: locationLabel ?? null,
            usedOverride: override !== null,
            weather: {
              temperature_f: weather.temperature_f ?? null,
              humidity_percent: weather.humidity_percent ?? null,
              condition: weather.condition ?? null,
            },
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

  // Collection proposals are additive and opt-in: only exposed when the route
  // wires `resolveCatalogEntry`. The tool writes NOTHING — it resolves catalog
  // records into add-ready payloads and emits a `proposal` card via clientEvent;
  // the user's explicit Confirm in the app performs the actual vault write.
  const { resolveCatalogEntry } = deps;
  if (resolveCatalogEntry) {
    tools.push({
      name: "beam_propose_collection",
      description:
        "Propose a small set of NEW (unowned) fragrances to ADD to the user's vault, after they " +
        "have agreed to a plan. Pass each fragrance's name (and brand when known); they are " +
        "resolved against the real catalog server-side and unresolved names are dropped. The app " +
        "shows the user a confirmation card and ONLY saves what they approve — you never write " +
        "anything. So never claim you have added or saved bottles; say you've lined them up for " +
        "their confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          fragrances: {
            type: "array",
            description: `The fragrances to propose (server caps at ${BEAM_LIMITS.maxProposalItems}).`,
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Fragrance name (required)." },
                brand: { type: "string", description: "House/brand, when known (improves the match)." },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        required: ["fragrances"],
        additionalProperties: false,
      },
      handler: async (input, ctx) => {
        const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        const rawList = Array.isArray(record.fragrances) ? record.fragrances : [];
        const requested: Array<{ name: string; brand?: string }> = [];
        for (const entry of rawList) {
          const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
          const name = asString(e.name);
          if (name) requested.push({ name, brand: asString(e.brand) });
          if (requested.length >= BEAM_LIMITS.maxProposalItems) break;
        }

        const items: BeamProposalItem[] = [];
        const unresolved: string[] = [];
        for (const req of requested) {
          const flat = await resolveCatalogEntry(req.name, req.brand).catch(() => null);
          const built = flat ? buildProposalItem(flat) : null;
          if (built) items.push(built);
          else unresolved.push(req.brand ? `${req.brand} ${req.name}` : req.name);
        }

        const proposalId = `prop_${ctx.runId}_${Date.now().toString(36)}`;
        return {
          proposalId,
          count: items.length,
          // `items` carries the full add-ready payloads (also read by clientEvent);
          // `proposed` is the compact list the model references in its prose.
          items,
          proposed: items.map((i) => ({ name: i.name, brand: i.brand })),
          unresolved,
        };
      },
      clientEvent: (result) => {
        const r = (typeof result === "object" && result !== null ? result : {}) as {
          proposalId?: unknown;
          items?: unknown;
        };
        if (typeof r.proposalId !== "string" || !Array.isArray(r.items) || r.items.length === 0) return null;
        return { type: "proposal", proposalId: r.proposalId, items: r.items as BeamProposalItem[] };
      },
    });
  }

  return tools;
}
