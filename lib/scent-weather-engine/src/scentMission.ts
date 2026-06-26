import {
  calculateScentWeatherRecommendation,
  traitsMatchScentFamily,
  type ScentWeatherEngineInput,
  type ScentWeatherRecommendation,
} from "./scentWeatherEngine.ts";

/**
 * Scent Mission — shared domain model for the embedded mission agent.
 *
 * Everything in this module is pure and deterministic so the same node
 * progression and recommendation selection can run on the API server
 * (POST /api/scent-mission) and be replayed/validated on the client.
 * See docs/SCENT_MISSION_GUIDE.md for the full contract.
 */

export type ScentMissionNodeId =
  | "onboarding"
  | "wardrobe-sync"
  | "environment-scan"
  | "resolution-standard"
  | "resolution-premium";

export type ScentMissionNodeStatus =
  | "locked"
  | "active"
  | "running"
  | "complete"
  | "blocked";

export const SCENT_MISSION_NODE_ORDER: readonly ScentMissionNodeId[] = [
  "onboarding",
  "wardrobe-sync",
  "environment-scan",
  "resolution-standard",
  "resolution-premium",
];

export type ScentMissionDestination =
  | "Staying In"
  | "Going Out"
  | "Work"
  | "Night Out"
  | "Date"
  | "Gym";

export type ScentMissionEnergy =
  | "Calm"
  | "Focused"
  | "Confident"
  | "Social"
  | "Relaxed";

export type ScentMissionCalibration = {
  destination?: ScentMissionDestination;
  energy?: ScentMissionEnergy;
};

export type ScentMissionMessage = {
  id: string;
  role: "agent" | "user" | "system";
  text: string;
  nodeId?: ScentMissionNodeId;
  createdAt: number;
};

export type ScentMissionState = {
  nodes: Record<ScentMissionNodeId, ScentMissionNodeStatus>;
  calibration: ScentMissionCalibration;
  /** Always false in the MVP — Premium molecular intelligence is a visual lock only. */
  premiumUnlocked: boolean;
};

/** Sanitized wardrobe summary — the only fragrance shape the mission API accepts. */
export type ScentMissionWardrobeItem = {
  id: string;
  dbId?: string | null;
  name: string;
  brand?: string;
  concentration?: string;
  families?: string[];
  accords?: string[];
  sillage?: string;
  longevity?: string | number;
};

export type ScentMissionWeather = {
  temperature_f?: number;
  humidity_percent?: number;
  wind_speed_mph?: number;
  is_raining?: boolean;
  condition?: string;
  /** OpenWeather One Call `current.uvi`; null when the provider/fallback has no UV data. */
  uv_index?: number | null;
  location?: string;
  isLive?: boolean;
};

export type ScentMissionRecommendation = {
  /** Client wardrobe id of the selected fragrance. */
  fragranceId: string;
  /** Postgres row UUID when the wardrobe came from the server. */
  dbId?: string | null;
  name: string;
  brand?: string;
  engine: ScentWeatherRecommendation;
  reason: string;
  score: number;
};

export type ScentMissionNodeUpdate = {
  nodeId: ScentMissionNodeId;
  status: ScentMissionNodeStatus;
};

export type ScentMissionRequestAction = "chat" | "execute_node";

export type ScentMissionRequest = {
  action: ScentMissionRequestAction;
  nodeId?: ScentMissionNodeId;
  sessionId?: string;
  userMessage?: string;
  mission: ScentMissionState;
  context: {
    weather: ScentMissionWeather;
    wardrobe?: ScentMissionWardrobeItem[];
  };
};

export type ScentMissionPremiumLock = {
  locked: true;
  title: string;
  body: string;
  cta: string;
};

export type ScentMissionResponse = {
  sessionId: string;
  assistantMessage?: string;
  nodeUpdates?: ScentMissionNodeUpdate[];
  missionPatch?: Partial<ScentMissionState>;
  recommendation?: ScentMissionRecommendation;
  research?: unknown;
  premiumLock?: ScentMissionPremiumLock;
};

const NODE_STATUSES: readonly ScentMissionNodeStatus[] = [
  "locked",
  "active",
  "running",
  "complete",
  "blocked",
];

const DESTINATIONS: readonly ScentMissionDestination[] = [
  "Staying In",
  "Going Out",
  "Work",
  "Night Out",
  "Date",
  "Gym",
];

