import { createHash } from "node:crypto";

export const RUSH_LEVEL_CAPS = { 1: 2, 2: 3, 3: 5 } as const;
export const RUSH_TOTAL_CAP = 10;
export const FRESH_START_DURATION_MS = 30_000;
export const MAX_RUSH_ACTIONS = 256;
export const MAX_RUSH_WALL_TIME_MS = 120_000;
export const RUSH_CLIENT_VERSION = "1.0.0";

export type ScentRushFamily = "fresh" | "woody" | "amber" | "floral" | "gourmand" | "leather";
export type ScentRushScenario = "office" | "date" | "summer" | "winter" | "night-out" | "close-space";

export interface ScentRushManifest {
  fragranceId: string;
  version: number;
  displayName: string;
  family: ScentRushFamily;
  collectibleNotes: Array<{ id: string; label: string; iconKey: string; weight: number }>;
  supportedScenarios: ScentRushScenario[];
  intensity: "soft" | "moderate" | "strong";
  longevity: "light" | "moderate" | "long";
  backgroundTheme: string;
  hazardPool: string[];
  npcReactionPool: string[];
}

export type RushPlanEvent = {
  id: string;
  atMs: number;
  lane: 0 | 1 | 2;
  kind: "orb" | "hazard" | "npc" | "pickup";
  noteId?: string;
  correct?: boolean;
  scenarioCompatible?: boolean;
  hazardType?: "overspray-cloud" | "heat-wave" | "rain-splash";
  pickupType?: "sample-vial" | "atomizer-boost";
};

export type RushEventOutcome = {
  eventId: string;
  outcome: "collected" | "missed" | "hit" | "cleared" | "avoided" | "positive";
  atMs: number;
};

export type RushAction =
  | { type: "lane"; atMs: number; lane: 0 | 1 | 2 }
  | { type: "jump"; atMs: number };

export type RushCompletionInput = {
  durationMs: number;
  score: number;
  collectedOrbIds: string[];
  hazardsHit: number;
  events: RushEventOutcome[];
  actions: RushAction[];
  eventDigest: string;
  clientVersion: string;
};

export type RushCalculatedResult = {
  score: number;
  maximumPossibleScore: number;
  performance: number;
  beamPowerEarned: number;
  collectedOrbIds: string[];
  hazardsHit: number;
};

const DEFAULT_NOTES = ["Citrus", "Cedar", "Amber", "Jasmine"];
const FAMILIES: ScentRushFamily[] = ["fresh", "woody", "amber", "floral", "gourmand", "leather"];

function cleanText(value: unknown, fallback: string, max = 80): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "note";
}

export function normalizeFragranceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, 240);
  return cleaned && /^[a-zA-Z0-9._~:@/+-]+$/.test(cleaned) ? cleaned : null;
}

export function createScentRushManifest(input: {
  fragranceId: string;
  displayName?: unknown;
  family?: unknown;
  notes?: unknown;
}): ScentRushManifest {
  const familyText = typeof input.family === "string" ? input.family.toLowerCase() : "";
  const family = FAMILIES.find((candidate) => familyText.includes(candidate)) ?? "fresh";
  const rawNotes = Array.isArray(input.notes) ? input.notes : [];
  const labels = [...rawNotes, ...DEFAULT_NOTES]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => cleanText(value, "Note", 40))
    .filter((value, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index)
    .slice(0, 4);
  const seen = new Map<string, number>();
  const collectibleNotes = labels.map((label, index) => {
    const base = slug(label);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { id: count ? `${base}-${count + 1}` : base, label, iconKey: `note-${index + 1}`, weight: 1 };
  });

  return {
    fragranceId: input.fragranceId,
    version: 1,
    displayName: cleanText(input.displayName, "Featured fragrance", 120),
    family,
    collectibleNotes,
    supportedScenarios: family === "fresh" ? ["office", "summer", "close-space"] : ["date", "night-out", "winter"],
    intensity: family === "amber" || family === "leather" ? "strong" : "moderate",
    longevity: "moderate",
    backgroundTheme: "midnight-city",
    hazardPool: ["overspray-cloud", "heat-wave", "rain-splash"],
    npcReactionPool: ["The elevator crowd thinks this one is loud.", "Date-night crowd approves.", "Weather mismatch."],
  };
}

function randomFromSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateFreshStartPlan(seed: number, manifest: ScentRushManifest): RushPlanEvent[] {
  const random = randomFromSeed(seed);
  const events: RushPlanEvent[] = [];
  let orbIndex = 0;
  let hazardIndex = 0;
  for (let index = 0; index < 24; index += 1) {
    const atMs = 2_000 + index * 1_080;
    const lane = Math.floor(random() * 3) as 0 | 1 | 2;
    if ([4, 8, 12, 16, 20].includes(index)) {
      const hazardType = manifest.hazardPool[hazardIndex++ % manifest.hazardPool.length] as RushPlanEvent["hazardType"];
      events.push({ id: `hazard-${index}`, atMs, lane, kind: "hazard", hazardType });
    } else if (index === 7 || index === 18) {
      events.push({ id: `pickup-${index}`, atMs, lane, kind: "pickup", pickupType: index === 7 ? "sample-vial" : "atomizer-boost" });
    } else if (index === 10 || index === 22) {
      events.push({ id: `npc-${index}`, atMs, lane, kind: "npc" });
    } else {
      const note = manifest.collectibleNotes[orbIndex++ % manifest.collectibleNotes.length]!;
      events.push({
        id: `orb-${index}-${note.id}`,
        atMs,
        lane,
        kind: "orb",
        noteId: note.id,
        correct: index % 9 !== 6,
        scenarioCompatible: index % 3 === 0,
      });
    }
  }
  return events;
}

function allowedOutcome(event: RushPlanEvent, outcome: RushEventOutcome["outcome"]): boolean {
  if (event.kind === "orb" || event.kind === "pickup") return outcome === "collected" || outcome === "missed";
  if (event.kind === "hazard") return outcome === "hit" || outcome === "cleared" || outcome === "avoided";
  return outcome === "positive" || outcome === "missed";
}

export function eventDigest(events: RushEventOutcome[]): string {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex");
}

export function deriveRushOutcomes(plan: RushPlanEvent[], actions: RushAction[]): RushEventOutcome[] {
  let lane: 0 | 1 | 2 = 1;
  let actionIndex = 0;
  let lastJumpAt = Number.NEGATIVE_INFINITY;
  let beam = 0;
  let shielded = false;
  let boostUntil = 0;

  return plan.map((event) => {
    while (actionIndex < actions.length && actions[actionIndex]!.atMs <= event.atMs) {
      const action = actions[actionIndex++]!;
      if (action.type === "lane") lane = action.lane;
      else lastJumpAt = action.atMs;
    }

    const sameLane = event.lane === lane;
    let outcome: RushEventOutcome["outcome"] = "missed";
    if (event.kind === "orb") {
      if (sameLane) {
        outcome = "collected";
        if (event.correct) beam = Math.min(100, beam + (event.atMs < boostUntil ? 45 : 30));
      }
    } else if (event.kind === "hazard") {
      const occupiesLane = event.hazardType === "heat-wave"
        || (event.hazardType === "overspray-cloud" ? Math.abs(event.lane - lane) <= 1 : sameLane);
      if (!occupiesLane) outcome = "avoided";
      else if (beam >= 100) {
        outcome = "cleared";
        beam = 0;
      } else if (event.hazardType !== "overspray-cloud" && lastJumpAt + 650 >= event.atMs) {
        outcome = "avoided";
      } else if (shielded) {
        outcome = "avoided";
        shielded = false;
      } else {
        outcome = "hit";
        if (event.hazardType === "rain-splash") beam = Math.max(0, beam - 40);
      }
    } else if (event.kind === "pickup") {
      if (sameLane) {
        outcome = "collected";
        if (event.pickupType === "sample-vial") shielded = true;
        else boostUntil = event.atMs + 5_000;
      }
    } else if (sameLane) outcome = "positive";

    return { eventId: event.id, outcome, atMs: event.atMs };
  });
}

