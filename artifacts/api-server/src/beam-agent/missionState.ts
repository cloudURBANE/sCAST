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

// Capitalized tokens that look like a proper noun but are never a city — command
// verbs that open a sentence ("Recommend August scents"), determiners/pronouns
// ("This summer"), and common request words. Screens the no-preposition place
// pattern in parsePlaceBeforeTime so it can't mistake a sentence-initial word for a
// destination. Lowercased before lookup.
const NON_PLACE_WORDS = new Set<string>([
  "this", "that", "these", "those", "the", "a", "an", "my", "our", "your", "his", "her", "their", "its",
  "it", "i", "we", "you", "they", "he", "she", "one", "some", "any", "no", "each", "every",
  "recommend", "give", "show", "find", "help", "pick", "choose", "suggest", "get", "grab",
  "need", "want", "make", "let", "try", "trying", "looking", "look", "wear", "wearing",
  "something", "anything", "everything", "nothing", "scent", "scents", "fragrance", "fragrances",
  "cologne", "colognes", "perfume", "perfumes", "bottle", "bottles", "picks", "option", "options",
  "today", "tonight", "tomorrow", "now", "next", "last", "soon", "maybe", "please", "just",
  "good", "best", "great", "nice", "new", "fresh", "warm", "cold", "hot", "cool", "light", "dark",
  "going", "heading", "planning", "visiting", "traveling", "travelling", "somewhere",
]);

// Season / climate timing stated without a calendar month: "this summer",
// "cold-weather scents", "in winter", "warm weather". The month slot doubles as the
// timing label the prompt and weather reasoning consume (the pending-month branch
// already maps a bare season the same way), so a parsed season is stored there only
// when no explicit month is present. Bare ambient adjectives ("warm", "hot", "cold",
// "humid") are deliberately NOT mapped: they are scent directions/temperatures or
// current-weather description, not a stated season — so only the "-weather"/"climate"
// compounds and the unambiguous season nouns qualify. Order: compounds and
// preposition-anchored seasons first, then the safe bare nouns.
const SEASON_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:cold|cool|chilly|freezing|wintry)[- ]weather\b/i, "Winter"],
  [/\bcold\s+climate\b/i, "Winter"],
  [/\b(?:hot|warm)[- ]weather\b/i, "Summer"],
  [/\b(?:hot|warm)\s+climate\b/i, "Summer"],
  [/\b(?:this|next|in|during|for|come|over)\s+summer\b/i, "Summer"],
  [/\b(?:this|next|in|during|for|come|over)\s+winter\b/i, "Winter"],
  [/\b(?:this|next|in|during|for|come|over)\s+spring\b/i, "Spring"],
  [/\b(?:this|next|in|during|for|come|over)\s+(?:autumn|fall)\b/i, "Autumn"],
  [/\bsummer(?:time)?\b/i, "Summer"],
  [/\bwinter(?:time)?\b/i, "Winter"],
  [/\bspringtime\b/i, "Spring"],
  [/\bautumn\b/i, "Autumn"],
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
  "avoid",
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

/**
 * A season/climate the user states without a calendar month ("this summer",
 * "cold-weather", "in winter"). Used only as the timing fallback when parseMonth
 * found no explicit month, so "humid July" and "Tokyo in August" still resolve to
 * the month. A negated mention ("not winter") is skipped, mirroring parseMonth.
 */
function parseSeason(text: string): string | undefined {
  for (const [pattern, season] of SEASON_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index !== undefined && !isNegatedBefore(text, match.index)) return season;
  }
  return undefined;
}

