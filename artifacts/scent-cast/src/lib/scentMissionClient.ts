import {
  sanitizeScentMissionWardrobe,
  sanitizeScentMissionWeather,
  SCENT_MISSION_NODE_ORDER,
  type ScentMissionNodeId,
  type ScentMissionRecommendation,
  type ScentMissionState,
  type ScentMissionWardrobeItem,
  type ScentMissionWeather,
} from "@workspace/scent-weather-engine";

/**
 * Pure client-side helpers for the Scent Mission panel: building the sanitized
 * request context from local app state and interpreting server responses.
 * Kept free of React/DOM so it runs under the node test runner.
 */

/** Structural subset of the app's `Fragrance` shape that the mission needs. */
export type MissionSourceItem = {
  id: string;
  _dbId?: string;
  name?: string;
  brand?: string;
  house?: string;
  family?: string;
  concentration?: string;
  notes?: string[];
  accords?: unknown;
  pyramid?: { top?: string[]; heart?: string[]; base?: string[] };
  performance?: { sillage?: number; longevity?: number };
  product?: { name?: string; brand?: string };
};

function stringList(...sources: unknown[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    if (typeof source === "string") {
      out.push(source);
    } else if (Array.isArray(source)) {
      for (const entry of source) {
        if (typeof entry === "string") out.push(entry);
      }
    }
  }
  return out;
}

function sillageLabel(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 8) return "strong";
    if (value <= 3) return "light";
    return "moderate";
  }
  return undefined;
}

/**
 * Guest path: project local wardrobe state into the bounded mission summary
 * the API accepts. Signed-in users send this too, but the server replaces it
 * with DB rows.
 */
export function buildMissionWardrobe(items: MissionSourceItem[]): ScentMissionWardrobeItem[] {
  return sanitizeScentMissionWardrobe(
    items.map((item) => ({
      id: item.id,
      dbId: item._dbId,
      name: item.name ?? item.product?.name,
      brand: item.brand ?? item.product?.brand ?? item.house,
      concentration: item.concentration,
      families: stringList(item.family),
      accords: stringList(
        item.accords,
        item.notes,
        item.pyramid?.top,
        item.pyramid?.heart,
        item.pyramid?.base,
      ),
      sillage: sillageLabel(item.performance?.sillage),
      longevity: item.performance?.longevity,
    })),
  );
}

/** Normalize the WeatherContext payload (aliased fields) into mission weather. */
export function buildMissionWeather(weather: unknown): ScentMissionWeather {
  return sanitizeScentMissionWeather(weather);
}

/**
 * Map a mission recommendation back to the local wardrobe entry so "Reveal
 * Match" can open the existing recommendation overlay. Prefers the DB row id,
 * then the client id, then a normalized brand+name match.
 */
export function findWardrobeMatch<T extends MissionSourceItem>(
  items: T[],
  recommendation: Pick<ScentMissionRecommendation, "fragranceId" | "dbId" | "name" | "brand">,
): T | null {
  if (recommendation.dbId) {
    const byDbId = items.find((item) => item._dbId === recommendation.dbId);
    if (byDbId) return byDbId;
  }
  const byId = items.find((item) => item.id === recommendation.fragranceId);
  if (byId) return byId;

  const norm = (value?: string) => (value ?? "").trim().toLowerCase();
  const wantedName = norm(recommendation.name);
  if (!wantedName) return null;
  const wantedBrand = norm(recommendation.brand);
  return (
    items.find((item) => {
      const name = norm(item.name ?? item.product?.name);
      if (name !== wantedName) return false;
      if (!wantedBrand) return true;
      const brand = norm(item.brand ?? item.product?.brand ?? item.house);
      return !brand || brand === wantedBrand;
    }) ?? null
  );
}

/** The node the user can currently act on, if any. */
export function activeMissionNode(state: ScentMissionState): ScentMissionNodeId | null {
  let retryableBlocked: ScentMissionNodeId | null = null;
  for (const nodeId of SCENT_MISSION_NODE_ORDER) {
    const status = state.nodes[nodeId];
    if (status === "active" || status === "running") return nodeId;
    if (status === "blocked" && nodeId !== "resolution-premium" && !retryableBlocked) {
      retryableBlocked = nodeId;
    }
  }
  return retryableBlocked;
}

/** Fraction of completed nodes (0..1) — drives the SVG trunk path progress. */
export function missionProgress(state: ScentMissionState): number {
  const total = SCENT_MISSION_NODE_ORDER.length;
  const complete = SCENT_MISSION_NODE_ORDER.filter(
    (nodeId) => state.nodes[nodeId] === "complete",
  ).length;
  return total === 0 ? 0 : complete / total;
}

/** Composer chips suggested for the current mission position. */
export function suggestedMissionChips(state: ScentMissionState): string[] {
  const active = activeMissionNode(state);
  switch (active) {
    case "onboarding":
      return ["What does calibration do?", "How do you pick my match?"];
    case "wardrobe-sync":
      return ["What's in my vault?", "Which families do I own most?"];
    case "environment-scan":
      return ["How's the weather for fragrance?", "Does humidity matter?"];
    case "resolution-standard":
      return ["What should I wear today?", "What are you avoiding today?"];
    default:
      return state.nodes["resolution-standard"] === "complete"
        ? ["Why this match?", "What should I avoid today?"]
        : ["What can you do?"];
  }
}