const ENERGIES: readonly ScentMissionEnergy[] = [
  "Calm",
  "Focused",
  "Confident",
  "Social",
  "Relaxed",
];

export function isScentMissionNodeId(value: unknown): value is ScentMissionNodeId {
  return typeof value === "string" && (SCENT_MISSION_NODE_ORDER as readonly string[]).includes(value);
}

export function isScentMissionNodeStatus(value: unknown): value is ScentMissionNodeStatus {
  return typeof value === "string" && (NODE_STATUSES as readonly string[]).includes(value);
}

export function isScentMissionDestination(value: unknown): value is ScentMissionDestination {
  return typeof value === "string" && (DESTINATIONS as readonly string[]).includes(value);
}

export function isScentMissionEnergy(value: unknown): value is ScentMissionEnergy {
  return typeof value === "string" && (ENERGIES as readonly string[]).includes(value);
}

/** Fresh mission: onboarding active, everything downstream locked. */
export function createScentMissionState(): ScentMissionState {
  return {
    nodes: {
      onboarding: "active",
      "wardrobe-sync": "locked",
      "environment-scan": "locked",
      "resolution-standard": "locked",
      "resolution-premium": "locked",
    },
    calibration: {},
    premiumUnlocked: false,
  };
}

/**
 * Coerce an untrusted mission state (client-supplied) into a valid one.
 * Unknown node statuses fall back to a fresh progression; calibration values
 * outside the closed vocabularies are dropped. Premium can never arrive
 * unlocked from the client in the MVP.
 */
export function sanitizeScentMissionState(input: unknown): ScentMissionState {
  const fresh = createScentMissionState();
  if (typeof input !== "object" || input === null) return fresh;
  const record = input as { nodes?: unknown; calibration?: unknown };

  const calibration: ScentMissionCalibration = {};
  if (typeof record.calibration === "object" && record.calibration !== null) {
    const cal = record.calibration as { destination?: unknown; energy?: unknown };
    if (isScentMissionDestination(cal.destination)) calibration.destination = cal.destination;
    if (isScentMissionEnergy(cal.energy)) calibration.energy = cal.energy;
  }

  const rawNodes =
    typeof record.nodes === "object" && record.nodes !== null
      ? (record.nodes as Record<string, unknown>)
      : {};
  const nodes: Record<ScentMissionNodeId, ScentMissionNodeStatus> = { ...fresh.nodes };
  let stoppedAtIncomplete = false;

  for (const nodeId of SCENT_MISSION_NODE_ORDER) {
    if (stoppedAtIncomplete) {
      nodes[nodeId] = "locked";
      continue;
    }

    if (nodeId === "resolution-premium") {
      nodes[nodeId] = nodes["resolution-standard"] === "complete" ? "blocked" : "locked";
      stoppedAtIncomplete = true;
      continue;
    }

    const rawStatus = rawNodes[nodeId];
    const status = isScentMissionNodeStatus(rawStatus) ? rawStatus : undefined;
    if (status === "complete") {
      nodes[nodeId] = "complete";
      continue;
    }
    if (status === "running" || status === "blocked") {
      nodes[nodeId] = status;
      stoppedAtIncomplete = true;
      continue;
    }

    // The first incomplete standard node is always the active frontier. This
    // repairs hostile/stale states that mark downstream nodes active or the
    // current frontier locked.
    nodes[nodeId] = "active";
    stoppedAtIncomplete = true;
  }

  return { nodes, calibration, premiumUnlocked: false };
}

/**
 * Complete `nodeId` and activate the next node in the graph. The premium
 * resolution node never activates while `premiumUnlocked` is false — it moves
 * to `blocked` (reachable but gated) instead. Completing a node that is not
 * currently active/running is a no-op, which keeps replays idempotent.
 */
export function completeScentMissionNode(
  state: ScentMissionState,
  nodeId: ScentMissionNodeId,
): ScentMissionState {
  const current = state.nodes[nodeId];
  if (
    current !== "active" &&
    current !== "running" &&
    !(current === "blocked" && nodeId !== "resolution-premium")
  ) {
    return state;
  }

  const nodes: Record<ScentMissionNodeId, ScentMissionNodeStatus> = {
    ...state.nodes,
    [nodeId]: "complete",
  };

  const index = SCENT_MISSION_NODE_ORDER.indexOf(nodeId);
  const next = SCENT_MISSION_NODE_ORDER[index + 1];
  if (next && nodes[next] === "locked") {
    nodes[next] = next === "resolution-premium" && !state.premiumUnlocked ? "blocked" : "active";
  }

  return { ...state, nodes };
}

