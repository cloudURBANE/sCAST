import { randomUUID } from "node:crypto";
import {
  completeScentMissionNode,
  diffScentMissionNodes,
  isScentMissionDestination,
  isScentMissionEnergy,
  isScentMissionNodeId,
  isScentMissionNodeExecutable,
  sanitizeScentMissionState,
  sanitizeScentMissionWardrobe,
  sanitizeScentMissionWeather,
  selectScentMissionRecommendation,
  type ScentMissionCalibration,
  type ScentMissionDestination,
  type ScentMissionEnergy,
  type ScentMissionNodeId,
  type ScentMissionPremiumLock,
  type ScentMissionRequest,
  type ScentMissionResponse,
  type ScentMissionState,
  type ScentMissionWardrobeItem,
  type ScentMissionWeather,
} from "@workspace/scent-weather-engine";

/**
 * Stateless mission agent behind POST /api/scent-mission.
 *
 * The server holds no session state: every request carries the full mission
 * state, the server validates it, executes one step (a chat turn or a node
 * execution), and returns patches the client applies. Chat persistence is
 * deliberately deferred — the existing `conversations`/`messages` tables are
 * not tenant/user-scoped, so nothing is written to them (see
 * docs/SCENT_MISSION_GUIDE.md).
 */

const MAX_USER_MESSAGE_LENGTH = 2_000;
const SESSION_ID_RE = /^[0-9a-zA-Z_-]{8,64}$/;

const NODE_LABELS: Record<ScentMissionNodeId, string> = {
  onboarding: "Calibration",
  "wardrobe-sync": "Vault Sync",
  "environment-scan": "Environment Scan",
  "resolution-standard": "Resolution",
  "resolution-premium": "Molecular Intelligence",
};

export type ScentMissionChatContext = {
  mission: ScentMissionState;
  wardrobe: ScentMissionWardrobeItem[];
  weather: ScentMissionWeather;
  userMessage: string;
};

/** Returns a plain-text agent reply. Implementations may call an LLM. */
export type ScentMissionChatFn = (context: ScentMissionChatContext) => Promise<string>;

/** Fragrance-specific research hook (scent-facts pipeline). Best-effort. */
export type ScentMissionResearchFn = (fragranceName: string) => Promise<unknown>;

export type ScentMissionServiceDeps = {
  llmChat?: ScentMissionChatFn | null;
  research?: ScentMissionResearchFn | null;
};

export type ParsedScentMissionRequest =
  | { ok: true; request: ScentMissionRequest }
  | { ok: false; error: string };