function validateActions(actions: RushAction[]): void {
  if (!Array.isArray(actions) || actions.length > MAX_RUSH_ACTIONS) throw new Error("invalid_actions");
  let previousAt = 0;
  for (const action of actions) {
    if (!action || (action.type !== "lane" && action.type !== "jump")) throw new Error("invalid_actions");
    if (!Number.isFinite(action.atMs) || action.atMs < previousAt || action.atMs < 0 || action.atMs > FRESH_START_DURATION_MS) {
      throw new Error("invalid_action_timing");
    }
    if (action.type === "lane" && action.lane !== 0 && action.lane !== 1 && action.lane !== 2) throw new Error("invalid_actions");
    previousAt = action.atMs;
  }
}

export function calculateRushScore(plan: RushPlanEvent[], outcomes: RushEventOutcome[]): RushCalculatedResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.eventId, outcome]));
  let score = 0;
  let combo = 0;
  let maximumPossibleScore = 0;
  let maximumCombo = 0;
  let hazardsHit = 0;
  const collectedOrbIds: string[] = [];

  for (const event of plan) {
    const outcome = byId.get(event.id);
    if (event.kind === "orb") {
      if (event.correct) {
        maximumCombo += 1;
        maximumPossibleScore += 100 + (event.scenarioCompatible ? 150 : 0) + Math.min(100, Math.max(0, maximumCombo - 1) * 25);
      } else {
        maximumCombo = 0;
      }
      if (outcome?.outcome === "collected") {
        collectedOrbIds.push(event.id);
        if (event.correct) {
          combo += 1;
          score += 100 + (event.scenarioCompatible ? 150 : 0) + Math.min(100, Math.max(0, combo - 1) * 25);
        } else {
          combo = 0;
        }
      }
    } else if (event.kind === "hazard") {
      maximumPossibleScore += 75;
      if (outcome?.outcome === "hit") {
        hazardsHit += 1;
        score -= 125;
        combo = 0;
      } else if (outcome?.outcome === "cleared") {
        score += 75;
      }
    } else if (event.kind === "npc") {
      maximumPossibleScore += 100;
      if (outcome?.outcome === "positive") score += 100;
    }
  }

  score = Math.max(0, score);
  const performance = maximumPossibleScore > 0 ? Math.min(1, score / maximumPossibleScore) : 0;
  return {
    score,
    maximumPossibleScore,
    performance,
    beamPowerEarned: performance >= 0.75 ? 2 : performance >= 0.45 ? 1 : 0,
    collectedOrbIds,
    hazardsHit,
  };
}