export function isScentMissionNodeExecutable(
  state: ScentMissionState,
  nodeId: ScentMissionNodeId,
): boolean {
  const status = state.nodes[nodeId];
  return status === "active" || status === "running" || status === "blocked";
}

/** Diff two mission states into the wire-format node updates. */
export function diffScentMissionNodes(
  prev: ScentMissionState,
  next: ScentMissionState,
): ScentMissionNodeUpdate[] {
  const updates: ScentMissionNodeUpdate[] = [];
  for (const nodeId of SCENT_MISSION_NODE_ORDER) {
    if (prev.nodes[nodeId] !== next.nodes[nodeId]) {
      updates.push({ nodeId, status: next.nodes[nodeId] });
    }
  }
  return updates;
}

/** Apply a server response's node updates + mission patch on the client. */
export function applyScentMissionUpdates(
  state: ScentMissionState,
  updates: ScentMissionNodeUpdate[] | undefined,
  patch: Partial<ScentMissionState> | undefined,
): ScentMissionState {
  let nodes = state.nodes;
  if (updates && updates.length > 0) {
    nodes = { ...nodes };
    for (const update of updates) {
      if (isScentMissionNodeId(update.nodeId) && isScentMissionNodeStatus(update.status)) {
        nodes[update.nodeId] = update.status;
      }
    }
  }
  return {
    nodes,
    calibration: { ...state.calibration, ...(patch?.calibration ?? {}) },
    // The MVP never unlocks premium from a patch.
    premiumUnlocked: false,
  };
}

const MAX_WARDROBE_ITEMS = 60;
const MAX_TRAIT_ENTRIES = 24;
const MAX_TEXT_LENGTH = 120;

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_TEXT_LENGTH);
}

function cleanTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = cleanText(entry);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_TRAIT_ENTRIES) break;
  }
  return out;
}

/**
 * Coerce an untrusted wardrobe payload (guest local state, or rows mapped by
 * the server) into bounded, text-only mission items. Entries without a usable
 * id+name are dropped.
 */
