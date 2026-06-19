import type { BeamMissionState, BeamSessionSlots, BeamSessionState, BeamSlotKey } from "./types.ts";

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
  ["couple", 2],
  ["a couple", 2],
  ["pair", 2],
]);

const COUNT_CAPTURE = String.raw`((?:a\s+)?couple|pair|\d+|one|two|three|four|five)`;

// Order matters: parseOccasion returns the FIRST match, so list the more
// specific multi-word phrases ("first date", "dinner party") before the broader
// single words they contain. The original set only knew date-night/work/night-out/
// wedding/gym/staying-in, so common occasions ("party", "dinner", "interview",
// "brunch", "funeral", "graduation", "first date") were never captured and the
// agent re-asked an occasion the user had already given — the felt over-asking.
const OCCASIONS: Array<[RegExp, string]> = [
  [/\bfirst\s+date\b/i, "first date"],
  [/\bdate\s+night\b/i, "date night"],
  [/\b(?:job\s+)?interview\b/i, "interview"],
  [/\bwork(?:\s+meeting|\s+event)?\b/i, "work"],
  [/\bnight\s+out\b/i, "night out"],
  [/\bwedding\b/i, "wedding"],
  [/\bgraduation\b/i, "graduation"],
  [/\bfuneral\b/i, "funeral"],
  [/\bformal\s+(?:event|occasion)\b/i, "formal event"],
  [/\bbrunch\b/i, "brunch"],
  [/\bdinner(?:\s+party)?\b/i, "dinner"],
  [/\bparty\b/i, "party"],
  [/\bgym\b/i, "gym"],
  [/\bstaying\s+in\b/i, "staying in"],
];

const VIBES = [
  "artsy",
  "bold",
  "quiet",
  "romantic",
  "professional",
  "casual",
  "playful",
  "moody",
  "minimal",
  "elegant",
  "cozy",
  "beachy",
  "modern",
];

const SLOT_KEYS: BeamSlotKey[] = [
  "month",
  "destination",
  "occasion",
  "vibe",
  "direction",
  "projection",
  "impression",
  "budget",
];

/**
 * Slots that answer the SAME calibration need worded two ways. "vibe" (a mood:
 * artsy, bold, quiet) and "direction" (a scent family: citrus, woody, green) are
 * interchangeable — if the agent asked for one and the user replied with the
 * other, the question IS answered. Without this, asking "what vibe?" then getting
 * "citrusy" left the vibe slot pending forever, so the agent re-asked and the
 * deterministic gate scored a sensible re-ask as abandonment. The answer-quality
 * gate mirrors this same pairing (answerQualityGates.abandonsPendingSlot). Every
 * other slot only satisfies itself.
 */
const COMPATIBLE_SLOTS: Partial<Record<BeamSlotKey, BeamSlotKey[]>> = {
  vibe: ["direction"],
  direction: ["vibe"],
};

/**
 * Did `slots` answer `pendingSlot` — either directly, or via a compatible slot
 * (vibe⇄direction)? Used to decide whether the pending question is still open.
 */
export function pendingSlotSatisfiedBy(pendingSlot: BeamSlotKey, slots: BeamSessionSlots): boolean {
  if (slots[pendingSlot]) return true;
  for (const alt of COMPATIBLE_SLOTS[pendingSlot] ?? []) {
    if (slots[alt]) return true;
  }
  return false;
}

function cleanCapture(value: string): string {
  return value
    .replace(/\s+/g, " ")
    // Sentence boundary: a period+space after a 3+ letter word ends the capture, so
    // "tokyo. You pick the direction" cuts to "tokyo". Real abbreviations ("St.",
    // "Mt.", "Ft.", "D.C.") keep a ≤2-letter token before the dot and survive.
    .replace(/([A-Za-z]{3,})\.\s+.*$/s, "$1")
    .replace(/\b(?:in|on|for|with|and|but|so|then|yet|next|this|tonight|today|tomorrow|please|pls)\b.*$/i, "")
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}

