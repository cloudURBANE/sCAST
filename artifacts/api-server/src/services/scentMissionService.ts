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
  rankScentMissionRecommendations,
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
 * execution), and returns patches the client applies. This scripted mission
 * service stays intentionally stateless and writes no chat history of its own.
 * (Durable Beam-agent transcripts DO now persist, via the separate
 * `/api/beam-agent` path → `beam_conversations`/`beam_messages`; see
 * services/beamConversationStore.ts and docs/SCENT_MISSION_GUIDE.md.)
 */

const MAX_USER_MESSAGE_LENGTH = 2_000;
const SESSION_ID_RE = /^[0-9a-zA-Z_-]{8,64}$/;

// A6-GAP5: below this combined family-alignment + weather-fit score, even the
// top-ranked bottle is not a real match for the day's conditions, so the client
// shows an honest "nothing fits today" state. Tuned conservatively — a fine day
// keeps a low-confidence pick well above this — so it only fires on genuinely
// poor matches (low confidence + avoid-family hits + poor thermal fit).
const NO_GOOD_PICK_SCORE_FLOOR = 50;

// User-facing step names. These deliberately avoid internal mission-graph
// vocabulary (no "calibration", "node", "environment scan", "resolution") so the
// deterministic fallback reads like a concierge, not a developer console. The
// node ids stay as internal keys.
const NODE_LABELS: Record<ScentMissionNodeId, string> = {
  onboarding: "your setting and mood",
  "wardrobe-sync": "your collection",
  "environment-scan": "today's conditions",
  "resolution-standard": "your match",
  "resolution-premium": "the deeper breakdown",
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

/**
 * Pulls human-readable intent cues straight from the user's own words so the
 * deterministic fallback can REFLECT what they actually asked for instead of
 * collapsing it into a canned mission-status line. Phrases are returned in the
 * user's own framing (never internal node/enum labels); empty when nothing is
 * recognized. This is the degraded path the SPA hits only when the live Beam
 * model is unavailable, so preserving intent here is what keeps that worst case
 * from feeling robotic.
 */
function understoodIntentCues(userMessage: string): string[] {
  const text = userMessage.toLowerCase();
  const cues: string[] = [];
  const add = (phrase: string) => {
    if (!cues.includes(phrase)) cues.push(phrase);
  };

  if (/\b(work|office|meeting|client|presentation)\b/.test(text)) add("the office");
  if (/\b(date|romantic|dinner)\b/.test(text)) add("a date");
  if (/\b(night out|club|bar|party|evening)\b/.test(text)) add("a night out");
  if (/\b(wedding|gala|formal|black tie)\b/.test(text)) add("a formal event");
  if (/\b(gym|workout|training|fitness)\b/.test(text)) add("the gym");

  if (/\b(fresh|clean|crisp|airy|aquatic|citrus)\b/.test(text)) add("something fresh and clean");
  if (/\b(woody|wood|sandalwood|cedar|vetiver)\b/.test(text)) add("a woody direction");
  if (/\b(warm|cozy|amber|vanilla|sweet)\b/.test(text)) add("something warm");
  if (/\b(spicy|spice|oud|smoky|leather)\b/.test(text)) add("something bold");
  if (/\b(green|greener|herbal|aromatic|modern)\b/.test(text)) add("a green, modern feel");

  if (/\b(hot|heat|humid|humidity|tropical)\b/.test(text)) add("hot, humid air");
  if (/\b(cold|cool|winter|chilly)\b/.test(text)) add("cooler weather");
  if (/\b(rain|rainy)\b/.test(text)) add("a rainy day");

  if (/\b(subtle|skin.?close|intimate|quiet)\b/.test(text)) add("a close, subtle trail");
  if (/\b(statement|projects?|beast|loud|bold)\b/.test(text)) add("real projection");

  return cues.slice(0, 3);
}

function joinCues(cues: string[]): string {
  if (cues.length <= 1) return cues[0] ?? "";
  if (cues.length === 2) return `${cues[0]} and ${cues[1]}`;
  return `${cues.slice(0, -1).join(", ")}, and ${cues[cues.length - 1]}`;
}

/**
 * Conversational fallback when no model is configured. It never exposes the
 * internal mission graph ("node", "mission tree", "Execute Analysis") — that
 * jargon both reads as a developer terminal and is actively stripped by the SPA
 * (`safeAssistantText`), which would otherwise replace the whole reply with a
 * generic prompt and discard the user's intent. So this reflects the user's own
 * words back and invites one concrete next detail.
 */
function deterministicChatReply(context: ScentMissionChatContext): string {
  const message = context.userMessage.toLowerCase();
  const { mission, wardrobe, weather } = context;
  const resolved = mission.nodes["resolution-standard"] === "complete";

  const calibration = inferCalibrationFromMessage(context.userMessage, mission.calibration);
  if (calibration.changed) {
    return calibrationUpdatedReply(calibration.calibration);
  }

  // A vault fragrance the user named: describe what it brings, not a status.
  const mentioned = wardrobe.find((item) => message.includes(item.name.toLowerCase()));
  if (mentioned) {
    const traits = [...(mentioned.families ?? []), ...(mentioned.accords ?? [])].slice(0, 6);
    return traits.length > 0
      ? `${mentioned.name}${mentioned.brand ? ` by ${mentioned.brand}` : ""} reads as ${traits.join(", ")} — I weigh those against today's air when I score your collection.`
      : `${mentioned.name} is in your collection, but I don't have much detail on it yet. Open its card to enrich it and I'll score it more sharply.`;
  }

  // Only treat this as a conditions question when the user is actually asking
  // about the weather — not when "hot"/"humid"/"rain" appear as scent context.
  const asksAboutConditions =
    /\b(weather|temperature|uv index|how hot|how cold|how humid|is it (going to )?rain)/.test(message) &&
    /\b(what|whats|how|hows|tell me|right now|today|outside|like|forecast)\b/.test(message);
  if (asksAboutConditions) {
    return `Right now it's ${describeWeather(weather)}. Tell me where you're headed or the vibe you want, and I'll match a fragrance to it.`;
  }

  // Reflect whatever intent we can read straight from their words.
  const cues = understoodIntentCues(context.userMessage);
  if (cues.length > 0) {
    const tail = resolved
      ? "Tap Reveal Match to see what I lined up, or tell me anything else to refine it."
      : "Give me one more detail — the setting or the mood — or just say go and I'll pull picks from your collection.";
    return `Got it — ${joinCues(cues)}. ${tail}`;
  }

  if (resolved) {
    return "Your pick's already lined up — tap Reveal Match for the full breakdown, or ask me anything about it.";
  }

  if (/(recommend|what should i wear|pick|match|best|suggest|something|wear)/.test(message)) {
    return "Happy to pull something from your collection. Tell me the setting and the mood you're after — or just say go and I'll work with what I have.";
  }

  return "Tell me where you're headed and the mood you want, and I'll match a fragrance from your collection to today's air.";
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
    calibration.destination ? calibration.destination.toLowerCase() : null,
    calibration.energy ? `feeling ${calibration.energy.toLowerCase()}` : null,
  ].filter(Boolean);
  if (parts.length === 0) {
    return "Got it. Tell me the setting and the mood you want, and I'll match a fragrance from your collection to today's air.";
  }
  return `Got it — lining this up for ${parts.join(", ")}. Add anything else you want it to do, or just say go and I'll pull picks from your collection.`;
}