export function sanitizeScentMissionWardrobe(input: unknown): ScentMissionWardrobeItem[] {
  if (!Array.isArray(input)) return [];
  const items: ScentMissionWardrobeItem[] = [];
  for (const entry of input) {
    if (items.length >= MAX_WARDROBE_ITEMS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = cleanText(record.id);
    const name = cleanText(record.name);
    if (!id || !name) continue;
    const longevityRaw = record.longevity;
    const longevity =
      typeof longevityRaw === "number" && Number.isFinite(longevityRaw)
        ? longevityRaw
        : cleanText(longevityRaw);
    items.push({
      id,
      ...(cleanText(record.dbId) ? { dbId: cleanText(record.dbId) } : {}),
      name,
      ...(cleanText(record.brand) ? { brand: cleanText(record.brand) } : {}),
      ...(cleanText(record.concentration) ? { concentration: cleanText(record.concentration) } : {}),
      families: cleanTextList(record.families),
      accords: cleanTextList(record.accords),
      ...(cleanText(record.sillage) ? { sillage: cleanText(record.sillage) } : {}),
      ...(longevity !== undefined ? { longevity } : {}),
    });
  }
  return items;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Coerce untrusted weather context. Missing fields stay undefined so the engine's own fallbacks apply. */
export function sanitizeScentMissionWeather(input: unknown): ScentMissionWeather {
  if (typeof input !== "object" || input === null) return {};
  const record = input as Record<string, unknown>;
  const uv = record.uv_index;
  return {
    temperature_f: finiteOrUndefined(record.temperature_f ?? record.temperature ?? record.temp),
    humidity_percent: finiteOrUndefined(record.humidity_percent ?? record.humidity),
    wind_speed_mph: finiteOrUndefined(record.wind_speed_mph ?? record.windSpeed),
    is_raining: typeof record.is_raining === "boolean" ? record.is_raining : undefined,
    condition: cleanText(record.condition ?? record.description),
    uv_index: typeof uv === "number" && Number.isFinite(uv) ? uv : null,
    location: cleanText(record.location),
    isLive: typeof record.isLive === "boolean" ? record.isLive : undefined,
  };
}

const RAIN_SIGNALS = ["rain", "drizzle", "storm"];

export function destinationToSettingType(
  destination: ScentMissionDestination | undefined,
): ScentWeatherEngineInput["setting"]["type"] {
  switch (destination) {
    case "Work":
      return "work";
    case "Night Out":
      return "night";
    case "Going Out":
      return "mixed";
    case "Date":
      return "date";
    case "Gym":
      return "gym";
    default:
      return "indoor";
  }
}

export function buildScentMissionEngineInput(
  item: ScentMissionWardrobeItem,
  calibration: ScentMissionCalibration,
  weather: ScentMissionWeather,
): ScentWeatherEngineInput {
  const condition = weather.condition ?? "";
  const isRaining =
    weather.is_raining ??
    RAIN_SIGNALS.some((signal) => condition.toLowerCase().includes(signal));

  return {
    weather: {
      temperature_f: weather.temperature_f ?? 72,
      humidity_percent: weather.humidity_percent ?? 50,
      wind_speed_mph: weather.wind_speed_mph ?? 0,
      is_raining: isRaining,
      // Forward the live UV reading (already sanitized onto ScentMissionWeather
      // but previously dropped here) so the engine's high_uv_rule fires on the
      // chat-agent path too. time_of_day/season are intentionally omitted: this
      // builder runs server-side where the wall clock is the wrong timezone.
      uv_index: weather.uv_index ?? null,
      condition,
    },
    setting: {
      type: destinationToSettingType(calibration.destination),
    },
    fragrance: {
      name: item.name,
      brand: item.brand,
      concentration: item.concentration,
      scent_families: item.families,
      accords: item.accords,
      longevity: item.longevity,
      sillage: item.sillage,
    },
  };
}

function recommendationDisplayScore(recommendation: ScentWeatherRecommendation): number {
  const confidenceBase = { high: 92, medium: 78, low: 62 } as const;
  const projectionPenalty = { low: 0, medium: 4, high: 10, overpowering_risk: 18 } as const;
  const wearWindowPenalty = {
    best_now: 0,
    daytime_safe: 2,
    better_later: 8,
    nighttime_better: 10,
    avoid_today: 28,
  } as const;

  return Math.max(
    0,
    Math.min(
      100,
      confidenceBase[recommendation.confidence] -
        projectionPenalty[recommendation.projection_risk] -
        wearWindowPenalty[recommendation.wear_window],
    ),
  );
}

function itemTraitTexts(item: ScentMissionWardrobeItem): string[] {
  return [...(item.families ?? []), ...(item.accords ?? [])]
    .map((trait) => trait.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Score every wardrobe item with the shared weather engine and return them
 * ranked best-first. Mirrors the frontend's vault alignment scoring: engine
 * display score plus best-family hits, minus avoid-family hits. Deterministic —
 * ties break by wardrobe order (a stable sort over the input order).
 */
export function rankScentMissionRecommendations(
  wardrobe: ScentMissionWardrobeItem[],
  calibration: ScentMissionCalibration,
  weather: ScentMissionWeather,
): ScentMissionRecommendation[] {
  const ranked: ScentMissionRecommendation[] = wardrobe.map((item) => {
    const engine = calculateScentWeatherRecommendation(
      buildScentMissionEngineInput(item, calibration, weather),
    );
    const traits = itemTraitTexts(item);
    const bestHits = engine.best_scent_families.filter((family) =>
      traitsMatchScentFamily(traits, family),
    ).length;
    const avoidHits = engine.avoid_scent_families.filter((family) =>
      traitsMatchScentFamily(traits, family),
    ).length;
    const score = recommendationDisplayScore(engine) + bestHits * 8 - avoidHits * 14;
    return {
      fragranceId: item.id,
      ...(item.dbId !== undefined ? { dbId: item.dbId } : {}),
      name: item.name,
      ...(item.brand !== undefined ? { brand: item.brand } : {}),
      engine,
      reason: engine.explanation,
      score,
    };
  });

  // Stable sort: Array.prototype.sort is stable in modern engines, so equal
  // scores keep wardrobe order — preserving the original tie-break guarantee.
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Score every wardrobe item and return the single winner. Thin wrapper over
 * `rankScentMissionRecommendations` so the single-pick callers (the scent-mission
 * route, the client) keep their existing contract unchanged.
 */
export function selectScentMissionRecommendation(
  wardrobe: ScentMissionWardrobeItem[],
  calibration: ScentMissionCalibration,
  weather: ScentMissionWeather,
): ScentMissionRecommendation | null {
  return rankScentMissionRecommendations(wardrobe, calibration, weather)[0] ?? null;
}
