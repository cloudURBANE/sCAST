/**
 * Beam Agent deterministic answer quality gates.
 *
 * These checks are pure and fast. The loop already constrains fragrance names to
 * tool results; this module blocks unsupported external claims, instruction
 * leaks, overlong answers, redundant clarifications for known slots, and
 * travel-kit answers that do not fulfill the required owned/new counts.
 */
import type { BeamGroundedFragrance, BeamSessionSlots, BeamSessionState, BeamSlotKey } from "./types.ts";
import { pendingSlotSatisfiedBy } from "./missionState.ts";

export type QualityGateInput = {
  /**
   * True when the run actually gathered a fresh external fact this turn. When
   * false, price / availability / review claims are unsupported.
   */
  hadExternalEvidence: boolean;
  /** Max answer length in characters. */
  maxChars?: number;
  /** Structured state extracted from user messages, used for memory/mission gates. */
  sessionState?: BeamSessionState;
  /** Tool-grounded fragrance names with ownership, used for mission fulfillment gates. */
  groundedFragrances?: BeamGroundedFragrance[];
  /** Current/home weather label returned by context; forbidden for a different travel destination. */
  localWeatherLocation?: string | null;
  /**
   * True when THIS turn is emitting a complete, lane-count-validated travel-kit
   * CARD that already carries the picks (the structured `beam_present_travel_kit`
   * deliverable, after `missionToolResultError` confirmed its exact lane counts).
   * The system prompt tells the model NOT to re-list a card's data in prose
   * ("After emitting a card, point to what it shows — never re-list its data in
   * prose"), so a correct card-backed kit answer intentionally names few or no
   * picks in prose. Without this flag the prose `mission_unfulfilled` count gate
   * would hard-fail that obedient answer on the very turn the card is created
   * (`kitPresented` is only set AFTER the gate runs). The card's lane counts are
   * already enforced independently by `missionToolResultError`, so suppressing the
   * prose count here loses no protection. Defaults to false (prose count still
   * enforced) so a kit creation with NO card behaves exactly as before.
   */
  missionCardPresented?: boolean;
};

export type QualityGateResult = {
  passed: boolean;
  violations: string[];
};

/** ~4k chars is generous enough for premium answers without tripping normal prose. */
const DEFAULT_MAX_CHARS = 4000;

/** A price figure using a common currency symbol, code, or currency word. */
const PRICE_PATTERN =
  /(?:[$€£¥]\s?\d|\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s?\d|\b\d{1,7}(?:[.,]\d{2})?\s?(?:usd|eur|gbp|cad|aud|jpy|dollars?|euros?|pounds?|yen)\b)/i;

/** Availability / stock / discount claims that require a fresh source. */
const AVAILABILITY_PATTERN =
  /\b(?:in stock|out of stock|back in stock|sold out|currently available|available (?:now|at|from|online)|on sale|ships? (?:free|today|tomorrow)|discontinued|reformulated)\b|\b\d{1,3}%\s?off\b/i;

/** Numeric review-score / rating claims that require a fresh source. */
const REVIEW_PATTERN =
  /\b\d(?:\.\d)?\s?(?:\/|out of|of)\s?5\b|\b\d(?:\.\d)?\s?stars?\b|\b\d{1,3}%\s?(?:positive|recommend)/i;

/**
 * Prompt-injection / instruction text leaking out of untrusted content into the
 * reply. The verb→noun arms allow 1–3 stacked qualifiers and `\s+` between every
 * token, so the canonical "ignore all previous instructions" (two qualifiers) and
 * whitespace-padded variants ("ignore  all  instructions") are both caught — the
 * single-space, single-qualifier form silently missed them. Repetition is bounded
 * to 3 so there is no catastrophic backtracking.
 */
const LEAKED_INSTRUCTION_PATTERN =
  /\b(?:ignore\s+(?:(?:all|any|the|previous|above|prior)\s+){1,3}(?:instructions?|prompts?|rules?)|disregard\s+(?:all|any|the|previous|above|prior)|you\s+are\s+now\s+(?:a|an)\b|system\s+prompt)\b|<\/?(?:system|instructions?)>|^\s*(?:system|assistant)\s*:/im;

/**
 * Raw OpenAI "harmony"/gpt-oss control markup or a tool-call recipient header that
 * leaked into the prose (a harmony-format model emitting `<|channel|>commentary
 * to=functions.x <|message|>{…}<|call|>` as text instead of a structured tool call).
 * The provider scrubs this at the source; this gate is the deterministic backstop
 * so any residue fails the run cleanly instead of rendering as tokens to the user.
 */
const LEAKED_TOOL_CALL_PATTERN = /<\|(?:start|end|message|channel|constrain|call|return)\b|\bto=functions\./i;