export function validateCompletion(
  plan: RushPlanEvent[],
  input: RushCompletionInput,
  options: { serverElapsedMs?: number } = {},
): RushCalculatedResult {
  if (input.clientVersion !== RUSH_CLIENT_VERSION) throw new Error("unsupported_client_version");
  if (input.durationMs !== FRESH_START_DURATION_MS) throw new Error("implausible_duration");
  if (options.serverElapsedMs !== undefined
    && (!Number.isFinite(options.serverElapsedMs) || options.serverElapsedMs < 25_000 || options.serverElapsedMs > MAX_RUSH_WALL_TIME_MS)) {
    throw new Error("implausible_server_duration");
  }
  validateActions(input.actions);
  if (!Array.isArray(input.events) || input.events.length !== plan.length) throw new Error("invalid_event_count");
  const planById = new Map(plan.map((event) => [event.id, event]));
  const seen = new Set<string>();
  for (const outcome of input.events) {
    const event = planById.get(outcome.eventId);
    if (!event || seen.has(outcome.eventId)) throw new Error("unknown_or_duplicate_event");
    if (!allowedOutcome(event, outcome.outcome)) throw new Error("invalid_event_outcome");
    if (!Number.isFinite(outcome.atMs) || Math.abs(outcome.atMs - event.atMs) > 2_000) throw new Error("implausible_event_timing");
    seen.add(outcome.eventId);
  }
  if (!/^[a-f0-9]{64}$/.test(input.eventDigest) || eventDigest(input.events) !== input.eventDigest) throw new Error("invalid_event_digest");
  const expectedEvents = deriveRushOutcomes(plan, input.actions);
  if (JSON.stringify(input.events) !== JSON.stringify(expectedEvents)) throw new Error("invalid_event_outcomes");
  const calculated = calculateRushScore(plan, expectedEvents);
  if (input.score !== calculated.score) throw new Error("impossible_score");
  if (input.hazardsHit !== calculated.hazardsHit) throw new Error("invalid_hazard_summary");
  if (JSON.stringify(input.collectedOrbIds) !== JSON.stringify(calculated.collectedOrbIds)) throw new Error("invalid_orb_summary");
  if (calculated.beamPowerEarned > RUSH_LEVEL_CAPS[1]) throw new Error("level_cap_exceeded");
  return calculated;
}

export function assertRunRedeemable(run: {
  userId: string;
  fragranceId: string;
  expiresAt: Date;
  completedAt: Date | null;
}, expected: { userId: string; fragranceId: string; now?: Date }): "new" | "completed" {
  if (run.userId !== expected.userId) throw new Error("wrong_user");
  if (run.fragranceId !== expected.fragranceId) throw new Error("wrong_fragrance");
  if (run.completedAt) return "completed";
  if (run.expiresAt.getTime() < (expected.now ?? new Date()).getTime()) throw new Error("expired_run");
  return "new";
}

export function cappedTotalBeamPower(levelRewards: number[]): number {
  return Math.min(RUSH_TOTAL_CAP, levelRewards.reduce((sum, reward, index) => {
    const cap = RUSH_LEVEL_CAPS[(index + 1) as keyof typeof RUSH_LEVEL_CAPS] ?? 0;
    return sum + Math.max(0, Math.min(cap, reward));
  }, 0));
}

export function buildRushProgressSummary(
  aggregate: { supporters?: number | string | null; totalBeamPower?: number | string | null } | undefined,
  userRows: Array<{ level: number; bestScore: number; bestPerformance: number; beamPower: number }>,
) {
  const levelRewards = [1, 2, 3].map((level) => userRows.find((row) => row.level === level)?.beamPower ?? 0);
  const fresh = userRows.find((row) => row.level === 1);
  return {
    beamSupporters: Number(aggregate?.supporters ?? 0),
    totalBeamPower: Number(aggregate?.totalBeamPower ?? 0),
    user: {
      freshStartBeamPower: fresh?.beamPower ?? 0,
      freshStartBestScore: fresh?.bestScore ?? 0,
      freshStartBestPerformance: fresh?.bestPerformance ?? 0,
      totalBeamPower: cappedTotalBeamPower(levelRewards),
      maximumBeamPower: RUSH_TOTAL_CAP,
    },
  };
}

export function applyBestProgress(
  previous: { bestScore: number; bestPerformance: number; beamPower: number } | null,
  result: Pick<RushCalculatedResult, "score" | "performance" | "beamPowerEarned">,
  level: keyof typeof RUSH_LEVEL_CAPS = 1,
) {
  return {
    bestScore: Math.max(previous?.bestScore ?? 0, result.score),
    bestPerformance: Math.max(previous?.bestPerformance ?? 0, result.performance),
    beamPower: Math.min(RUSH_LEVEL_CAPS[level], Math.max(previous?.beamPower ?? 0, result.beamPowerEarned)),
  };
}