function parseMonth(text: string): string | undefined {
  const matches = MONTHS.flatMap(([pattern, month]) => {
    const match = pattern.exec(text);
    if (!match || match.index === undefined) return [];
    const prefix = text.slice(Math.max(0, match.index - 12), match.index);
    // Corrections such as "September, not August" must not reinstate the
    // rejected month merely because August appears first in MONTHS.
    if (/\b(?:not|no)\s*$/i.test(prefix)) return [];
    return [{ month, index: match.index }];
  }).sort((a, b) => a.index - b.index);

  const distinct = [...new Set(matches.map(({ month }) => month))];
  // "August or September" is an unresolved choice, not authoritative state.
  return distinct.length === 1 ? distinct[0] : undefined;
}

function parseDestination(text: string): string | undefined {
  const patterns = [
    /\b(?:party|dinner|brunch|interview|date|graduation|funeral|event|meeting)\s+in\s+([A-Za-z][A-Za-z .'-]{1,50})/i,
    /\b(?:trip|travel(?:ing)?|vacation|visit(?:ing)?|heading|going|flying)\s+(?:to|in|for)\s+([A-Za-z][A-Za-z .'-]{1,50})/i,
    // Prepositive places are ambiguous ("business trip", "road trip"). Accept
    // proper-noun phrasing such as "Tokyo trip" rather than storing false state.
    /\b(?:planning|taking|booking)\s+(?:a\s+)?([A-Z][A-Za-z .'-]{1,40}?)\s+trip\b/,
    /\b(?:destination|city)\s+(?:is|:)\s*([A-Za-z][A-Za-z .'-]{1,50})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const destination = match?.[1] ? cleanCapture(match[1]) : "";
    const isMonth = MONTHS.some(([monthPattern]) => monthPattern.test(destination));
    const isOccasion = OCCASIONS.some(([occasionPattern]) => occasionPattern.test(destination));
    const isRelativeTime = /^(?:(?:a|an|the|this|next|last|one|two|three|four|five)\s+)?(?:morning|afternoon|evening|night|weekend|day|week|month|year)s?$/i.test(destination);
    if (destination && !isMonth && !isOccasion && !isRelativeTime && !/^(a|an|the|my|this)$/i.test(destination)) return destination;
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

/**
 * Scent-family patterns. Order matters — it fixes the printed direction string
 * ("citrus, green") so keep citrus → green → aromatic first. Each base tolerates
 * a trailing "y"/"sy" so the user's adjective form is captured too: the original
 * `\bcitrus\b` silently missed "citrusy" (the trailing letter breaks the word
 * boundary), which left the direction slot empty and let the agent keep asking a
 * "fresh-green vs warm-spicy" follow-up the gates never caught.
 */
const FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/\bcitrus(?:y)?\b/i, "citrus"],
  [/\bgreen\b/i, "green"],
  [/\b(?:tea|matcha|chai)\b/i, "tea"],
  [/\baromatic\b/i, "aromatic"],
  [/\bwarm(?:er|th)?\b/i, "warm"],
  [/\bwood(?:y|s|sy)?\b/i, "woody"],
  [/\bfloral\b/i, "floral"],
  [/\bfruit(?:y)?\b/i, "fruity"],
  [/\bspic(?:y|e)\b/i, "spicy"],
  [/\bsweet\b/i, "sweet"],
  [/\bgourmand\b/i, "gourmand"],
  [/\b(?:aquatic|marine|ozonic)\b/i, "aquatic"],
  [/\bpowder(?:y)?\b/i, "powdery"],
  [/\bleather(?:y)?\b/i, "leather"],
  [/\boud\b/i, "oud"],
  [/\bamber(?:y)?\b/i, "amber"],
  [/\bvanilla\b/i, "vanilla"],
  [/\bfoug[eè]re\b/i, "fougère"],
  [/\bchypre\b/i, "chypre"],
  [/\bmoss(?:y)?\b/i, "mossy"],
  [/\bsmok(?:y|e)\b/i, "smoky"],
  [/\bmusk(?:y)?\b/i, "musk"],
];

function parseDirection(text: string): string | undefined {
  const found: string[] = [];
  for (const [pattern, label] of FAMILY_PATTERNS) {
    if (pattern.test(text) && !found.includes(label)) found.push(label);
  }
  const alreadyFreshFamily = found.some((label) => ["citrus", "green", "tea", "aromatic", "aquatic"].includes(label));
  if (/\b(?:light|lighter|fresh|airy|bright|clean|crisp)\b/i.test(text) && !alreadyFreshFamily) {
    found.unshift("lighter/fresh");
  }
  if (found.length > 0) return found.slice(0, 3).join(", ");
  if (/\b(?:warm|warmer|rich|richer|cozy|deep)\b/i.test(text)) return "warmer/richer";
  return undefined;
}

function parseProjection(text: string): string | undefined {
  if (/\b(?:skin[ -]?close|close to (?:the )?skin|intimate|subtle projection|very quiet)\b/i.test(text)) return "skin-close";
  if (/\b(?:moderate (?:trail|projection)|office[- ]safe projection|not too loud|restrained|controlled projection)\b/i.test(text)) return "moderate";
  if (/\b(?:statement projection|strong projection|project(?:ion)?|beast mode)\b/i.test(text)) return "statement";
  return undefined;
}

function parseImpression(text: string): string | undefined {
  const found = ["calm", "focused", "confident", "social", "attractive", "approachable", "polished"].filter((value) =>
    new RegExp(`\\b${value}\\b`, "i").test(text),
  );
  return found.length > 0 ? found.join(", ") : undefined;
}

/** Determine the one category an assistant question is asking the user to fill. */
export function inferPendingSlotFromAssistant(text: string): BeamSlotKey | undefined {
  if (!text.includes("?")) return undefined;
  if (/\b(?:citrus|green|tea|aromatic|scent famil(?:y|ies)|scent direction|direction|lean more|lighter|warmer)\b|\bfresh\b.{0,60}\bwarm(?:th)?\b|\bwarm(?:th)?\b.{0,60}\bfresh\b/i.test(text)) return "direction";
  if (/\b(?:projection|trail|skin[ -]?close|statement)\b/i.test(text)) return "projection";
  if (/\b(?:occasion|setting|work|date night|first date|night out|staying in|party|dinner|interview|brunch|funeral|formal event|graduation|wedding|gym)\b/i.test(text)) return "occasion";
  if (/\b(?:impression|come across|calm|focused|confident|social)\b/i.test(text)) return "impression";
  if (/\b(?:vibe|mood|style|feel)\b/i.test(text)) return "vibe";
  if (/\b(?:budget|spend|price range)\b/i.test(text)) return "budget";
  if (/\b(?:which|what) month|\bwhen\b|time of year|season\b/i.test(text)) return "month";
  if (/\b(?:where|destination|which city)\b/i.test(text)) return "destination";
  return undefined;
}

function parseCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const raw = value.toLowerCase().replace(/\s+/g, " ").trim();
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
    new RegExp(String.raw`\b${COUNT_CAPTURE}\s+(?:of\s+)?(?:fragrances?|scents?|bottles?|ones?)?\s*(?:from|out of)\s+(?:my\s+)?(?:wardrobe|vault|collection)\b`, "i"),
    new RegExp(String.raw`\b${COUNT_CAPTURE}\s+(?:of\s+)?(?:owned|already-owned|vault|wardrobe)\s+(?:fragrances?|scents?|bottles?|ones?)\b`, "i"),
    // Noun optional so "two to take" / "two to pack" / "two to bring" (no explicit
    // "fragrances") still reads as an owned-lane count, matching the "from my wardrobe" pattern.
    new RegExp(String.raw`\b${COUNT_CAPTURE}\s+(?:of\s+)?(?:(?:fragrances?|scents?|bottles?|ones?)\s+)?(?:to\s+(?:take|pack|bring|wear)|for\s+(?:the\s+)?trip)\b`, "i"),
  ]);
}

function parseNewCount(text: string): number | undefined {
  return firstCountFor(text, [
    new RegExp(String.raw`\b${COUNT_CAPTURE}\s+(?:of\s+)?new\s+(?:fragrances?|scents?|bottles?|ones?)\b`, "i"),
    new RegExp(String.raw`\b${COUNT_CAPTURE}\s+(?:of\s+)?new\b`, "i"),
    new RegExp(String.raw`\b${COUNT_CAPTURE}\s+(?:of\s+)?(?:fragrances?|scents?|bottles?|ones?)\s+(?:not\s+in|outside)\s+(?:my\s+)?(?:wardrobe|vault|collection)\b`, "i"),
    new RegExp(String.raw`\b${COUNT_CAPTURE}\s+(?:of\s+)?(?:unowned|to\s+buy|to\s+discover)\s+(?:fragrances?|scents?|bottles?|ones?)\b`, "i"),
  ]);
}

function parseBudget(text: string): string | undefined {
  const match = /\b(?:under|below|max|budget(?:\s+is)?|less than)\s+\$?\s?(\d{2,4})\b/i.exec(text);
  return match?.[1] ? `$${match[1]}` : undefined;
}

export function isDelegationPhrase(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return /\b(?:idk|i\s+don'?t\s+know|you\s+tell\s+me|surprise\s+me|pick\s+for\s+me|choose\s+for\s+me|you\s+decide|your\s+call|dealer'?s\s+choice|whatever\s+you\s+think|recommend\s+now|just\s+(?:pick|choose|recommend|decide)|go\s+ahead|make\s+the\s+call|up\s+to\s+you|with\s+what\s+you\s+(?:know|have)|doesn'?t\s+matter)\b/i.test(text);
}

function parseMissionPatch(text: string, slots: BeamSessionSlots): BeamMissionState | undefined {
  const ownedCount = parseOwnedCount(text);
  const newCount = parseNewCount(text);
  const travelLike = /\b(?:trip|travel|vacation|visit|flying|pack|packing|bring|bringing|take with me|travel kit|kit)\b/i.test(text);
  // A kit is a multi-lane / travel deliverable: a requested NEW (discovery) lane, an
  // explicit wardrobe+new pairing, or travel/kit phrasing (travelLike). A LONE owned
  // count with no new lane and no travel/kit word is a plain recommendation, not a kit
  // — e.g. "recommend one fragrance from my vault for work" must stay a recommendation
  // so it uses the cheap lane and skips the travel-kit fulfillment gates. (Live QA
  // found that request misrouted to the premium lane + travel-kit gates because a lone
  // owned count alone flipped the intent.) Owned-only TRAVEL requests still parse as a
  // kit via travelLike (they carry "trip"/"pack"/"bring"/"take with me"/"kit").
  const kitLike =
    newCount !== undefined ||
    /\b(?:wardrobe|vault|collection)\b.*\bnew\b|\bnew\b.*\b(?:wardrobe|vault|collection)\b/i.test(text);

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
    ...(state.pendingSlot ? { pendingSlot: state.pendingSlot } : {}),
    ...(state.pendingSlotUnanswered ? { pendingSlotUnanswered: true } : {}),
  };
}

export function sanitizeBeamSessionState(value: unknown): BeamSessionState {
  if (!value || typeof value !== "object") return emptyBeamSessionState();
  const record = value as Record<string, unknown>;
  const rawSlots = record.slots && typeof record.slots === "object" ? (record.slots as Record<string, unknown>) : {};
  const slots: BeamSessionSlots = {};
  for (const key of SLOT_KEYS) {
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
    if (rawMission.kitPresented === true) mission.kitPresented = true;
    if (Object.keys(mission).length === 0) mission = undefined;
  }

  return {
    slots,
    ...(mission ? { mission } : {}),
    ...(record.userDelegatedChoice === true ? { userDelegatedChoice: true } : {}),
    ...(typeof record.pendingSlot === "string" && SLOT_KEYS.includes(record.pendingSlot as BeamSlotKey)
      ? { pendingSlot: record.pendingSlot as BeamSlotKey }
      : {}),
    ...(record.pendingSlotUnanswered === true ? { pendingSlotUnanswered: true } : {}),
  };
}

function splitSlotList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function mergeSlotList(previous: string | undefined, next: string | undefined, limit = 5): string | undefined {
  const merged: string[] = [];
  for (const value of [...splitSlotList(previous), ...splitSlotList(next)]) {
    if (!merged.some((item) => item.toLowerCase() === value.toLowerCase())) merged.push(value);
    if (merged.length >= limit) break;
  }
  return merged.length > 0 ? merged.join(", ") : undefined;
}

function mergeSlots(previous: BeamSessionSlots, patch: BeamSessionSlots): BeamSessionSlots {
  const slots: BeamSessionSlots = { ...previous };
  for (const key of SLOT_KEYS) {
    const next = patch[key];
    if (!next) continue;
    slots[key] = key === "direction" && slots.direction
      ? mergeSlotList(slots.direction, next)
      : next;
  }
  return slots;
}

export function mergeBeamSessionState(previous: BeamSessionState | undefined, patch: BeamSessionState): BeamSessionState {
  const base = cloneBeamSessionState(previous);
  const slots: BeamSessionSlots = mergeSlots(base.slots, patch.slots);
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
    ...(patch.pendingSlot ? { pendingSlot: patch.pendingSlot } : {}),
    ...(patch.pendingSlotUnanswered ? { pendingSlotUnanswered: true } : {}),
  };
}

export function deriveBeamSessionState(
  previous: BeamSessionState | undefined,
  userMessage: string,
  pendingSlot?: BeamSlotKey,
): BeamSessionState {
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
  const projection = parseProjection(text);
  if (projection) slots.projection = projection;
  const impression = parseImpression(text);
  if (impression) slots.impression = impression;
  const budget = parseBudget(text);
  if (budget) slots.budget = budget;

  // The deterministic recovery prompt offers categorical chips that are valid
  // answers even though they do not use the free-text parser's usual syntax.
  // Resolve them only when that exact slot is pending, so words such as "warm"
  // do not leak into the scent-direction slot when the user chose a destination.
  const concise = text.trim().replace(/[.!?]+$/g, "");
  if (pendingSlot === "destination") {
    if (/^somewhere\s+warm$/i.test(concise)) {
      slots.destination = "Somewhere warm";
      delete slots.direction;
    } else if (
      Object.keys(slots).length === 0 &&
      /^[A-Za-z][A-Za-z .'-]{1,50}$/.test(concise) &&
      !/^(?:i don'?t know|not sure|anywhere|wherever)$/i.test(concise)
    ) {
      slots.destination = concise;
    }
  }
  if (pendingSlot === "month" && !slots.month) {
    const season = /^(?:this\s+)?(spring|summer|autumn|fall|winter)$/i.exec(concise)?.[1];
    if (season) slots.month = season.toLowerCase() === "fall" ? "Autumn" : season[0].toUpperCase() + season.slice(1).toLowerCase();
  }
  if (pendingSlot === "budget" && !slots.budget) {
    const qualitativeBudget = /^(budget-friendly|mid-range|premium|no limit)$/i.exec(concise)?.[1];
    if (qualitativeBudget) slots.budget = qualitativeBudget[0].toUpperCase() + qualitativeBudget.slice(1).toLowerCase();
  }

  const parsedAgainstPrevious = { ...cloneBeamSessionState(previous).slots, ...slots };
  const preliminaryMission = parseMissionPatch(text, parsedAgainstPrevious);
  const explicitMissionBoundary =
    /^\s*(?:now\b|next\b|another\b|separately\b|for\s+(?:another|a\s+new)\b|new\s+(?:trip|mission)\b)/i.test(text);
  // A follow-up to an already-PRESENTED travel kit is a REFINEMENT, not a new
  // mission — even when a generic verb ("swap the Aventus pick", "match the look")
  // makes this turn parse as a bare recommendation. Without this, that verb flips
  // the intent, trips startsNewMission, and wipes the kit's destination/timing/
  // counts, so the agent both loses context and re-gathers slots. An explicit
  // boundary phrase ("now…", "new trip…") still starts a fresh mission.
  const refiningPresentedKit =
    previous?.mission?.intent === "travel_kit" &&
    previous.mission.kitPresented === true &&
    !explicitMissionBoundary;
  const startsNewMission = Boolean(
    preliminaryMission?.intent &&
    previous &&
    !refiningPresentedKit &&
    (
      (previous.mission?.intent && previous.mission.intent !== preliminaryMission.intent) ||
      explicitMissionBoundary
    )
  );
  // Explicit mission boundaries must not inherit a prior trip's destination,
  // month, scent direction, budget, or delegation flag.
  const baseState = startsNewMission ? EMPTY_STATE : previous ?? EMPTY_STATE;
  const patchSlots = { ...cloneBeamSessionState(baseState).slots, ...slots };
  let mission = parseMissionPatch(text, patchSlots);
  // Don't let a generic-verb recommendation patch downgrade a preserved, already-
  // presented travel kit: the kit's intent/counts/destination must survive a swap-
  // style refinement. A real new-kit patch (it parses as travel_kit, e.g. "make it
  // 3 new") still merges and updates the counts.
  if (refiningPresentedKit && mission?.intent === "recommendation") mission = undefined;
  const patch: BeamSessionState = {
    slots,
    ...(mission ? { mission } : {}),
    ...(isDelegationPhrase(text) ? { userDelegatedChoice: true } : {}),
    // Check satisfaction against the MERGED slots, not just this turn's parse — a
    // slot captured on a PRIOR turn is already answered, so re-marking it pending
    // would make the agent (and the deterministic safe re-ask) ask a known value.
    ...(pendingSlot && !pendingSlotSatisfiedBy(pendingSlot, patchSlots) && !isDelegationPhrase(text)
      ? { pendingSlot, pendingSlotUnanswered: true }
      : {}),
  };
  return mergeBeamSessionState(baseState, patch);
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
  if (safe.pendingSlot && safe.pendingSlotUnanswered) {
    lines.push(
      `The active question is still unresolved: expected ${safe.pendingSlot}. The user's latest message belongs to another category. Acknowledge any useful new context, do not treat it as the ${safe.pendingSlot} answer, and briefly re-ask the same ${safe.pendingSlot} question with choices from that category only.`,
    );
  }
  lines.push(
    "Before asking any clarification, check Known so far. Never ask for a value already listed there.",
  );
  if (mission?.intent === "travel_kit") {
    if ((mission.ownedCount ?? 0) > 0) {
      lines.push(
        "For this travel kit, use beam_score_candidates only for the requested owned vault picks, use beam_search_catalog with excludeOwned=true for new picks, then call beam_present_travel_kit with both lanes.",
      );
    } else {
      lines.push(
        "This is a NEW-ONLY discovery mission. Do not recommend or score an owned vault bottle. Use the vault only as a taste reference, search with excludeOwned=true, check each new pick's vault overlap, and call beam_present_travel_kit with an empty owned lane. For each new pick, explain its destination/timing fit, direction fit, and how it differs from the vault. Any owned bottle mentioned in prose must appear only in a separate, explicit taste-reference label.",
      );
    }
    if (mission.ownedCount || mission.newCount) {
      lines.push(
        `The final answer and travel-kit card must contain exactly ${mission.ownedCount ?? 0} owned recommendation(s) and exactly ${mission.newCount ?? 0} new unowned recommendation(s), without duplicates, once enough context or delegation exists. Preserve destination=${mission.destination ?? safe.slots.destination ?? "the user's destination"} and month=${mission.month ?? safe.slots.month ?? "the user's timing"}; never substitute current local weather.`,
      );
    }
  }
  return `\n\n${lines.join("\n")}`;
}