function lockedNodeMessage(nodeId: ScentMissionNodeId, status: string): string {
  const label = NODE_LABELS[nodeId];
  if (status === "complete") {
    return `I've already covered ${label} — let's keep going.`;
  }
  return `I need a little more from you before I can get to ${label}. Let's finish this step first.`;
}

/* ------------------------------------------------------------------ */
/* Node execution                                                      */
/* ------------------------------------------------------------------ */

type NodeExecutionResult = Pick<
  ScentMissionResponse,
  | "assistantMessage"
  | "nodeUpdates"
  | "missionPatch"
  | "recommendation"
  | "alternates"
  | "noGoodPick"
  | "research"
  | "premiumLock"
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
            "I still need two things before I can pick: where you're headed and how you want to come across.",
        };
      }
      const next = completeScentMissionNode(mission, "onboarding");
      return {
        assistantMessage: `Got it — ${destination.toLowerCase()}, feeling ${energy.toLowerCase()}. Let me look through your collection.`,
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
            "Your collection's empty, so there's nothing for me to work with yet. Add a few fragrances from search and I'll pick from them.",
          nodeUpdates: diffScentMissionNodes(mission, next),
        };
      }
      const families = topFamilies(wardrobe);
      const next = completeScentMissionNode(mission, "wardrobe-sync");
      return {
        assistantMessage: `I've been through your collection — ${wardrobe.length} fragrance${wardrobe.length === 1 ? "" : "s"}${
          families.length > 0 ? `, leaning ${families.join(" / ")}` : ""
        }. Now let me check today's air.`,
        nodeUpdates: diffScentMissionNodes(mission, next),
      };
    }

    case "environment-scan": {
      const next = completeScentMissionNode(mission, "environment-scan");
      return {
        assistantMessage: `Today's air: ${describeWeather(weather)}. Now I'll line up your match.`,
        nodeUpdates: diffScentMissionNodes(mission, next),
      };
    }

    case "resolution-standard": {
      // A6-GAP3: rank the whole vault so the runners-up can be surfaced, not just
      // the winner. [0] is the pick; the next few are real alternates.
      const ranked = rankScentMissionRecommendations(wardrobe, mission.calibration, weather);
      const recommendation = ranked[0] ?? null;
      if (!recommendation) {
        const next: ScentMissionState = {
          ...mission,
          nodes: { ...mission.nodes, "resolution-standard": "blocked" },
        };
        return {
          assistantMessage:
            "I can't pick a match from an empty collection. Add a few fragrances and I'll choose from them.",
          nodeUpdates: diffScentMissionNodes(mission, next),
        };
      }

      const alternates = ranked.slice(1, 4);

      // A6-GAP5: be honest when even the winner doesn't really fit today, instead
      // of spinning an avoid_today / low-score pick as a confident match.
      const noGoodPick =
        recommendation.engine.wear_window === "avoid_today" ||
        recommendation.score < NO_GOOD_PICK_SCORE_FLOOR;

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
      const assistantMessage = noGoodPick
        ? `Honestly, nothing in your collection is an ideal match for today's conditions. The closest is ${recommendation.name}${
            recommendation.brand ? ` by ${recommendation.brand}` : ""
          }, but you may want something better suited — consider adding a fragrance for this kind of weather.`
        : `Today, reach for ${recommendation.name}${
            recommendation.brand ? ` by ${recommendation.brand}` : ""
          }. ${recommendation.reason}`;
      return {
        assistantMessage,
        nodeUpdates: diffScentMissionNodes(mission, next),
        recommendation,
        ...(alternates.length > 0 ? { alternates } : {}),
        ...(noGoodPick ? { noGoodPick: true } : {}),
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