function parseDestination(text: string): string | undefined {
  const patterns = [
    /\b(?:party|dinner|brunch|interview|date|graduation|funeral|event|meeting)\s+in\s+([A-Za-z][A-Za-z .'-]{1,50})/i,
    /\b(?:trip|travel(?:ing)?|vacation|visit(?:ing)?|heading|going|flying)\s+(?:to|in|for)\s+([A-Za-z][A-Za-z .'-]{1,50})/i,
    // Prepositive places are ambiguous ("business trip", "road trip"). Accept
    // proper-noun phrasing such as "Tokyo trip" rather than storing false state.
    /\b(?:planning|taking|booking)\s+(?:a\s+)?([A-Z][A-Za-z .'-]{1,40}?)\s+trip\b/,
    // Possessive/appositive phrasing WITHOUT a planning verb — "my Tokyo trip in
    // August", "our Paris trip", "a Berlin trip". The leading capital + the
    // trip-type denylist below keep "a weekend trip" / "a Business trip" out.
    /\b(?:my|our|a|an|the|this|that|on|for)\s+([A-Z][A-Za-z .'-]{1,40}?)\s+trip\b/,
    /\b(?:destination|city)\s+(?:is|:)\s*([A-Za-z][A-Za-z .'-]{1,50})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const destination = match?.[1] ? cleanCapture(match[1]) : "";
    const isMonth = MONTHS.some(([monthPattern]) => monthPattern.test(destination));
    const isOccasion = OCCASIONS.some(([occasionPattern]) => occasionPattern.test(destination));
    const isRelativeTime = /^(?:(?:a|an|the|this|next|last|one|two|three|four|five)\s+)?(?:morning|afternoon|evening|night|weekend|day|week|month|year)s?$/i.test(destination);
    // Common trip-TYPE words that are not places, so "<Type> trip" never fabricates
    // a city even when the user capitalized the type at a sentence start.
    const isTripType = /^(?:business|road|family|work|day|weekend|holiday|ski|beach|camping|fishing|golf|shopping|bachelor|bachelorette|company|team|school|field|solo|group|guys?|girls?|boys?|round|sales|press|book)$/i.test(destination);
    if (destination && !isMonth && !isOccasion && !isRelativeTime && !isTripType && !/^(a|an|the|my|this)$/i.test(destination)) return destination;
  }
  return parsePlaceBeforeTime(text);
}

/**
 * A place named right before a month or season WITHOUT a trip/travel verb —
 * "I need one new scent for Miami in July", "something for Tokyo this summer".
 * The verb-anchored patterns above miss these, which left the destination slot
 * empty and made the agent re-ask "where are you headed?" for a city the user
 * already named. The candidate must be a proper noun (leading capital) so an
 * article/occasion ("for the office in July") is never mistaken for a city.
 */
function parsePlaceBeforeTime(text: string): string | undefined {
  // (A) Place introduced by a connector/verb, then a month or season:
  //     "for Miami in July", "to Tokyo this summer".
  const lead =
    /\b(?:for|to|in|visiting|around|hitting|exploring)\s+([A-Za-z][A-Za-z .'-]{1,40}?)\s+(?:in|this|next|during|come|over)\s+([A-Za-z]+)/i.exec(
      text,
    );
  if (lead?.[1] && lead[2]) {
    const fromLead = validatePlaceBeforeTime(lead[1], lead[2]);
    if (fromLead) return fromLead;
  }
  // (B) A bare proper-noun city written directly before a month/season with no
  //     leading preposition or trip verb — "Tokyo August", "Miami this winter",
  //     "Paris in July". Common phrasings (A) and the verb patterns above miss.
  //     Restricted to a SINGLE capitalized token (multi-word bare cities stay with
  //     the verb/comma forms) and screened by NON_PLACE_WORDS so a sentence-initial
  //     command word or determiner is never read as a destination.
  const bare = /\b([A-Z][a-z][A-Za-z'.-]{1,20})\s+(?:in\s+|this\s+|next\s+|during\s+|come\s+|over\s+)?([A-Za-z]+)\b/g;
  for (let match = bare.exec(text); match; match = bare.exec(text)) {
    const candidate = validatePlaceBeforeTime(match[1], match[2]);
    if (candidate) return candidate;
    if (bare.lastIndex === match.index) bare.lastIndex += 1; // zero-width guard
  }
  return undefined;
}

/** Validate a captured (place, trailingWord) pair: trailing must be a month/season,
 * place must be a proper noun that is not a month/occasion/stopword. */
function validatePlaceBeforeTime(rawPlace: string, rawTime: string): string | undefined {
  const trailingIsTime =
    MONTHS.some(([pattern]) => pattern.test(rawTime)) || /^(?:spring|summer|autumn|fall|winter)$/i.test(rawTime);
  if (!trailingIsTime) return undefined;
  const candidate = cleanCapture(rawPlace);
  // Proper-noun guard: cities are capitalized; "the office" / "a meeting" are not.
  if (!/^[A-Z]/.test(candidate)) return undefined;
  if (NON_PLACE_WORDS.has(candidate.toLowerCase())) return undefined;
  if (MONTHS.some(([pattern]) => pattern.test(candidate))) return undefined;
  if (OCCASIONS.some(([pattern]) => pattern.test(candidate))) return undefined;
  return candidate || undefined;
}

function parseOccasion(text: string): string | undefined {
  for (const [pattern, label] of OCCASIONS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

/**
 * Was the token at `index` introduced by a negation/reduction cue ("less sweet",
 * "not too woody", "no oud", "nothing sweet", "don't want sweet")? A short
 * preceding window is scanned for a negation word that is NOT cut off by a clause
 * boundary (comma/semicolon), so "fresh, not boring" never suppresses "fresh".
 * Mirrors the month-correction guard in parseMonth: a rejected preference must not
 * be stored as if the user asked for it. Without this, "make it less sweet" set
 * direction=sweet — the exact opposite of the refinement — and pushed the agent
 * toward the family the user wanted reduced.
 */
function isNegatedBefore(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 16), index);
  return /(?:\b(?:less|not|no|never|without|avoid|avoiding|nothing|skip|drop|reduce|cut|minus|tone\s+down|too)\b|\w*n['’]t\b)[\s\w]{0,8}$/i.test(
    prefix,
  );
}

/** First case-insensitive match of `pattern` whose match is not negated, if any. */
function matchesUnnegated(text: string, pattern: RegExp): boolean {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index !== undefined && !isNegatedBefore(text, m.index)) return true;
    if (re.lastIndex === m.index) re.lastIndex += 1; // zero-width guard
  }
  return false;
}

function parseVibe(text: string): string | undefined {
  const found = VIBES.filter((vibe) => matchesUnnegated(text, new RegExp(`\\b${vibe}\\b`, "i")));
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
    // A negated family ("less sweet", "no oud") is a constraint to AVOID, not a
    // direction to chase, so it must not enter the scoring direction slot.
    if (matchesUnnegated(text, pattern) && !found.includes(label)) found.push(label);
  }
  const alreadyFreshFamily = found.some((label) => ["citrus", "green", "tea", "aromatic", "aquatic"].includes(label));
  if (matchesUnnegated(text, /\b(?:light|lighter|fresh|airy|bright|clean|crisp)\b/i) && !alreadyFreshFamily) {
    found.unshift("lighter/fresh");
  }
  if (found.length > 0) return found.slice(0, 3).join(", ");
  if (matchesUnnegated(text, /\b(?:warm|warmer|rich|richer|cozy|deep)\b/i)) return "warmer/richer";
  return undefined;
}

/**
 * Hard-dislike markers immediately before a note/family ("no oud", "I hate
 * anything sweet", "without leather", "avoid gourmand", "can't stand patchouli",
 * "allergic to musk"). Deliberately EXCLUDES soft refinements ("less sweet",
 * "tone down the spice", "not too woody") — those tune the positive direction and
 * are handled by parseDirection, whereas these are constraints to exclude from
 * retrieval entirely. The marker must sit within a few words before the family.
 */
function isHardDislikeBefore(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 28), index);
  return /\b(?:no|never|without|avoid|avoiding|hate|hates|hating|dislike|disliking|skip|skipping|nothing|none|anti|can'?t\s+stand|cannot\s+stand|don'?t\s+(?:like|want)|do\s+not\s+(?:like|want)|allergic\s+to|stay\s+away\s+from|keep\s+away\s+from)\b[\s\w]{0,16}$/i.test(
    prefix,
  );
}

/** First case-insensitive match of `pattern` that IS preceded by a hard-dislike marker. */
function matchesHardDislike(text: string, pattern: RegExp): boolean {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index !== undefined && isHardDislikeBefore(text, m.index)) return true;
    if (re.lastIndex === m.index) re.lastIndex += 1; // zero-width guard
  }
  return false;
}

/**
 * Capture scent families/notes the user explicitly asked to AVOID. Unlike the
 * negation guard in parseDirection (which merely keeps a negated family OUT of the
 * positive direction), this records them so they reach the prompt as a hard
 * exclusion and drop matching catalog candidates at retrieval (audit A3).
 */
function parseAvoid(text: string): string | undefined {
  const found: string[] = [];
  for (const [pattern, label] of FAMILY_PATTERNS) {
    if (matchesHardDislike(text, pattern) && !found.includes(label)) found.push(label);
  }
  return found.length > 0 ? found.slice(0, 5).join(", ") : undefined;
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

/**
 * A requested quantity for a plain recommendation ("give me three date-night
 * scents", "recommend two for tonight", "pick 3 fragrances"). Anchored on a
 * fragrance noun so it can't grab an unrelated number ("two sprays", "three
 * notes"). Travel-kit lane counts are parsed separately by
 * parseOwnedCount/parseNewCount.
 */
function parseRecommendationCount(text: string): number | undefined {
  const re = new RegExp(
    String.raw`\b${COUNT_CAPTURE}\s+(?:[\w-]+\s+){0,3}?(?:fragrances?|scents?|bottles?|colognes?|perfumes?|picks?|options?|choices?|ones?)\b`,
    "ig",
  );
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const count = parseCount(match[1]);
    if (count === undefined) {
      if (re.lastIndex === match.index) re.lastIndex += 1; // zero-width guard
      continue;
    }
    // A purchase/preference CONDITION on a single item ("one bottle if I like it")
    // describes buying behavior, not a request to name a pick now — so it must not
    // set a count. A plain "give me two bottles" (no conditional) still counts, and
    // a multi-pick request keeps its count even if it carries a trailing condition.
    const after = text.slice(re.lastIndex, re.lastIndex + 24);
    if (count === 1 && /^\s*if\s+(?:i\b|it\b|they\b)/i.test(after)) continue;
    return count;
  }
  return undefined;
}

/**
 * A terse, count-ONLY reply ("two", "just 2", "exactly three", "make it 3",
 * "a couple please"). Used for clarify recovery when the assistant asked "how
 * many?" and the user answered with nothing but a number. Anchored to the WHOLE
 * message (only leading lead-ins and trailing politeness allowed) so a count that
 * is part of a larger sentence — "two sprays", "two new ones", "for three days" —
 * is left to the noun-anchored parsers and never mistaken for a bare answer.
 */
function parseBareCount(text: string): number | undefined {
  const match =
    /^\s*(?:(?:just|exactly|only|maybe|make\s+it|let'?s\s+do|give\s+me|i'?ll\s+take|i\s+want|do|how\s+about)\s+)*((?:a\s+)?couple|pair|\d+|one|two|three|four|five)\s*(?:picks?|scents?|fragrances?|please|thanks?|of\s+(?:them|those))?\s*[.!]?\s*$/i.exec(
      text,
    );
  return parseCount(match?.[1]);
}

function parseBudget(text: string): string | undefined {
  // An explicit range ("$50-100", "between 80 and 150") — keep both bounds so the
  // ceiling is unambiguous.
  const range =
    /\$?\s?(\d{2,4})\s?(?:-|–|to|and)\s?\$?\s?(\d{2,4})\b/i.exec(text) ??
    /\bbetween\s+\$?\s?(\d{2,4})\s+and\s+\$?\s?(\d{2,4})\b/i.exec(text);
  if (range?.[1] && range?.[2]) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return `$${Math.min(lo, hi)}-${Math.max(lo, hi)}`;
    }
  }
  // A single ceiling ("under $80", "max 150", "no more than 100", "around 90").
  const match =
    /\b(?:under|below|max(?:imum)?|budget(?:\s+is)?|less than|no more than|up to|around|about|approx(?:imately)?)\s+\$?\s?(\d{2,4})\b/i.exec(
      text,
    );
  if (match?.[1]) return `$${match[1]}`;
  // Qualitative budget words, with negation guarded so "not cheap" / "no budget"
  // don't register as a cheap constraint.
  if (matchesUnnegated(text, /\b(?:cheap|affordable|inexpensive|budget[- ]friendly|on a budget)\b/i)) {
    return "Budget-friendly";
  }
  if (matchesUnnegated(text, /\b(?:splurge|high[- ]?end|money is no object|premium|luxury)\b/i)) {
    return "Premium";
  }
  return undefined;
}

/**
 * Normalize a user message for delegation detection: lowercase, fold curly
 * apostrophes/backticks to a straight `'`, and collapse whitespace. Keeps the
 * pattern layer below free of per-pattern apostrophe and spacing noise.
 */
function normalizeForDelegation(message: string): string {
  return message
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Delegation detection layers. The user has handed Beam the choice and is owed a
 * committed pick, not another clarifying question. This is intentionally LAYERED
 * by intent FAMILY rather than one flat keyword list, so semantically equivalent
 * phrasings ("I trust you", "don't ask me more questions", "give me the answer",
 * "use what you know") all resolve to the same typed `userDelegatedChoice` signal
 * the commit gates consume — no per-gate regex sprawl. Each family is tightly
 * scoped so ordinary exploration ("what do you think of Aventus?", "tell me what
 * you know about it") and the user RESERVING the choice ("let me decide", "I'll
 * pick") never trip it.
 */
const DELEGATION_PATTERNS: RegExp[] = [
  // 1. "I don't know — you tell me" — punting the decision outright.
  /\b(?:idk|i\s+don'?t\s+know|i\s+have\s+no\s+idea|you\s+tell\s+me)\b/,
  // 2. Direct hand-off aimed at "you": you decide / you choose / you pick / you
  //    call it / (I want) you to decide. The negative lookbehind blocks the
  //    interrogative "how/do/can/would you decide" (a question about HOW Beam
  //    works, not a hand-off).
  /(?<!\b(?:how|do|does|did|can|could|will|would|should|why)\s)\byou\s+(?:to\s+)?(?:decide|choose|pick|call\s+it|make\s+the\s+call)\b/,
  // 3. Possessive / "up to you" hand-off: your call|choice|pick, dealer's choice,
  //    up to you, in your hands, whatever you think|like|want|recommend|say.
  /\byour\s+(?:call|choice|pick)\b|\bdealer'?s\s+choice\b|\bup\s+to\s+you\b|\bin\s+your\s+hands\b|\bwhatever\s+you\s+(?:think|like|want|recommend|say)\b/,
  // 4. Trust frames: I trust you / I'll trust your judgment|taste|gut|instinct.
  /\bi\s+(?:will\s+|'?ll\s+)?trust\s+(?:you|your\s+\w+)\b|\btrust\s+your\s+(?:judg\w*|taste|gut|instinct\w*|call|pick)\b/,
  // 5. Commit-now framing: recommend now, make the call|decision, just pick/choose/
  //    recommend/decide, just go ahead/for it, go ahead. ("just go" is scoped to
  //    go-ahead/for-it/with-it so a narrative "I just go for whatever" never trips.)
  /\brecommend\s+now\b|\bmake\s+the\s+(?:call|decision)\b|\bjust\s+(?:pick|choose|recommend|decide)\b|\bjust\s+go\s+(?:ahead|for\s+it|with\s+(?:it|one|that))\b|\bgo\s+ahead\b/,
  // 6. "pick/choose/recommend (something) for me" / "give me the answer|pick|best"
  //    — explicit ask for the conclusion. The "choose the best" arm is anchored to
  //    a hand-off subject (clause-start imperative or "you choose the best") so the
  //    user RESERVING it ("I want to choose the best myself") and the educational
  //    "how do I choose the best summer scent?" never register as delegation.
  /\b(?:pick|choose|decide|recommend)\s+(?:one\s+|something\s+|the\s+best\s+)?for\s+me\b|(?:^|[.,;!]\s*|\byou\s+)(?:just\s+)?(?:choose|pick|recommend)\s+the\s+best\b|\bgive\s+me\s+(?:the|your|an|one)\s+(?:answer|pick|best)\b/,
  // 7. Indifference: surprise me, doesn't matter, anything works|is fine|goes.
  /\bsurprise\s+me\b|\bdoesn'?t\s+matter\b|\banything\s+(?:works|is\s+fine|goes)\b/,
  // 8. "just tell me what to wear/buy/get/grab" — wants the answer, not a menu.
  //    Scoped to the action verbs so "tell me what to expect" never trips.
  /\b(?:just\s+)?tell\s+me\s+what\s+to\s+(?:wear|buy|get|grab|pick|use|spray)\b/,
  // 9. "don't ask me more questions" / "no more questions" / "stop asking" — an
  //    explicit demand to stop clarifying and commit.
  /\b(?:don'?t|do\s+not|stop|quit)\s+ask\w*(?:\s+me)?(?:\s+(?:any\s+)?more)?\s+questions?\b|\bno\s+more\s+questions?\b|\bstop\s+asking\b/,
];

/**
 * "use/with/based on what you know|have|got" — commit on the context Beam already
 * holds. This is a hand-off ("use what you know about me", "Recommend now with
 * what you know") ONLY as an instruction, NOT as the premise of an education /
 * availability QUESTION ("based on what you know about niche houses, are they
 * worth it?", "with what you have in stock?"). The trailing "?" is the
 * discriminator, applied by isDelegationPhrase; the base clause stays anchored to
 * with/use/using/from/based-on so "tell me what you know" never matches.
 */
const CONTEXT_HANDOFF_PATTERN = /\b(?:with|use|using|from|based\s+on)\s+what\s+you\s+(?:know|have|got)\b/;

/**
 * True when the message hands the choice to Beam. Pure and cheap — runs before
 * any model call so delegation is a deterministic, typed signal rather than
 * something the model has to infer.
 */
export function isDelegationPhrase(message: string): boolean {
  const text = normalizeForDelegation(message);
  if (!text) return false;
  if (DELEGATION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // Context hand-off only when it is an instruction, not a trailing question.
  if (!/\?\s*$/.test(text) && CONTEXT_HANDOFF_PATTERN.test(text)) return true;
  return false;
}

/**
 * Owned-vs-new constraint for a plain recommendation stated without a count/trip
 * (those become travel-kit lanes). "don't recommend anything I already own" / "new
 * to me" → "new"; "pick from my wardrobe" / "one I already have" → "owned". An
 * explicit new-only signal wins over an owned phrase if both appear.
 */
function parseNewness(text: string): "new" | "owned" | undefined {
  const newOnly =
    /\b(?:new\s+to\s+me|not\s+in\s+my\s+(?:wardrobe|vault|collection)|(?:don'?t|do\s+not)\s+(?:already\s+)?(?:own|have)\b|haven'?t\s+(?:tried|owned)|nothing\s+i\s+(?:already\s+)?own|don'?t\s+recommend\s+(?:anything|ones?|stuff|fragrances?|scents?)\s+i\s+(?:already\s+)?own|avoid\s+(?:ones?\s+|stuff\s+|fragrances?\s+)?i\s+(?:already\s+)?own|something\s+new\b)/i.test(
      text,
    );
  if (newOnly) return "new";
  const ownedOnly =
    /\b(?:from\s+my\s+(?:wardrobe|vault|collection)|in\s+my\s+(?:wardrobe|vault|collection)|(?:one|something|a\s+scent|a\s+fragrance)\s+i\s+(?:already\s+)?(?:own|have)\b|already\s+(?:own|have)\s+(?:it|one|something)|wear\s+what\s+i\s+(?:own|have))/i.test(
      text,
    );
  if (ownedOnly) return "owned";
  return undefined;
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

  // A requested quantity ("give me three scents") or an owned/new constraint ("wear
  // what I own", "something new to me") is itself a recommendation request even when
  // the verb isn't one of the explicit recommend/pick words.
  const count = parseRecommendationCount(text);
  const newness = parseNewness(text);
  const recommendationLike =
    count !== undefined ||
    newness !== undefined ||
    /\b(?:recommend|recommendation|suggest|what should i wear|pick|choose|match|give me|show me|find me|i (?:need|want)|need|want)\b/i.test(text);
  if (recommendationLike) {
    return {
      intent: "recommendation",
      ...(count !== undefined ? { count } : {}),
      ...(newness ? { newness } : {}),
      userDelegatedChoice: isDelegationPhrase(text) || undefined,
    };
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
    for (const key of ["ownedCount", "newCount", "count"] as const) {
      const count = rawMission[key];
      if (typeof count === "number" && Number.isFinite(count) && count >= 1 && count <= 5) mission[key] = Math.floor(count);
    }
    for (const key of ["destination", "month"] as const) {
      const slot = rawMission[key];
      if (typeof slot === "string" && slot.trim()) mission[key] = slot.trim().slice(0, 120);
    }
    if (rawMission.newness === "new" || rawMission.newness === "owned") mission.newness = rawMission.newness;
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
    // direction + avoid are additive lists (a user piles up families they want /
    // want excluded across turns); every other slot is last-write-wins.
    slots[key] = (key === "direction" || key === "avoid") && slots[key]
      ? mergeSlotList(slots[key], next)
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

/**
 * A bare "travel kit" with no stated lane counts ("pack me a kit for Tokyo")
 * defaults to this many NEW (discovery) picks so it always produces a real
 * multi-bottle kit instead of collapsing to a single recommendation. New-only
 * keeps the kit fulfillable regardless of what's in the user's vault.
 */
const DEFAULT_TRAVEL_KIT_NEW_COUNT = 3;

export function deriveBeamSessionState(
  previous: BeamSessionState | undefined,
  userMessage: string,
  pendingSlot?: BeamSlotKey,
): BeamSessionState {
  const text = userMessage.slice(0, 2000);
  const slots: BeamSessionSlots = {};
  // Explicit calendar month wins; a stated season/climate ("this summer",
  // "cold-weather") is the timing fallback so "humid July" still resolves to July.
  const month = parseMonth(text) ?? parseSeason(text);
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
  const avoid = parseAvoid(text);
  if (avoid) slots.avoid = avoid;

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
  // Explicit verbal boundaries that DISCARD the prior mission. Two families:
  // forward pivots ("now…", "next…", "new trip…") and outright resets ("forget
  // that", "scratch that", "never mind", "start over", "new/different question").
  // Both must wipe a prior trip's destination/timing/counts/delegation so the user
  // can cleanly change subject.
  const explicitMissionBoundary =
    /^\s*(?:now\b|next\b|another\b|separately\b|for\s+(?:another|a\s+new)\b|new\s+(?:trip|mission|question|request|topic)\b|forget\s+(?:that|it|the\b)|scratch\s+that\b|never\s?mind\b|start\s+over\b|change\s+of\s+plans?\b|different\s+(?:question|request|topic)\b)/i.test(text);
  // A turn that brings genuinely new mission context — a different occasion ("what
  // should I wear to work?"), a new/different destination, or an explicit pick
  // count ("give me one date-night scent") — is a real new request, NOT a tweak of
  // the current kit. Computed up front so the refinement guards below can exclude it.
  const turnBringsNewMissionContext = Boolean(slots.occasion || slots.destination || preliminaryMission?.count);
  // A follow-up to an already-PRESENTED travel kit is a REFINEMENT, not a new
  // mission — even when a generic verb ("swap the Aventus pick", "match the look")
  // makes this turn parse as a bare recommendation. Without this, that verb flips
  // the intent, trips startsNewMission, and wipes the kit's destination/timing/
  // counts, so the agent both loses context and re-gathers slots. BUT a turn that
  // carries genuinely new mission context (a new occasion/destination/pick count) or
  // an explicit boundary phrase is a real new ask, so it must NOT be absorbed as a
  // refinement — otherwise "actually give me one date-night scent" inherits the
  // whole Tokyo kit.
  const refiningPresentedKit =
    previous?.mission?.intent === "travel_kit" &&
    previous.mission.kitPresented === true &&
    !explicitMissionBoundary &&
    !turnBringsNewMissionContext;
  // A travel kit addressed by a bare recommendation TWEAK ("I want it lighter",
  // "give me something woodier") is a REFINEMENT, not a new mission — the broadened
  // recommendation verbs (give me / need / want / show me / find me) must not let a
  // tweak downgrade the kit and wipe its counts/destination/timing. A turn that
  // brings genuinely new mission context — a different occasion ("what should I wear
  // to work?"), a new destination, or an explicit pick count — is still a real new
  // request and resets as before, as does an explicit boundary phrase.
  const downgradesKitToRecommendation =
    previous?.mission?.intent === "travel_kit" &&
    preliminaryMission?.intent === "recommendation" &&
    !explicitMissionBoundary &&
    !turnBringsNewMissionContext;
  const startsNewMission = Boolean(
    preliminaryMission?.intent &&
    previous &&
    !refiningPresentedKit &&
    !downgradesKitToRecommendation &&
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
  // Don't let a generic-verb recommendation patch downgrade a preserved travel
  // kit (presented or still being built): the kit's intent/counts/destination must
  // survive a swap-style refinement ("swap the Aventus pick", "I want it lighter").
  // A real new-kit patch (it parses as travel_kit, e.g. "make it 3 new") still
  // merges and updates the counts, and an explicit boundary already reset the base.
  if ((refiningPresentedKit || downgradesKitToRecommendation) && mission?.intent === "recommendation") {
    mission = undefined;
  }
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
  const result = mergeBeamSessionState(baseState, patch);
  // Clarify recovery for a bare count answer: if the agent asked "how many?" and
  // the user replied with just a number ("two", "make it 3"), attach it to an
  // active recommendation mission that has no count yet. Scoped to recommendation
  // missions only — a bare count against a travel kit is owned/new-ambiguous, so it
  // is intentionally left for the user to disambiguate rather than guessed.
  if (result.mission?.intent === "recommendation" && result.mission.count === undefined) {
    const bare = parseBareCount(text);
    if (bare !== undefined) result.mission.count = bare;
  }
  // A travel kit the user never gave lane counts for ("travel kit to Tokyo")
  // used to degrade to a single recommendation, which reads nothing like a kit.
  // Default it to a small NEW-discovery kit so it yields a real multi-bottle
  // deliverable. Fires only when BOTH counts are absent, so an explicit count —
  // on this turn or carried from a prior one via the merge above — is never
  // overridden, and a kit downgraded/reset elsewhere stays as the other logic left it.
  if (
    result.mission?.intent === "travel_kit" &&
    result.mission.ownedCount === undefined &&
    result.mission.newCount === undefined
  ) {
    result.mission.newCount = DEFAULT_TRAVEL_KIT_NEW_COUNT;
  }
  return result;
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
  // Captured constraints are HARD, not just context the model may weigh. Surface
  // them explicitly so budget and dislikes shape the recommendation itself, not
  // only its wording (audit A2/A3).
  if (safe.slots.avoid) {
    lines.push(
      `Hard exclusion: the user does NOT want ${safe.slots.avoid}. Never headline or build the recommendation around an avoided note/family; if a strong pick happens to contain one, either choose a different pick or call out the trace honestly. Do not search for these.`,
    );
  }
  if (safe.slots.budget && !/^no\s*limit$/i.test(safe.slots.budget)) {
    lines.push(
      `Budget constraint: ${safe.slots.budget}. Treat this as a ceiling — favor picks within it, and if you must mention something above it, flag that it's a splurge rather than presenting it as the obvious choice.`,
    );
  }
  if (mission?.intent) {
    const parts = [`intent=${mission.intent}`];
    if (mission.ownedCount) parts.push(`ownedCount=${mission.ownedCount}`);
    if (mission.newCount) parts.push(`newCount=${mission.newCount}`);
    if (mission.count) parts.push(`count=${mission.count}`);
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
        "This is a NEW-ONLY discovery mission. Do not recommend or score an owned vault bottle. Use the vault only as a taste reference, search with excludeOwned=true, check each new pick's vault overlap, and call beam_present_travel_kit with an empty owned lane. For each new pick, explain its destination/timing fit, direction fit, and how it differs from the vault. Any owned bottle mentioned in prose must appear only in a separate, explicit taste-reference label. If the wardrobe cannot be loaded, still deliver the new picks but say you are assuming they are not already in their wardrobe.",
      );
    }
    if (mission.ownedCount || mission.newCount) {
      lines.push(
        `The final answer and travel-kit card must contain exactly ${mission.ownedCount ?? 0} owned recommendation(s) and exactly ${mission.newCount ?? 0} new unowned recommendation(s), without duplicates, once enough context or delegation exists. Preserve destination=${mission.destination ?? safe.slots.destination ?? "the user's destination"} and month=${mission.month ?? safe.slots.month ?? "the user's timing"}; never substitute current local weather.`,
      );
    }
  } else if (mission?.intent === "recommendation") {
    if (mission.count) {
      lines.push(
        `The user asked for exactly ${mission.count} recommendation(s). Name exactly ${mission.count} primary pick(s) (one optional runner-up is fine) once you have enough context or the user delegates; never return fewer than ${mission.count}.`,
      );
    }
    if (mission.newness === "new") {
      lines.push(
        "Recommend only fragrances the user does NOT already own. Use the vault only as a taste reference, search with excludeOwned=true, and present only unowned picks. If the wardrobe cannot be loaded, still deliver the picks but say you are assuming they are not already in their wardrobe.",
      );
    } else if (mission.newness === "owned") {
      lines.push(
        "Recommend only fragrances ALREADY in the user's wardrobe. Score the owned vault with beam_score_candidates and do not suggest unowned catalog fragrances.",
      );
    }
  }
  return `\n\n${lines.join("\n")}`;
}