function asksForKnownSlot(text: string, state: BeamSessionState | undefined): boolean {
  const slots = state?.slots ?? {};
  if (!/[?]|\b(?:tell me|let me know|which|what|when|where)\b/i.test(text)) return false;
  if (
    slots.month &&
    /\b(?:what|which)\s+month\b|\bwhen\s+(?:are|will|do|is).{0,60}\b(?:go|going|travel|trip|leave)\b|\b(?:travel\s+dates?|what\s+dates?|which\s+season|time\s+of\s+year)\b/i.test(text)
  ) {
    return true;
  }
  if (
    slots.destination &&
    /\bwhere\s+(?:are|will|do|is).{0,60}\b(?:go|going|travel|trip)\b|\b(?:what|which)\s+(?:city|destination)\b/i.test(text)
  ) {
    return true;
  }
  if (
    (slots.vibe || slots.direction) &&
    /\b(?:what|which)\s+(?:vibe|mood|direction|style|feel)\b|\b(?:lighter|fresh|warmer|richer)\b.{0,50}\?/i.test(text)
  ) {
    return true;
  }
  // The occasion slot had no redundant-clarification guard at all, so re-asking a
  // known occasion ("what's the occasion?" after the user already said "a wedding")
  // slipped through. Mirrors the slot the deterministic parser now captures.
  if (
    slots.occasion &&
    /\bwhat'?s\s+the\s+occasion\b|\b(?:what|which)\s+(?:occasion|setting|event)\b|\bwhat\s+(?:are|will)\s+you\s+(?:be\s+)?(?:wear|dress|getting\s+ready)\w*\b.{0,12}\bfor\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

/**
 * "vibe" (mood) and "direction" (scent family) are one calibration dimension
 * worded two ways, so a re-ask of EITHER keeps a vibe-or-direction question alive
 * — neither counts as abandoning it. Mirrors missionState.COMPATIBLE_SLOTS so the
 * loop's slot resolution and this gate never disagree about what answered what.
 */
const VIBE_OR_DIRECTION_REASK =
  /\b(?:vibe|mood|style|feel|citrus|green|aromatic|lighter|fresh|warm(?:er)?|rich(?:er)?|woody|woods?|spic(?:y|e)|sweet|floral|fruity|aquatic|direction|family|lean(?:s|ing)?)\b/i;

function abandonsPendingSlot(
  text: string,
  state: BeamSessionState | undefined,
  grounded: BeamGroundedFragrance[],
): boolean {
  const slot = state?.pendingSlotUnanswered ? state.pendingSlot : undefined;
  if (!slot) return false;
  // If the pending slot is already satisfied — directly, or via its compatible twin
  // (vibe⇄direction) — it isn't actually open, so nothing can abandon it. Keeps this
  // gate consistent with the loop's slot resolution for any stale pending pointer.
  if (state && pendingSlotSatisfiedBy(slot, state.slots)) return false;
  // A turn that commits to a tool-grounded pick is a recommendation, not a botched
  // clarification. Once the agent is delivering real, retrieved fragrances it is
  // entitled to move past an open clarification (mirrors delegatedButDeferred). The
  // deterministic slot parser misses plenty of valid free-text answers, so without
  // this exemption a fully grounded recommendation (e.g. a 40-candidate travel kit)
  // gets hard-failed over a re-ask nit. Mission completeness stays enforced by the
  // separate travel_kit fulfillment gate.
  if (grounded.some((item) => answerMentionsFragrance(text, item))) return false;
  if (!text.includes("?")) return true;
  const patterns: Partial<Record<NonNullable<BeamSessionState["pendingSlot"]>, RegExp>> = {
    direction: VIBE_OR_DIRECTION_REASK,
    projection: /\b(?:projection|trail|skin[ -]?close|moderate|statement)\b/i,
    occasion: /\b(?:occasion|setting|work|date|night out|staying in|party|dinner|interview|brunch|funeral|formal event|graduation|wedding|gym)\b/i,
    impression: /\b(?:impression|calm|focused|confident|social|come across)\b/i,
    vibe: VIBE_OR_DIRECTION_REASK,
    budget: /\b(?:budget|spend|price)\b/i,
    month: /\b(?:month|when|season|time of year)\b/i,
    destination: /\b(?:where|destination|city)\b/i,
  };
  return !(patterns[slot]?.test(text) ?? false);
}

/** A clarifying / preference-seeking question (requires an actual `?`). */
const PREFERENCE_QUESTION_PATTERN =
  /\b(?:do|would|are|could|can|have)\s+you\b|\b(?:which|what|when|where|how about)\b|\bprefer(?:ence)?\b|\b(?:fresh|light|warm|day)\s+or\b|\b(?:tell me|let me know)\b/i;

/**
 * Delegation backstop (handoff B2): once the user hands the choice over ("idk,
 * you tell me"), the agent must commit — not ask another preference question.
 * Fires only when the user delegated AND the answer poses a clarifying question
 * AND it names no grounded pick (a committed answer that names a real fragrance,
 * even with a trailing rhetorical question, is fine).
 */
function delegatedButDeferred(
  text: string,
  state: BeamSessionState | undefined,
  grounded: BeamGroundedFragrance[],
): boolean {
  const delegated = Boolean(state?.userDelegatedChoice || state?.mission?.userDelegatedChoice);
  if (!delegated) return false;
  if (!text.includes("?")) return false;
  if (!PREFERENCE_QUESTION_PATTERN.test(text)) return false;
  return !grounded.some((item) => answerMentionsFragrance(text, item));
}

/**
 * Explicit deferral / "I'm not ready" language. These are the phrasings the
 * Recommendation Commit Policy forbids once the user is owed a pick — refusals
 * that the question-shaped (`delegated_but_questioned`) and zero-pick
 * (`recommendation_without_grounded_pick`) gates miss because the answer either
 * carries no `?` or still names a pick while leading with a hedge ("I'm not ready
 * to commit, but maybe Aventus"). Patterns are deferral-specific so a committed
 * answer that merely steers AWAY from a category ("I can't recommend a dense
 * gourmand here, so reach for X") never trips: "recommend" alone is excluded; the
 * commit verbs (commit/pick/choose/decide) and the "not ready / need more info /
 * before I" frames are the trigger.
 */
const DEFERRAL_PATTERN = new RegExp(
  [
    // "not ready to commit / pick / recommend / decide"
    String.raw`\bnot\s+(?:yet\s+)?ready\s+to\s+(?:commit|pick|choose|decide|recommend|call\s+it)\b`,
    // bare "I'm not ready"
    String.raw`\b(?:i'?m|i\s+am)\s+not\s+(?:quite\s+)?ready\b`,
    // "I can't / cannot pick|choose|decide|commit (yet)" — intransitive commit verbs only
    String.raw`\b(?:can'?t|cannot|not\s+able\s+to|unable\s+to)\s+(?:quite\s+|yet\s+)?(?:commit|pick|choose|decide)\b(?:\s+(?:yet|right\s+now|just\s+yet))?`,
    // "can't confidently pick/recommend" / "not confident enough"
    String.raw`\b(?:can'?t|cannot)\s+confidently\s+(?:commit|pick|choose|decide|recommend)\b`,
    String.raw`\bnot\s+confident\s+enough\s+to\s+(?:commit|pick|choose|decide|recommend)\b`,
    // "I need / I'd need more info|information|details|context" (not "if YOU need …")
    String.raw`(?<!you\s)(?<!if\syou\s)\b(?:i\s+(?:still\s+)?need|i'?d\s+need|i\s+would\s+need|need)\s+(?:a\s+bit\s+)?more\s+(?:info|information|details?|context|to\s+go\s+on)\b`,
    // "not enough info/context to go on"
    String.raw`\bnot\s+enough\s+(?:info|information|context|to\s+go\s+on)\b`,
    // "before I (can) recommend/pick/commit/decide"
    String.raw`\bbefore\s+i\s+(?:can\s+)?(?:recommend|pick|commit|choose|decide)\b`,
    // "I'd rather know / hear / understand / learn ..." — wants more info before
    // committing (apostrophe class covers the straight ' and curly ’ models emit).
    // Scoped to info verbs so "I'd rather you go bold" (a commitment) never trips.
    String.raw`\b(?:i['’]?d|i\s+would)\s+rather\s+(?:know|hear|understand|learn)\b`,
    // "tell me (a bit) more first/before ..." — defers the pick pending more input.
    // The "first/before" anchor keeps engagement prose ("tell me more about how it
    // wears") from firing.
    String.raw`\btell\s+me\s+(?:a\s+(?:bit|little)\s+)?more\s+(?:first|before)\b`,
    // "(I) can't recommend (anything/one/a pick) (just) yet" — the temporal "yet"
    // anchor is what makes this a deferral, not category steering. "recommend" is
    // deliberately excluded from the intransitive commit-verb arm above so
    // "I can't recommend a dense gourmand here" (steering toward a real pick) stays
    // allowed; that phrase has no "yet", so these two "yet"-anchored forms catch the
    // pure deferral ("I can't recommend yet, but maybe X") without re-trapping it.
    String.raw`\b(?:can'?t|cannot)\s+recommend\s+(?:anything\s+|one\s+|a\s+pick\s+)?(?:just\s+)?yet\b`,
    String.raw`\b(?:can'?t|cannot)\s+yet\s+recommend\b`,
    // "hold off on recommending/picking/committing ..." — postpones the decision.
    // Scoped to the decision verbs so "hold off on a second spray" never fires.
    String.raw`\bhold\s+off\s+(?:on\s+)?(?:recommend\w*|pick\w*|commit\w*|choos\w*|decid\w*)\b`,
    // "(I'd) hesitate to pick/recommend/commit ..." — a refusal to choose. Scoped to
    // the decision verbs so "don't hesitate to layer it" never fires.
    String.raw`\bhesitate\s+to\s+(?:recommend|pick|commit|choose|decide|call)\b`,
    // "hard to say/pick ... (anything) without/until <more input>" — defers pending
    // info. The verb must be immediately followed by without/until (optionally
    // "anything"/"much") so a genuine comparison ("hard to say which lasts longer
    // without trying both, but I'd take X") keeps its committed pick and stays silent.
    String.raw`\bhard\s+to\s+(?:say|pick|recommend|commit|choose|decide)\s+(?:anything\s+|much\s+)?(?:without|until)\b`,
  ].join("|"),
  "i",
);

/**
 * A capability-denial refusal: the agent claims it CANNOT access / see / read /
 * retrieve the user's wardrobe (or vault / collection / fragrances) — a false
 * statement, because `beam_get_wardrobe` returns exactly that. This is distinct
 * from a legitimate "your wardrobe is empty": an empty vault is a real, valid
 * result the agent SHOULD report.
 *
 * The free-tier orchestration model occasionally emits this from memory instead
 * of calling the wardrobe tool. The loop uses this detector to force a bounded
 * retrieval re-prompt so such a refusal is never shipped to the user. It is the
 * data-access analogue of `DEFERRAL_PATTERN` (which only covers "can't *pick*"),
 * and unlike `refusedToCommit` it is NOT gated on grounded picks — the whole
 * point is that it fires when nothing was retrieved.
 */
const DATA_ACCESS_REFUSAL_PATTERN = new RegExp(
  [
    // "(I) can't / cannot / unable to / won't be able to <access-verb> … wardrobe"
    String.raw`\b(?:can'?t|cannot|can\s?not|unable\s+to|not\s+able\s+to|won'?t\s+be\s+able\s+to)\s+(?:\w+\s+){0,4}?(?:access|see|view|read|retriev\w*|reach|pull\s+up|look\s+(?:up|at|into)|get\s+(?:to|at)|view|check)\b[^.!?]{0,40}?\b(?:wardrobe|vault|collection|fragrances?|bottles?)\b`,
    // "I don't have access to / no access to / without access to … wardrobe"
    String.raw`\b(?:don'?t\s+have\s+access|do\s+not\s+have\s+access|no\s+access|without\s+access|don'?t\s+have\s+(?:the\s+)?ability\s+to\s+(?:access|see|view|read))\b[^.!?]{0,40}?\b(?:wardrobe|vault|collection|fragrances?|bottles?)\b`,
    // "I can't see / tell / access what you own / have"
    String.raw`\b(?:can'?t|cannot|unable\s+to)\s+(?:see|tell|view|access)\b[^.!?]{0,40}?\bwhat\b[^.!?]{0,30}?\byou\s+(?:own|have)\b`,
  ].join("|"),
  "i",
);

/**
 * True when `text` claims the agent cannot access the user's wardrobe/vault — a
 * capability denial the loop must never ship (the wardrobe IS retrievable). An
 * honest empty-vault statement ("your wardrobe is empty", "you haven't added any
 * fragrances yet") does not match, so reporting an empty vault stays allowed.
 */
export function isDataAccessRefusal(text: string): boolean {
  if (!text) return false;
  return DATA_ACCESS_REFUSAL_PATTERN.test(text);
}

/**
 * Recommendation Commit Policy backstop. Once the user is owed a concrete pick
 * (they delegated the choice, stated a plain recommendation intent, or a travel
 * kit has enough context to fulfill), the agent must commit — never lead with a
 * deferral. Fires when such a turn uses forbidden deferral language AND at least
 * one SAFE (non-avoided) grounded pick is on the table, so the single repair pass
 * can always rewrite it into a clean, named commitment. If every grounded
 * candidate violates an avoid constraint — or nothing was retrieved at all — the
 * agent legitimately cannot commit, so this stays silent (the zero-pick gate and
 * the retrieval nudge own those paths).
 */
function refusedToCommit(
  text: string,
  state: BeamSessionState | undefined,
  grounded: BeamGroundedFragrance[],
): boolean {
  if (!isOwedRecommendation(state)) return false;
  if (!DEFERRAL_PATTERN.test(text)) return false;
  return grounded.some((item) => item.matchedAvoid !== true);
}

/**
 * The user is owed a concrete recommendation this turn: they delegated the
 * choice, asked for a plain recommendation, or a travel kit has enough context to
 * fulfill. Shared by the commit-policy and zero-pick backstops.
 */
function isOwedRecommendation(state: BeamSessionState | undefined): boolean {
  if (state?.userDelegatedChoice || state?.mission?.userDelegatedChoice) return true;
  if (state?.mission?.intent === "recommendation") return true;
  if (state?.mission?.intent === "travel_kit" && missionReadyForFulfillment(state)) return true;
  return false;
}

/**
 * Avoid backstop (audit A3 depth): the captured `avoid` slot is enforced at
 * retrieval (`excludeAvoidedHits`), but owned-vault picks and research results
 * bypass that filter, so the model can still surface an avoided note via those
 * paths. Each grounded pick carries a precomputed `matchedAvoid` flag (set at
 * grounding time from its source-hit profile). This fires ONLY when a pick the
 * answer actually NAMES objectively matches an avoided term — so prose that
 * merely mentions the avoided word while excluding it ("no oud here") never
 * false-positives.
 */
function recommendsAvoidedNote(text: string, grounded: BeamGroundedFragrance[]): boolean {
  return grounded.some((item) => item.matchedAvoid === true && answerMentionsFragrance(text, item));
}

function missionReadyForFulfillment(state: BeamSessionState | undefined): boolean {
  const mission = state?.mission;
  if (mission?.intent !== "travel_kit") return false;
  if (state?.userDelegatedChoice || mission.userDelegatedChoice) return true;
  const slots = state?.slots ?? {};
  const hasPlace = Boolean(slots.destination || slots.occasion || mission.destination);
  const hasTiming = Boolean(slots.month || mission.month || slots.occasion);
  const hasDirection = Boolean(slots.vibe || slots.direction);
  return hasPlace && hasTiming && hasDirection;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedNameVariants(item: BeamGroundedFragrance): string[] {
  const variants = [item.canonicalName];
  if (item.brand) variants.push(`${item.brand} ${item.canonicalName}`);
  return variants
    .map((value) => value.trim())
    .filter((value, index, arr) => value && arr.findIndex((v) => v.toLowerCase() === value.toLowerCase()) === index);
}

function answerMentionsFragrance(answerText: string, item: BeamGroundedFragrance): boolean {
  for (const variant of normalizedNameVariants(item)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(variant)}([^a-z0-9]|$)`, "i");
    if (pattern.test(answerText)) return true;
  }
  return false;
}

function countMissionPicks(answerText: string, grounded: BeamGroundedFragrance[]): { owned: number; new: number } {
  const owned = new Set<string>();
  const fresh = new Set<string>();
  for (const item of grounded) {
    if (!answerMentionsFragrance(answerText, item)) continue;
    const key = `${item.brand ?? ""}::${item.canonicalName}`.toLowerCase();
    if (item.owned) owned.add(key);
    else fresh.add(key);
  }
  return { owned: owned.size, new: fresh.size };
}

function namesWrongTravelLocation(
  text: string,
  state: BeamSessionState | undefined,
  localWeatherLocation: string | null | undefined,
): boolean {
  const destination = state?.mission?.destination ?? state?.slots.destination;
  if (!destination || !localWeatherLocation) return false;
  const homeCity = localWeatherLocation.split(",")[0]?.trim();
  if (!homeCity || destination.toLowerCase().includes(homeCity.toLowerCase())) return false;
  return new RegExp(`\\b${escapeRegExp(homeCity)}(?:['’]s)?\\b`, "i").test(text);
}

function ownsUnlabeledRecommendation(
  text: string,
  state: BeamSessionState | undefined,
  grounded: BeamGroundedFragrance[],
): boolean {
  const mission = state?.mission;
  if (mission?.intent !== "travel_kit" || (mission.ownedCount ?? 0) > 0 || (mission.newCount ?? 0) === 0) {
    return false;
  }
  for (const item of grounded.filter((entry) => entry.owned)) {
    for (const variant of normalizedNameVariants(item)) {
      const lowerText = text.toLowerCase();
      const lowerVariant = variant.toLowerCase();
      let index = lowerText.indexOf(lowerVariant);
      while (index >= 0) {
        const before = text.slice(0, index);
        const boundary = Math.max(
          before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"),
          before.lastIndexOf(";"), before.lastIndexOf("\n"),
        );
        const clause = text.slice(boundary + 1, index + variant.length);
        if (!/\b(?:taste|comparison) reference\b|\breference (?:point|from your vault)\b/i.test(clause)) {
          return true;
        }
        index = lowerText.indexOf(lowerVariant, index + lowerVariant.length);
      }
    }
  }
  return false;
}

/**
 * Evaluate the final answer. Returns the list of violated gate names (empty when
 * the answer passes). Pure; never throws.
 */
export function runAnswerQualityGates(answerText: string, input: QualityGateInput): QualityGateResult {
  const text = typeof answerText === "string" ? answerText : "";
  const maxChars = Number.isFinite(input.maxChars) ? (input.maxChars as number) : DEFAULT_MAX_CHARS;
  const violations: string[] = [];

  if (!input.hadExternalEvidence) {
    if (PRICE_PATTERN.test(text)) violations.push("price_without_evidence");
    if (AVAILABILITY_PATTERN.test(text)) violations.push("availability_without_evidence");
    if (REVIEW_PATTERN.test(text)) violations.push("review_claim_without_evidence");
  }
  if (asksForKnownSlot(text, input.sessionState)) violations.push("redundant_clarification");
  if (abandonsPendingSlot(text, input.sessionState, input.groundedFragrances ?? [])) {
    violations.push("pending_slot_abandoned");
  }
  if (delegatedButDeferred(text, input.sessionState, input.groundedFragrances ?? [])) {
    violations.push("delegated_but_questioned");
  }
  if (refusedToCommit(text, input.sessionState, input.groundedFragrances ?? [])) {
    violations.push("commit_refusal");
  }
  if (namesWrongTravelLocation(text, input.sessionState, input.localWeatherLocation)) {
    violations.push("destination_context_mismatch");
  }
  if (ownsUnlabeledRecommendation(text, input.sessionState, input.groundedFragrances ?? [])) {
    violations.push("owned_pick_in_new_only_mission");
  }
  if (recommendsAvoidedNote(text, input.groundedFragrances ?? [])) {
    violations.push("recommends_avoided_note");
  }

  const mission = input.sessionState?.mission;
  // Once a complete kit has been presented, a follow-up turn is a REFINEMENT
  // ("swap the heavier one for something cleaner") and legitimately names only the
  // pick(s) it is changing — not all 4. Enforcing the exact prose count here would
  // hard-fail every refinement. The structured deliverable contract
  // (missionToolResultError) still enforces exact lane counts on ANY kit card the
  // agent re-presents, and a genuinely new mission resets `kitPresented`
  // (deriveBeamSessionState → startsNewMission), so creation is still count-gated.
  //
  // The same relaxation applies to the CREATION turn itself when a complete kit
  // CARD is emitted this turn (`missionCardPresented`). The system prompt forbids
  // re-listing a card's data in prose, so an obedient card-backed answer names few
  // or no picks in prose — and `kitPresented` is only set AFTER this gate runs, so
  // it cannot cover the creation turn. The card's lane counts are already validated
  // by `missionToolResultError`, so skipping the prose count here loses nothing; a
  // kit "creation" with NO card (model claimed a kit in prose only) still fails.
  if (
    mission?.intent === "travel_kit" &&
    !mission.kitPresented &&
    !input.missionCardPresented &&
    missionReadyForFulfillment(input.sessionState) &&
    ((mission.ownedCount ?? 0) > 0 || (mission.newCount ?? 0) > 0)
  ) {
    const counts = countMissionPicks(text, input.groundedFragrances ?? []);
    const ownedRequired = mission.ownedCount ?? 0;
    const newRequired = mission.newCount ?? 0;
    if ((ownedRequired > 0 && counts.owned !== ownedRequired) || (newRequired > 0 && counts.new !== newRequired)) {
      violations.push("mission_unfulfilled");
    }
  }

  // Plain recommendation with an explicit quantity ("give me three date-night
  // scents"): the bug is returning ONE when the user asked for more. Fire only
  // when the answer already commits to at least one grounded pick but names
  // fewer than requested — so a still-gathering clarification turn (zero picks)
  // and a complete answer (an optional runner-up beyond the count) are both safe.
  if (mission?.intent === "recommendation" && (mission.count ?? 0) > 1) {
    const counts = countMissionPicks(text, input.groundedFragrances ?? []);
    const named = counts.owned + counts.new;
    if (named >= 1 && named < (mission.count ?? 0)) {
      violations.push("recommendation_count_short");
    }
  }

  // A committed answer that names ZERO grounded picks when the user is OWED a
  // concrete recommendation. "Owed" = a plain `recommendation` mission OR the user
  // explicitly DELEGATED the choice ("you decide", "surprise me", "pick for me").
  // A bare delegation carries no recommendation intent — missionState returns only
  // `userDelegatedChoice` with no mission (see missionState.deriveBeamSessionState)
  // — so without this delegation arm a flat "honestly you can't go wrong" hedge,
  // with safe grounded candidates already on the table, escaped every gate:
  // delegated_but_questioned needs a `?`, and the recommendation arm needs the
  // intent. That was the dominant "Recommend now. You decide." → vague-non-answer
  // hole.
  //
  // Avoid-aware: fire ONLY when at least one SAFE (non-`matchedAvoid`) grounded pick
  // is actually available to name. If every grounded candidate violates an avoid
  // constraint, the agent legitimately cannot commit and SHOULD ask — forcing a
  // commit there would create an unsatisfiable repair (commit ⇒ recommends_avoided_note).
  // The `?` guard keeps a genuine clarifying turn safe; a still-gathering turn has
  // zero grounded ⇒ no fire; this only fills the zero-named hole left by
  // recommendation_count_short (which needs named >= 1).
  const owedRecommendation =
    mission?.intent === "recommendation" ||
    Boolean(input.sessionState?.userDelegatedChoice || mission?.userDelegatedChoice);
  if (owedRecommendation && !text.includes("?")) {
    const grounded = input.groundedFragrances ?? [];
    const hasSafeGroundedPick = grounded.some((item) => item.matchedAvoid !== true);
    if (hasSafeGroundedPick) {
      const counts = countMissionPicks(text, grounded);
      if (counts.owned + counts.new === 0) violations.push("recommendation_without_grounded_pick");
    }
  }

  if (LEAKED_INSTRUCTION_PATTERN.test(text)) violations.push("leaked_external_instruction");
  if (LEAKED_TOOL_CALL_PATTERN.test(text)) violations.push("leaked_tool_call");
  if (text.length > maxChars) violations.push("over_length");

  return { passed: violations.length === 0, violations };
}

/**
 * A short instruction appended to a constrained re-synthesis when gates fail.
 * Maps each gate to a concrete fix the model can act on.
 */
export function repairInstructionFor(violations: string[]): string {
  const fixes: string[] = [];
  if (violations.includes("price_without_evidence"))
    fixes.push("Do NOT state any price - you have no fresh price evidence; say the price needs confirmation.");
  if (violations.includes("availability_without_evidence"))
    fixes.push("Do NOT claim stock/availability/discontinued status - you have no fresh source for it.");
  if (violations.includes("review_claim_without_evidence"))
    fixes.push("Do NOT cite ratings or review scores - you have no fresh source for them.");
  if (violations.includes("redundant_clarification"))
    fixes.push("Do NOT ask for month, destination, occasion, vibe, or direction already present in Known so far; use the known value.");
  if (violations.includes("pending_slot_abandoned"))
    fixes.push("The latest user message did not answer the active question. Acknowledge useful context, then re-ask that same slot with choices from its category only.");
  if (violations.includes("delegated_but_questioned"))
    fixes.push("The user delegated the choice - do NOT ask another preference question; commit to a specific grounded recommendation now.");
  if (violations.includes("commit_refusal"))
    fixes.push("Remove all deferral/hedging language ('not ready to commit', 'I need more information', 'I can't pick yet'). The user asked you to decide and you have grounded options - lead with a confident named pick and state any assumptions instead of asking for more.");
  if (violations.includes("mission_unfulfilled"))
    fixes.push("Fulfill the travel-kit target exactly: name exactly the requested count in each requested lane, using only grounded results; new picks must be unowned.");
  if (violations.includes("recommendation_count_short"))
    fixes.push("The user asked for more than one pick - name the full requested number of distinct grounded recommendations, not just one.");
  if (violations.includes("destination_context_mismatch"))
    fixes.push("Use the user's travel destination and timing. Remove every reference to their current/home weather location.");
  if (violations.includes("owned_pick_in_new_only_mission"))
    fixes.push("Do not recommend an owned bottle in this new-only mission. If mentioned, move it to a separate line explicitly labeled 'Taste reference from your vault'.");
  if (violations.includes("recommends_avoided_note"))
    fixes.push("You recommended a fragrance built around a note the user asked to avoid - replace it with a grounded pick that does not feature that note.");
  if (violations.includes("recommendation_without_grounded_pick"))
    fixes.push("You committed to a recommendation but named no specific fragrance - commit to a specific grounded pick from the retrieved results.");
  if (violations.includes("leaked_external_instruction"))
    fixes.push("Remove any instruction-like text; answer only as the concierge.");
  if (violations.includes("leaked_tool_call"))
    fixes.push("Remove all raw control tokens and tool-call syntax ('<|...|>', 'to=functions.*', 'commentary'/'analysis' channels). Reply only with the finished, user-facing recommendation in plain prose.");
  if (violations.includes("over_length")) fixes.push("Be more concise.");
  return (
    "Your draft broke an answer rule. Rewrite it for the user, fixing: " +
    fixes.join(" ") +
    " Keep the grounded recommendation; only remove the unsupported claim."
  );
}

/**
 * Canonical, gate-safe re-ask text per slot. Each line contains the slot's own
 * keyword (so `abandonsPendingSlot` passes when that slot is pending) and ends in
 * a fenced `cues` block of single-category chips. These are the LAST-RESORT
 * deterministic clarifications the loop falls back to when the model cannot
 * produce a gate-passing clarifying turn on its own — they keep a context-gathering
 * session alive instead of dead-ending it on a hard failure.
 */
const SLOT_CLARIFICATION: Record<BeamSlotKey, { ask: string; cues: string[] }> = {
  destination: { ask: "Where are you headed?", cues: ["Tokyo", "Paris", "New York", "Somewhere warm"] },
  month: {
    ask: "When is this for — roughly which month or season?",
    cues: ["This summer", "This winter", "Spring", "Autumn"],
  },
  occasion: {
    ask: "What's the occasion or setting?",
    cues: ["Work", "Date night", "Night out", "Staying in"],
  },
  vibe: {
    ask: "What vibe are you going for?",
    cues: ["Artsy and quiet", "Bold and modern", "Clean and classic", "Warm and cozy"],
  },
  direction: {
    ask: "Which scent direction feels right?",
    cues: ["Citrus / fresh", "Woody / warm", "Green / aromatic", "Sweet / gourmand"],
  },
  projection: {
    ask: "How much presence do you want it to have?",
    cues: ["Skin-close", "Moderate trail", "A statement"],
  },
  impression: {
    ask: "What impression do you want to give?",
    cues: ["Calm", "Focused", "Confident", "Social"],
  },
  // No "$NN" figures in the cues — a literal price trips the price-evidence gate.
  budget: { ask: "Any budget in mind?", cues: ["Budget-friendly", "Mid-range", "Premium", "No limit"] },
  // `avoid` is a captured constraint, never a slot the agent re-asks to fill, so
  // this entry only satisfies the exhaustive Record type; in practice
  // inferPendingSlotFromAssistant never returns "avoid".
  avoid: { ask: "Anything you'd rather avoid?", cues: ["No oud", "Nothing sweet", "No heavy musk", "No strong projection"] },
};

const GENERIC_CLARIFICATION =
  "Tell me a bit more about what you're after and I'll line up the right picks.\n```cues\nA scent for today\nSomething for a trip\nA gift idea\nSurprise me\n```";

function formatClarification(template: { ask: string; cues: string[] }): string {
  return `${template.ask}\n\`\`\`cues\n${template.cues.join("\n")}\n\`\`\``;
}

/** First missing field required to make a travel kit ready for fulfillment. */
function firstTravelKitUnknownSlot(slots: BeamSessionSlots): BeamSlotKey | undefined {
  // An occasion supplies enough setting context to stand in for both destination
  // and timing (the same rule used by missionReadyForFulfillment).
  if (!slots.destination && !slots.occasion) return "destination";
  if (!slots.month && !slots.occasion) return "month";
  if (!slots.direction && !slots.vibe) return "direction";
  return undefined;
}

/**
 * Build a deterministic, gate-safe clarifying question from the session state, so
 * a tool-free turn that the model couldn't make gate-clean never has to hard-fail.
 * Returns null when asking would itself be wrong: the user delegated the choice
 * (must commit, not ask), or a travel kit already has enough context to fulfill
 * (must recommend, not ask). The caller still re-runs the gates on the output, so
 * this is a best-effort generator with the gate as the final guarantee.
 */
export function buildSafeClarification(state: BeamSessionState | undefined): string | null {
  if (state?.userDelegatedChoice || state?.mission?.userDelegatedChoice) return null;
  if (missionReadyForFulfillment(state)) return null;

  const slots = state?.slots ?? {};
  // Re-ask the pending slot only when it (and its compatible twin, vibe⇄direction)
  // is genuinely still unknown. A stale pending pointer at an already-captured slot
  // would otherwise produce a redundant question that fails its own gate.
  const pending = state?.pendingSlotUnanswered ? state.pendingSlot : undefined;
  if (pending && !pendingSlotSatisfiedBy(pending, slots)) {
    return formatClarification(SLOT_CLARIFICATION[pending]);
  }

  if (state?.mission?.intent === "travel_kit") {
    const target = firstTravelKitUnknownSlot(slots);
    if (target) return formatClarification(SLOT_CLARIFICATION[target]);
  }
  return GENERIC_CLARIFICATION;
}

/** Render one grounded pick as the gate's name-matching variant ("Brand Name"). */
function commitDisplayName(item: BeamGroundedFragrance): string {
  return item.brand ? `${item.brand} ${item.canonicalName}` : item.canonicalName;
}

/**
 * Pick the grounded fragrances a deterministic commit should name, honoring the
 * mission's lane/count contract so the composed text passes the same gates:
 *   - new-only travel kit → up to `newCount` UNOWNED picks (never an owned bottle,
 *     which would trip owned_pick_in_new_only_mission / mission_unfulfilled),
 *   - plain recommendation with an explicit count → that many picks,
 *   - otherwise a single decisive pick.
 * Returns [] when no safe pick exists in the required lane.
 */
function commitPicks(
  state: BeamSessionState | undefined,
  safe: BeamGroundedFragrance[],
): BeamGroundedFragrance[] {
  const mission = state?.mission;
  const newOnlyKit =
    mission?.intent === "travel_kit" && (mission.ownedCount ?? 0) === 0 && (mission.newCount ?? 0) > 0;
  if (newOnlyKit) {
    return safe.filter((item) => !item.owned).slice(0, mission!.newCount ?? 1);
  }
  if (mission?.intent === "recommendation" && (mission.count ?? 0) > 1) {
    return safe.slice(0, mission.count!);
  }
  return safe.slice(0, 1);
}

/**
 * Build a deterministic, gate-safe COMMIT from the grounded candidates, so a
 * tool-grounded turn the user is owed a pick on never has to dead-end on an empty
 * answer when the model's synthesis (and its single repair) failed to name one.
 * The mirror of `buildSafeClarification` for the recommend side: it names ONLY
 * already-grounded fragrances (never invents one), states no price/availability/
 * review claim, and asks nothing — so re-running the gates on it is the final
 * guarantee. Returns null when committing would itself be wrong: the user is not
 * owed a recommendation this turn, or every grounded candidate is unsafe (avoided)
 * or absent in the required lane (then a clarification, not a forced pick, is owed).
 */
export function buildGroundedCommitFallback(
  state: BeamSessionState | undefined,
  grounded: BeamGroundedFragrance[],
): string | null {
  if (!isOwedRecommendation(state)) return null;
  const safe = grounded.filter((item) => item.matchedAvoid !== true);
  if (safe.length === 0) return null;
  const picks = commitPicks(state, safe);
  if (picks.length === 0) return null;

  const names = picks.map((item) => `**${commitDisplayName(item)}**`);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const tail = picks.length > 1 ? "the strongest grounded matches" : "the strongest grounded match";
  return `Here's my call: ${list} — ${tail} from what I pulled for you.`;
}