export function parseScentMissionRequest(body: unknown): ParsedScentMissionRequest {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;

  const action = record.action;
  if (action !== "chat" && action !== "execute_node") {
    return { ok: false, error: "action must be 'chat' or 'execute_node'." };
  }

  let nodeId: ScentMissionNodeId | undefined;
  if (action === "execute_node") {
    if (!isScentMissionNodeId(record.nodeId)) {
      return { ok: false, error: "execute_node requires a valid nodeId." };
    }
    nodeId = record.nodeId;
  }

  let userMessage: string | undefined;
  if (record.userMessage !== undefined) {
    if (typeof record.userMessage !== "string") {
      return { ok: false, error: "userMessage must be a string." };
    }
    userMessage = record.userMessage.trim().slice(0, MAX_USER_MESSAGE_LENGTH);
  }
  if (action === "chat" && !userMessage) {
    return { ok: false, error: "chat requires a non-empty userMessage." };
  }

  const sessionId =
    typeof record.sessionId === "string" && SESSION_ID_RE.test(record.sessionId)
      ? record.sessionId
      : randomUUID();

  const context =
    typeof record.context === "object" && record.context !== null
      ? (record.context as Record<string, unknown>)
      : {};

  return {
    ok: true,
    request: {
      action,
      ...(nodeId ? { nodeId } : {}),
      sessionId,
      ...(userMessage ? { userMessage } : {}),
      mission: sanitizeScentMissionState(record.mission),
      context: {
        weather: sanitizeScentMissionWeather(context.weather),
        wardrobe: sanitizeScentMissionWardrobe(context.wardrobe),
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Wardrobe row mapping (signed-in users)                              */
/* ------------------------------------------------------------------ */

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
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 8) return "strong";
    if (value <= 3) return "light";
    return "moderate";
  }
  return undefined;
}

/**
 * Project a `user_fragrances` row's JSONB payload into the bounded mission
 * wardrobe shape. Output still goes through `sanitizeScentMissionWardrobe`
 * before use, so this only needs to surface candidate fields.
 */
export function missionItemFromWardrobeRow(
  rowId: string,
  fragranceData: unknown,
): Record<string, unknown> | null {
  if (typeof fragranceData !== "object" || fragranceData === null) return null;
  const data = fragranceData as Record<string, any>;
  const name = typeof data.name === "string" && data.name.trim()
    ? data.name
    : typeof data.product?.name === "string"
      ? data.product.name
      : "";
  if (!name) return null;

  const pyramid = typeof data.pyramid === "object" && data.pyramid !== null ? data.pyramid : {};

  return {
    id: typeof data.id === "string" && data.id ? data.id : rowId,
    dbId: rowId,
    name,
    brand: data.brand ?? data.product?.brand ?? data.house,
    concentration: data.concentration,
    families: stringList(data.family, data.scent_families, data.families),
    accords: stringList(
      data.accords,
      data.notes,
      pyramid.top,
      pyramid.heart,
      pyramid.base,
    ),
    sillage: sillageLabel(data.sillage ?? data.performance?.sillage),
    longevity: data.longevity ?? data.performance?.longevity,
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic mission copy                                          */
/* ------------------------------------------------------------------ */

const PREMIUM_LOCK: ScentMissionPremiumLock = {
  locked: true,
  title: "Molecular Intelligence",
  body: "Premium resolution maps your match at the molecule level — note volatility curves, projection modelling, and a layering protocol tuned to today's air.",
  cta: "Premium access is coming soon.",
};

function formatUv(weather: ScentMissionWeather): string {
  return typeof weather.uv_index === "number"
    ? `UV index ${weather.uv_index.toFixed(1)}`
    : "UV index unavailable";
}

function describeWeather(weather: ScentMissionWeather): string {
  const parts: string[] = [];
  if (typeof weather.temperature_f === "number") parts.push(`${Math.round(weather.temperature_f)}°F`);
  if (typeof weather.humidity_percent === "number") parts.push(`${Math.round(weather.humidity_percent)}% humidity`);
  if (typeof weather.wind_speed_mph === "number") parts.push(`${Math.round(weather.wind_speed_mph)} mph wind`);
  if (weather.condition) parts.push(weather.condition);
  parts.push(formatUv(weather));
  return parts.join(", ");
}

function topFamilies(wardrobe: ScentMissionWardrobeItem[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const item of wardrobe) {
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

function deterministicChatReply(context: ScentMissionChatContext): string {
  const message = context.userMessage.toLowerCase();
  const { mission, wardrobe, weather } = context;

  const calibration = inferCalibrationFromMessage(context.userMessage, mission.calibration);
  if (calibration.changed) {
    return calibrationUpdatedReply(calibration.calibration);
  }

  if (/(weather|humidity|temperature|uv|rain|outside)/.test(message)) {
    return `Current atmosphere: ${describeWeather(weather)}. Run the environment scan node to fold this into your mission calibration.`;
  }

  if (/(recommend|what should i wear|pick|match|best)/.test(message)) {
    if (mission.nodes["resolution-standard"] === "complete") {
      return "Your standard resolution is already complete — use Reveal Match to see the full breakdown, or ask me about the pick.";
    }
    return "Work through the mission tree to reach your match: calibrate, sync your vault, scan the environment, then execute the resolution node.";
  }

  const mentioned = wardrobe.find((item) => message.includes(item.name.toLowerCase()));
  if (mentioned) {
    const traits = [...(mentioned.families ?? []), ...(mentioned.accords ?? [])].slice(0, 6);
    return traits.length > 0
      ? `${mentioned.name}${mentioned.brand ? ` by ${mentioned.brand}` : ""} reads as ${traits.join(", ")}. I weigh those traits against today's air when scoring your vault.`
      : `${mentioned.name} is in your vault, but I have little trait data on it yet — open its card to enrich it for sharper scoring.`;
  }

  const activeNode = (Object.entries(mission.nodes) as [ScentMissionNodeId, string][]).find(
    ([, status]) => status === "active",
  )?.[0];
  if (activeNode) {
    return `Mission status: ${activeNode.replace(/-/g, " ")} is ready. Hit Execute Analysis to advance, or ask me about your vault or today's conditions.`;
  }
  return "Mission complete on the standard track. Ask me about your match, your vault, or today's conditions.";
}

const DESTINATION_PATTERNS: Array<[ScentMissionDestination, RegExp]> = [
  ["Staying In", /\b(staying in|stay in|home|inside|indoors?)\b/i],
  ["Going Out", /\b(going out|out and about|errands?|day out)\b/i],
  ["Work", /\b(work|office|meeting|client|presentation)\b/i],
  ["Night Out", /\b(night out|club|bar|party|evening)\b/i],
  ["Date", /\b(date|romantic|dinner date)\b/i],
  ["Gym", /\b(gym|workout|training|run|fitness)\b/i],
];

const ENERGY_PATTERNS: Array<[ScentMissionEnergy, RegExp]> = [
  ["Calm", /\b(calm|quiet|soft|subtle)\b/i],
  ["Focused", /\b(focused|focus|productive|sharp)\b/i],
  ["Confident", /\b(confident|confidence|bold|commanding)\b/i],
  ["Social", /\b(social|friendly|approachable|chatty)\b/i],
  ["Relaxed", /\b(relaxed|relaxing|casual|easy)\b/i],
];

function inferCalibrationFromMessage(
  userMessage: string,
  current: ScentMissionCalibration,
): { changed: boolean; calibration: ScentMissionCalibration } {
  const next: ScentMissionCalibration = { ...current };
  for (const [destination, pattern] of DESTINATION_PATTERNS) {
    if (pattern.test(userMessage) && isScentMissionDestination(destination)) {
      next.destination = destination;
      break;
    }
  }
  for (const [energy, pattern] of ENERGY_PATTERNS) {
    if (pattern.test(userMessage) && isScentMissionEnergy(energy)) {
      next.energy = energy;
      break;
    }
  }

  return {
    changed: next.destination !== current.destination || next.energy !== current.energy,
    calibration: next,
  };
}

function calibrationUpdatedReply(calibration: ScentMissionCalibration): string {
  const parts = [
    calibration.destination ? `destination: ${calibration.destination}` : null,
    calibration.energy ? `energy: ${calibration.energy}` : null,
  ].filter(Boolean);
  return `Calibration updated (${parts.join(", ")}). When both destination and energy are set, lock calibration to begin the mission tree.`;
}

function lockedNodeMessage(nodeId: ScentMissionNodeId, status: string): string {
  const label = NODE_LABELS[nodeId];
  if (status === "complete") {
    return `${label} is already complete. Continue with the next available mission node.`;
  }
  return `${label} is locked right now. Complete the current mission node first.`;
}

/* ------------------------------------------------------------------ */
/* Node execution                                                      */
/* ------------------------------------------------------------------ */

type NodeExecutionResult = Pick<
  ScentMissionResponse,
  "assistantMessage" | "nodeUpdates" | "missionPatch" | "recommendation" | "research" | "premiumLock"
>;

async function executeNode(
  nodeId: ScentMissionNodeId,
  mission: ScentMissionState,
  wardrobe: ScentMissionWardrobeItem[],
  weather: ScentMissionWeather,
  deps: ScentMissionServiceDeps,
): Promise<NodeExecutionResult> {
  switch (nodeId) {
    case "onboarding": {
      const { destination, energy } = mission.calibration;
      if (!destination || !energy) {
        return {
          assistantMessage:
            "Calibration incomplete — choose a destination and an energy state, then execute again.",
        };
      }
      const next = completeScentMissionNode(mission, "onboarding");
      return {
        assistantMessage: `Calibration locked: ${destination}, ${energy} energy. Next, I'll sync your vault.`,
        nodeUpdates: diffScentMissionNodes(mission, next),
        missionPatch: { calibration: mission.calibration },
      };
    }

    case "wardrobe-sync": {
      if (wardrobe.length === 0) {
        const next: ScentMissionState = {
          ...mission,
          nodes: { ...mission.nodes, "wardrobe-sync": "blocked" },
        };
        return {
          assistantMessage:
            "Your vault is empty, so there is nothing to sync. Add fragrances from the search panel, then re-run this node.",
          nodeUpdates: diffScentMissionNodes(mission, next),
        };
      }
      const families = topFamilies(wardrobe);
      const next = completeScentMissionNode(mission, "wardrobe-sync");
      return {
        assistantMessage: `Vault synced — ${wardrobe.length} fragrance${wardrobe.length === 1 ? "" : "s"} profiled${
          families.length > 0 ? `, leaning ${families.join(" / ")}` : ""
        }. Environment scan is next.`,
        nodeUpdates: diffScentMissionNodes(mission, next),
      };
    }

    case "environment-scan": {
      const next = completeScentMissionNode(mission, "environment-scan");
      return {
        assistantMessage: `Environment locked: ${describeWeather(weather)}. Resolution is armed.`,
        nodeUpdates: diffScentMissionNodes(mission, next),
      };
    }

    case "resolution-standard": {
      const recommendation = selectScentMissionRecommendation(
        wardrobe,
        mission.calibration,
        weather,
      );
      if (!recommendation) {
        const next: ScentMissionState = {
          ...mission,
          nodes: { ...mission.nodes, "resolution-standard": "blocked" },
        };
        return {
          assistantMessage:
            "I can't resolve a match without a synced vault. Add fragrances and re-run wardrobe sync first.",
          nodeUpdates: diffScentMissionNodes(mission, next),
        };
      }

      let research: unknown;
      if (deps.research) {
        try {
          research = await deps.research(
            [recommendation.brand, recommendation.name].filter(Boolean).join(" "),
          );
        } catch {
          // Research is decorative for the MVP — a failed lookup never blocks the match.
          research = undefined;
        }
      }

      const next = completeScentMissionNode(mission, "resolution-standard");
      return {
        assistantMessage: `Resolution: wear ${recommendation.name}${
          recommendation.brand ? ` by ${recommendation.brand}` : ""
        }. ${recommendation.reason}`,
        nodeUpdates: diffScentMissionNodes(mission, next),
        recommendation,
        ...(research !== undefined ? { research } : {}),
      };
    }

    case "resolution-premium": {
      return {
        assistantMessage: `${PREMIUM_LOCK.title} is locked for now. ${PREMIUM_LOCK.body}`,
        premiumLock: PREMIUM_LOCK,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function executeScentMission(
  request: ScentMissionRequest,
  opts: {
    /** Wardrobe loaded from the DB for a signed-in user; overrides client-sent items. */
    serverWardrobe?: ScentMissionWardrobeItem[];
    deps?: ScentMissionServiceDeps;
  } = {},
): Promise<ScentMissionResponse> {
  const deps = opts.deps ?? {};
  const sessionId = request.sessionId ?? randomUUID();
  const wardrobe = opts.serverWardrobe ?? request.context.wardrobe ?? [];
  const weather = request.context.weather ?? {};

  if (request.action === "execute_node") {
    const nodeId = request.nodeId!;
    if (!isScentMissionNodeExecutable(request.mission, nodeId)) {
      return {
        sessionId,
        assistantMessage: lockedNodeMessage(nodeId, request.mission.nodes[nodeId]),
      };
    }
    const result = await executeNode(nodeId, request.mission, wardrobe, weather, deps);
    return { sessionId, ...result };
  }

  const inferred = inferCalibrationFromMessage(request.userMessage ?? "", request.mission.calibration);
  const missionForChat = inferred.changed
    ? { ...request.mission, calibration: inferred.calibration }
    : request.mission;
  const missionPatch = inferred.changed ? { calibration: inferred.calibration } : undefined;
  const chatContext: ScentMissionChatContext = {
    mission: missionForChat,
    wardrobe,
    weather,
    userMessage: request.userMessage ?? "",
  };

  if (deps.llmChat) {
    try {
      const reply = await deps.llmChat(chatContext);
      const trimmed = reply.trim();
      if (trimmed) {
        return { sessionId, assistantMessage: trimmed, ...(missionPatch ? { missionPatch } : {}) };
      }
    } catch {
      // Fall through to the deterministic reply — local dev and outages stay functional.
    }
  }

  return {
    sessionId,
    assistantMessage: inferred.changed
      ? calibrationUpdatedReply(inferred.calibration)
      : deterministicChatReply(chatContext),
    ...(missionPatch ? { missionPatch } : {}),
  };
}
