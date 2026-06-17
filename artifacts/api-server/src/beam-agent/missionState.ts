import type { BeamMissionState, BeamSessionSlots, BeamSessionState } from "./types.ts";

const EMPTY_STATE: BeamSessionState = { slots: {} };

const MONTHS: Array<[RegExp, string]> = [
  [/\bjan(?:uary)?\.?\b/i, "January"],
  [/\bfeb(?:ruary)?\.?\b/i, "February"],
  [/\bmar(?:ch)?\.?\b/i, "March"],
  [/\bapr(?:il)?\.?\b/i, "April"],
  [/\bmay\b/i, "May"],
  [/\bjun(?:e)?\.?\b/i, "June"],
  [/\bjul(?:y)?\.?\b/i, "July"],
  [/\baug(?:ust)?\.?\b/i, "August"],
  [/\bsep(?:t|tember)?\.?\b/i, "September"],
  [/\boct(?:ober)?\.?\b/i, "October"],
  [/\bnov(?:ember)?\.?\b/i, "November"],
  [/\bdec(?:ember)?\.?\b/i, "December"],
];

const COUNT_WORDS = new Map<string, number>([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
]);

const OCCASIONS: Array<[RegExp, string]> = [
  [/\bdate\s+night\b/i, "date night"],
  [/\bwork(?:\s+meeting|\s+event)?\b/i, "work"],
  [/\bnight\s+out\b/i, "night out"],
  [/\bwedding\b/i, "wedding"],
  [/\bgym\b/i, "gym"],
  [/\bstaying\s+in\b/i, "staying in"],
];

const VIBES = [
  "artsy",
  "bold",
  "quiet",
  "clean",
  "fresh",
  "warm",
  "rich",
  "romantic",
  "professional",
  "casual",
  "playful",
  "moody",
  "minimal",
  "elegant",
  "cozy",
  "beachy",
  "spicy",
  "woody",
  "green",
  "citrus",
];

function cleanCapture(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\b(?:in|on|for|with|and|but|so|then|yet|please|pls)\b.*$/i, "")
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}

function parseMonth(text: string): string | undefined {
  for (const [pattern, month] of MONTHS) {
    if (pattern.test(text)) return month;
  }
  return undefined;
}

function parseDestination(text: string): string | undefined {
  const patterns = [
    /\b(?:trip|travel(?:ing)?|vacation|visit(?:ing)?|heading|going|flying)\s+(?:to|in|for)\s+([A-Za-z][A-Za-z .'-]{1,50})/i,
    /\b(?:destination|city)\s+(?:is|:)\s*([A-Za-z][A-Za-z .'-]{1,50})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const destination = match?.[1] ? cleanCapture(match[1]) : "";
    if (destination && !/^(a|an|the|my|this)$/i.test(destination)) return destination;
  }
  return undefined;
}

function parseOccasion(text: string): string | undefined {
  for (const [pattern, label] of OCCASIONS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

function parseVibe(text: string): string | undefined {
  const found = VIBES.filter((vibe) => new RegExp(`\\b${vibe}\\b`, "i").test(text));
  return found.length > 0 ? found.slice(0, 3).join(", ") : undefined;
}

function parseDirection(text: string): string | undefined {
  if (/\b(?:light|lighter|fresh|airy|bright|citrus|green)\b/i.test(text)) return "lighter/fresh";
  if (/\b(?:warm|warmer|rich|richer|spicy|amber|vanilla|woody|smoky)\b/i.test(text)) return "warmer/richer";
  return undefined;
}

function parseCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const raw = value.toLowerCase();
  const asNumber = /^\d+$/.test(raw) ? Number(raw) : COUNT_WORDS.get(raw);
  if (!Number.isFinite(asNumber)) return undefined;
  const count = Math.floor(asNumber as number);
  return count >= 1 && count <= 5 ? count : undefined;
}

function firstCountFor(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const count = parseCount(match?.[1]);
    if (count !== undefined) return count;
  }
  return undefined;
}

function parseOwnedCount(text: string): number | undefined {
  return firstCountFor(text, [
    /\b(\d+|one|two|three|four|five)\s+(?:fragrances?|scents?|bottles?|ones?)?\s*(?:from|out of)\s+(?:my\s+)?(?:wardrobe|vault|collection)\b/i,
    /\b(\d+|one|two|three|four|five)\s+(?:owned|already-owned|vault|wardrobe)\s+(?:fragrances?|scents?|bottles?|ones?)\b/i,
    /\b(\d+|one|two|three|four|five)\s+(?:fragrances?|scents?|bottles?|ones?)\s+(?:to\s+take|to\s+pack|for\s+(?:the\s+)?trip)\b/i,
  ]);
}

function parseNewCount(text: string): number | undefined {
  return firstCountFor(text, [
    /\b(\d+|one|two|three|four|five)\s+new\s+(?:fragrances?|scents?|bottles?|ones?)\b/i,
    /\b(\d+|one|two|three|four|five)\s+new\b/i,
    /\b(\d+|one|two|three|four|five)\s+(?:fragrances?|scents?|bottles?|ones?)\s+(?:not\s+in|outside)\s+(?:my\s+)?(?:wardrobe|vault|collection)\b/i,
    /\b(\d+|one|two|three|four|five)\s+(?:unowned|to\s+buy|to\s+discover)\s+(?:fragrances?|scents?|bottles?|ones?)\b/i,
  ]);
}

function parseBudget(text: string): string | undefined {
  const match = /\b(?:under|below|max|budget(?:\s+is)?|less than)\s+\$?\s?(\d{2,4})\b/i.exec(text);
  return match?.[1] ? `$${match[1]}` : undefined;
}

export function isDelegationPhrase(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return /\b(?:idk|i\s+don'?t\s+know|you\s+tell\s+me|surprise\s+me|pick\s+for\s+me|choose\s+for\s+me|you\s+decide|your\s+call|dealer'?s\s+choice|whatever\s+you\s+think)\b/i.test(text);
}

function parseMissionPatch(text: string, slots: BeamSessionSlots): BeamMissionState | undefined {
  const ownedCount = parseOwnedCount(text);
  const newCount = parseNewCount(text);
  const travelLike = /\b(?:trip|travel|vacation|visit|flying|pack|packing|take with me|travel kit|kit)\b/i.test(text);
  const kitLike = ownedCount !== undefined || newCount !== undefined || /\b(?:wardrobe|vault|collection)\b.*\bnew\b|\bnew\b.*\b(?:wardrobe|vault|collection)\b/i.test(text);

  if (travelLike || kitLike) {
    return {
      intent: "travel_kit",
      ownedCount,
      newCount,
      destination: slots.destination,
      month: slots.month,
      userDelegatedChoice: isDelegationPhrase(text) || undefined,
    };
  }

  if (/\b(?:recommend|recommendation|what should i wear|pick|choose|match)\b/i.test(text)) {
    return { intent: "recommendation", userDelegatedChoice: isDelegationPhrase(text) || undefined };
  }

  return isDelegationPhrase(text) ? { userDelegatedChoice: true } : undefined;
}

export function emptyBeamSessionState(): BeamSessionState {
  return { slots: {} };
}

export function cloneBeamSessionState(state: BeamSessionState | undefined): BeamSessionState {
  if (!state) return emptyBeamSessionState();
  return {
    slots: { ...state.slots },
    ...(state.mission ? { mission: { ...state.mission } } : {}),
    ...(state.userDelegatedChoice ? { userDelegatedChoice: true } : {}),
  };
}

export function sanitizeBeamSessionState(value: unknown): BeamSessionState {
  if (!value || typeof value !== "object") return emptyBeamSessionState();
  const record = value as Record<string, unknown>;
  const rawSlots = record.slots && typeof record.slots === "object" ? (record.slots as Record<string, unknown>) : {};
  const slots: BeamSessionSlots = {};
  for (const key of ["month", "destination", "occasion", "vibe", "direction", "budget"] as const) {
    const slot = rawSlots[key];
    if (typeof slot === "string" && slot.trim()) slots[key] = slot.trim().slice(0, 120);
  }

  let mission: BeamMissionState | undefined;
  if (record.mission && typeof record.mission === "object") {
    const rawMission = record.mission as Record<string, unknown>;
    mission = {};
    if (rawMission.intent === "travel_kit" || rawMission.intent === "recommendation") mission.intent = rawMission.intent;
    for (const key of ["ownedCount", "newCount"] as const) {
      const count = rawMission[key];
      if (typeof count === "number" && Number.isFinite(count) && count >= 1 && count <= 5) mission[key] = Math.floor(count);
    }
    for (const key of ["destination", "month"] as const) {
      const slot = rawMission[key];
      if (typeof slot === "string" && slot.trim()) mission[key] = slot.trim().slice(0, 120);
    }
    if (rawMission.userDelegatedChoice === true) mission.userDelegatedChoice = true;
    if (Object.keys(mission).length === 0) mission = undefined;
  }

  return {
    slots,
    ...(mission ? { mission } : {}),
    ...(record.userDelegatedChoice === true ? { userDelegatedChoice: true } : {}),
  };
}

export function mergeBeamSessionState(previous: BeamSessionState | undefined, patch: BeamSessionState): BeamSessionState {
  const base = cloneBeamSessionState(previous);
  const slots: BeamSessionSlots = { ...base.slots, ...patch.slots };
  const mission = base.mission || patch.mission ? { ...base.mission, ...patch.mission } : undefined;

  if (mission?.intent === "travel_kit") {
    if (slots.destination) mission.destination = slots.destination;
    if (slots.month) mission.month = slots.month;
  }
  if (patch.userDelegatedChoice) {
    if (mission) mission.userDelegatedChoice = true;
    return { slots, ...(mission ? { mission } : {}), userDelegatedChoice: true };
  }
  if (patch.mission?.userDelegatedChoice) {
    if (mission) mission.userDelegatedChoice = true;
    return { slots, ...(mission ? { mission } : {}), userDelegatedChoice: true };
  }

  return {
    slots,
    ...(mission ? { mission } : {}),
    ...(base.userDelegatedChoice ? { userDelegatedChoice: true } : {}),
  };
}

export function deriveBeamSessionState(previous: BeamSessionState | undefined, userMessage: string): BeamSessionState {
  const text = userMessage.slice(0, 2000);
  const slots: BeamSessionSlots = {};
  const month = parseMonth(text);
  if (month) slots.month = month;
  const destination = parseDestination(text);
  if (destination) slots.destination = destination;
  const occasion = parseOccasion(text);
  if (occasion) slots.occasion = occasion;
  const vibe = parseVibe(text);
  if (vibe) slots.vibe = vibe;
  const direction = parseDirection(text);
  if (direction) slots.direction = direction;
  const budget = parseBudget(text);
  if (budget) slots.budget = budget;

  const patchSlots = { ...cloneBeamSessionState(previous).slots, ...slots };
  const mission = parseMissionPatch(text, patchSlots);
  const patch: BeamSessionState = {
    slots,
    ...(mission ? { mission } : {}),
    ...(isDelegationPhrase(text) ? { userDelegatedChoice: true } : {}),
  };
  return mergeBeamSessionState(previous ?? EMPTY_STATE, patch);
}

export function beamSessionStatePrompt(state: BeamSessionState | undefined): string {
  const safe = sanitizeBeamSessionState(state);
  const known = Object.entries(safe.slots).filter(([, value]) => Boolean(value));
  const mission = safe.mission;
  if (known.length === 0 && !mission && !safe.userDelegatedChoice) return "";

  const lines = [
    "",
    "Structured session state extracted from the user's own messages. Treat it as authoritative unless the user corrects it.",
  ];
  if (known.length > 0) {
    lines.push(`Known so far: ${known.map(([key, value]) => `${key}=${value}`).join("; ")}.`);
  }
  if (mission?.intent) {
    const parts = [`intent=${mission.intent}`];
    if (mission.ownedCount) parts.push(`ownedCount=${mission.ownedCount}`);
    if (mission.newCount) parts.push(`newCount=${mission.newCount}`);
    if (mission.destination) parts.push(`destination=${mission.destination}`);
    if (mission.month) parts.push(`month=${mission.month}`);
    lines.push(`Mission target: ${parts.join("; ")}.`);
  }
  if (safe.userDelegatedChoice || mission?.userDelegatedChoice) {
    lines.push("The user has delegated the choice. Do not ask another preference question; make the best grounded choice now.");
  }
  lines.push(
    "Before asking any clarification, check Known so far. Never ask for a value already listed there.",
  );
  if (mission?.intent === "travel_kit") {
    lines.push(
      "For a travel kit mission, use beam_score_candidates for owned vault picks and beam_search_catalog with excludeOwned=true for new picks. If new picks are recommended, call beam_propose_collection so the app can show add-ready cards for confirmation.",
    );
    if (mission.ownedCount || mission.newCount) {
      lines.push(
        `The final answer must name at least ${mission.ownedCount ?? 0} owned vault pick(s) and ${mission.newCount ?? 0} new unowned pick(s), without duplicates, once enough context or delegation exists.`,
      );
    }
  }
  return `\n\n${lines.join("\n")}`;
}
