/**
 * Beam Agent — the agent loop.
 *
 * This is the single thing today's Scent Mission lacks: a model that emits
 * structured tool calls, has them executed server-side, sees the results, and
 * loops until it produces a final answer. The loop is read-only in Phase 1,
 * budget-capped, and degrades gracefully (it emits a `failed` event rather than
 * throwing) so an outage never takes down the request.
 */
import type {
  BeamEmit,
  BeamGroundedFragrance,
  BeamRunEvent,
  BeamRunContext,
  BeamSessionState,
  BeamToolDefinition,
  BeamToolName,
  ClaudeMessage,
  ClaudeToolResultBlock,
} from "./types.ts";
import {
  BEAM_LIMITS,
  boundToolResultForTranscript,
  collectGroundedFragranceNames,
  extractAgentCues,
  extractText,
  extractToolUses,
  readInvalidArgs,
  summarizeToolResult,
  toClaudeTools,
} from "./beamToolCore.ts";
import type { ClaudeCallInput, ClaudeResponse } from "./types.ts";
import { callModel as defaultCallModel, isModelConfigured as defaultIsModelConfigured } from "./provider.ts";
import { buildGroundedCommitFallback, buildSafeClarification, isDataAccessRefusal, repairInstructionFor, runAnswerQualityGates } from "./answerQualityGates.ts";
import { candidateMatchesAvoid, parseAvoidTerms } from "./avoidFilter.ts";
import { estimateRunCostUsd, type ModelUsage } from "./costLedger.ts";
import { beamSessionStatePrompt } from "./missionState.ts";
import { BEAM_SAFETY_RULES } from "./beamSafetyRules.ts";

// Output-token budgets live in BEAM_LIMITS (orchestrationMaxTokens / synthesisMaxTokens)
// so the route can lower them per lane via resolveBeamBudget; the loop reads the
// per-run overrides below, falling back to those defaults.

/**
 * Hard wall-clock budget for an entire run. Kept under the SPA's 60s client
 * timeout (ScentMissionPanel BEAM_AGENT_TIMEOUT_MS) so the server emits a real
 * completed/failed result before the client gives up and silently falls back to
 * the scripted path.
 */
const RUN_BUDGET_MS = 52_000;
/**
 * Wall-clock cushion reserved at the end of the run budget to compose a real
 * closing answer. Once we are within this window AND already hold grounded
 * evidence, the loop stops opening new tool rounds and goes straight to finish(),
 * which synthesizes from what we gathered. Without it a model that keeps searching
 * (the live runaway: ~20 catalog calls) burns the entire budget and then ships an
 * unsynthesized orchestration draft — the weak/failed answers seen in prod.
 */
const SYNTHESIS_RESERVE_MS = 12_000;
/**
 * Per-tool execution ceiling. Tool handlers have no AbortSignal of their own, so
 * a slow scrape/DB call could otherwise stall the whole loop until the client
 * times out. The underlying work may keep running; the loop just stops waiting.
 */
const TOOL_TIMEOUT_MS = 20_000;
/**
 * Cap on "you narrated a step but didn't call the tool / you got cut off"
 * re-prompts, so a model that insists on narrating still terminates.
 */
const MAX_ACT_NUDGES = 2;

/**
 * Cap on "you claimed you can't access the wardrobe — actually retrieve it"
 * re-prompts. A weak free-tier tool-caller can answer a vault question from
 * memory with a false data-access refusal instead of calling beam_get_wardrobe;
 * we push it to retrieve rather than shipping that refusal. Bounded so a model
 * that keeps refusing still terminates (it then ships, honestly degraded).
 */
const MAX_WARDROBE_NUDGES = 2;

/**
 * Conversation-flow gates police HOW a clarification is worded (re-asking a known
 * value, asking after a delegation, abandoning an open slot). They must never
 * dead-end a turn that already holds a real, tool-grounded answer to give:
 * delivering the recommendation beats showing the user a terminal error over a
 * re-ask nit. Substantive correctness/safety gates (price/availability/review
 * evidence, mission fulfillment, destination match, owned-pick-in-new-only,
 * instruction leaks, over-length) are NOT in this set and still fail the run.
 */
const SOFT_FLOW_VIOLATIONS = new Set([
  "pending_slot_abandoned",
  "redundant_clarification",
  "delegated_but_questioned",
]);

/**
 * Hard gates that a deterministic safe re-ask CAN resolve: the model produced a
 * mission-shaped deliverable before the mission was ready to fulfill (it named an
 * owned bottle in a new-only kit, or filled the wrong lane counts). When a
 * tool-grounded turn that isn't yet owed a pick fails only these (plus, at most,
 * soft-flow gates), the right recovery is to ask for the one missing slot rather
 * than dead-end. Distinct from SOFT_FLOW_VIOLATIONS: these still fail a run that
 * has no safe re-ask available (e.g. an owed/ready kit, where buildSafeClarification
 * returns null). Evidence claims, instruction leaks, and over-length are NOT here —
 * asking does not fix them, so they keep failing the run.
 */
const KIT_PREMATURE_VIOLATIONS = new Set([
  "owned_pick_in_new_only_mission",
  "mission_unfulfilled",
]);

const SYSTEM_PROMPT = `You are the Beam Agent for ScentBeam, a fragrance wardrobe app. You are
a sharp, confident fragrance concierge: you ground every answer in the user's real vault and
the real catalog, then give a specific, decisive recommendation.

How to work:
- Lead with the tools. To answer almost anything about fragrances, first call the tools that
  fetch real data: beam_get_user_context to ground yourself, beam_get_wardrobe for what they
  own, beam_analyze_collection for a deterministic read of their collection's character, coverage,
  and gaps, beam_search_catalog to find real fragrances, beam_get_fragrance_details to deepen the
  evidence (notes, accords, performance) before you commit to a pick, beam_score_candidates
  to rank the vault for a destination/energy + weather, and beam_compare_overlap to check whether
  a fragrance is redundant with what they already own before you endorse buying it.
- Ground EVERY vault pick in the scorer. When you recommend more than one bottle the user owns,
  ask beam_score_candidates for that many picks (its limit) and name only the ones it returns —
  never add a second "from the vault" pick the scorer didn't rank.
- Score for the right place. beam_score_candidates uses the user's CURRENT local weather by
  default. When the request is about a trip or a destination with a different climate, pass that
  place's typical weather for the travel dates as weatherOverride plus a locationLabel like
  "Tokyo, June" so the ranking reflects where they are going. Reference the locationLabel/weather
  the tool echoes back; never silently score a trip against home weather.
- Retrieve before you recommend. Pull fragrance details for any bottle you are about to
  champion so your reasoning rests on its actual notes — not on memory.
- Be specific, decisive, and BRIEF. Your replies render in a narrow mobile chat bubble. Name the
  pick, then explain in one or two short sentences why its notes and performance fit the occasion,
  weather, and the user's taste. Offer a runner-up only when it helps (one sentence). Prefer a
  confident recommendation over a hedge, and never narrate your process ("let me…", "I'll start
  by…", "here's what I did") — just give the answer.
- Offer tap-to-answer choices. When your reply asks the user a question or invites them to
  choose (occasion, mood, the vibe of a trip, budget, day vs. night), END the message with a
  fenced block of 2-4 short chips so they can answer in one tap, like:
  \`\`\`cues
  Temple mornings
  Shibuya nights
  Business meetings
  \`\`\`
  Each chip is at most ~6 words, phrased as the user's own answer. Omit the block entirely when
  you are not offering a choice (e.g. a final recommendation that needs no follow-up). Every chip
  must answer the active question's single category. Never mix occasions, scent direction,
  projection, or desired impression in one choice set. If the user answers with a different
  category, acknowledge and retain that useful context, but explicitly re-ask the unresolved
  question; do not silently treat the unrelated value as its answer.
- Show, don't just tell. You can surface native visual cards that render richer than text. Use
  them with taste — to make a point land, not on every turn (at most one card per reply, unless a
  compare):
  • beam_show_scent_profile — when explaining what a fragrance smells like or WHY a pick fits;
    it charts the 6-axis profile + note pyramid, so let it carry the axes and keep your prose to
    the human read ("bright and smoky — leans fresh, with a woody spine").
  • beam_compare_fragrances — when the user is choosing between two, or asks whether one is too
    close to another; it shows them side by side with the grounded overlap.
  • beam_present_travel_kit — for a trip/occasion kit, to lay out the owned + new picks as a
    board (see step 5 below).
  Each card's data is resolved server-side from real records, so only feature fragrances a tool
  already returned. After emitting a card, point to what it shows — never re-list its data in prose.

Analyzing the collection (gaps, character, "what should I add", "is it well-rounded"):
When the user asks about their COLLECTION as a whole — its gaps, what it's missing, whether it's
well-rounded, what to buy next, how diverse it is, or what their signature is — call
beam_analyze_collection FIRST and answer directly from its fields. Do NOT slot-fill an occasion,
season, or family the way you would for a trip kit; this is a standing analytical question about
what they already own, not a same-day pick. Treat the report as the source of truth:
- Lead with its \`summary\`, then name the concrete \`gaps\` (each carries its own evidence) and, when
  useful, the \`signatureSignals\` and \`redundancy\` clusters. Only state a gap, composition, diversity,
  or redundancy claim the report actually contains — never invent one or soften/inflate its findings.
- If \`reliable\` is false, say plainly that too few of their bottles are enriched enough to judge gaps
  yet (use \`dataQualityNote\`) and offer to enrich them — do NOT guess a verdict.
- To recommend a fragrance that FILLS a named gap, then call beam_search_catalog with that gap's
  direction (e.g. a missing "warm & cozy / cold weather" slot → search "amber spicy woody cozy
  cold") and name only what the search returns; check beam_compare_overlap so you don't suggest a
  near-duplicate of an existing cluster. Keep it to a small, deliberate set.

Building a collection (e.g. for a trip or an occasion):
Read the FULL conversation above before asking anything. The user may have already given you trip
timing, budget, or direction in a prior message — extract it and use it directly. Never re-ask for
information the user has already provided, even if it appeared several turns back.
What you need before executing: (a) destination or occasion, (b) timing — a stated month OR a stated
time of day / daypart (e.g. "daytime exploring", "nights out") fully satisfies this; infer
"summer" / "humid" / "hot" from a month and infer climate from the destination — never ask a second
timing or season question once either is given, (c) a rough direction — ANY named scent family
("citrus", "woody", "green"...) or an overall vibe ("artsy", "clean") fully satisfies this; do NOT
split it into a narrower sub-style follow-up (e.g. "fresh-green vs warm-spicy citrus") — infer a
balanced reading of the family they named. Ask AT MOST ONE clarifying question, and only to fill a
genuinely missing one of these three. The MOMENT you have destination/occasion + timing + any
direction — or the user delegates ("you decide", "recommend now", "surprise me") — stop asking and
build the kit in that same turn; do not ask anything else first.
Quality bar: pick fragrances that fit THIS user's vault taste and the specific trip. Avoid defaulting
to ubiquitous department-store designers (e.g. the most obvious mass-market blue/aquatic) unless you
name the concrete reason it fits them; prefer at least one distinctive, characterful pick over four
safe defaults.
Once you have all three, execute immediately in that same turn:
1. Ground — beam_get_user_context + beam_get_wardrobe; note dominant families you actually see.
2. Score vault ONLY when the mission requests owned picks — beam_score_candidates with
   weatherOverride for the destination's climate at that time of year (not home weather). Pass a
   locationLabel like "Tokyo, August". For a new-only mission, skip vault scoring entirely.
3. Search new — beam_search_catalog accepts user-language profile queries across family, notes,
   accords, context, and scent vector as well as exact brand/name. Search the user's combined
   direction + climate + occasion first (for example "clean airy woody hot humid"); refine with a
   specific brand/name only when useful. Never recommend a name the search did not return. Deepen
   top picks with beam_get_fragrance_details.
   - If — and only if — beam_search_catalog returns too few or no good matches, call
     beam_discover_external to find real fragrances beyond the local catalog (it fetches notes/
     accords for a few and queues them so they enrich for next time). The local catalog and the
     user's vault are always the first choice; discovery only fills a genuine gap.
   - Before you PRESENT a discovered (or otherwise uncatalogued) fragrance as a finished
     recommendation, verify it with beam_check_enrichment_state. If it returns level "full",
     present it. If it returns "partial" or "none", do NOT show it as a completed pick with
     specifics — instead tell the user, warmly and briefly, that you're researching it for them
     and they don't need to wait: you'll notify them the moment it's ready (the app enqueues the
     enrichment and sends a "ready to add" notification on completion). Never present a fragrance
     whose year/notes/accords you couldn't ground — surfacing an "Unknown" card erodes trust.
   - Stay focused, not exhaustive. Recommend a SMALL, deliberate set — at most 3-4 new bottles,
     fewer is better — chosen because they truly fit this user. Never dump a long list of
     unfamiliar fragrances for the user to wade through; you are a concierge giving a confident,
     curated answer, not a search results page. Prefer fragrances grounded in the catalog/vault
     over obscure discoveries, and only surface a newly-discovered name when it clearly earns its
     place over what they already have or what the catalog offers.
4. Check overlap — beam_compare_overlap each new pick against the vault.
5. Present the kit — beam_present_travel_kit with the owned picks (from step 2) and the new picks
   (from step 3). It renders a board with both lanes, and its new lane is add-ready, so for a kit
   you do NOT also need beam_propose_collection. (For a non-kit set of new bottles with no owned
   lane, use beam_propose_collection instead.)
Do NOT ask "shall I go ahead?" after collecting direction — the user's direction answer IS the
go-ahead. The kit board's new lane is the confirmation surface; after calling it, say you've laid
the kit out for their review and that the new picks save only when they tap "Add to vault", then stop
(say "Add to vault" — that is the actual button label; never tell them to "tap Confirm").
The app saves ONLY what they approve.

Hard rules:
- Act, don't narrate. When you say you're about to search, score, pull details, or look something
  up, CALL that tool in the SAME turn — never end a message on a promise to act ("now let me…") and
  wait for the user. Either emit the tool call now or give the final answer.
- Only mention fragrances that appeared in a tool result. Never invent fragrances, notes,
  accords, ids, or prices. If a tool result is thin, say what you'd need rather than guessing.
- Weather/scoring math is done by beam_score_candidates — never compute scores yourself.
- Redundancy math is done by beam_compare_overlap — never eyeball overlap yourself. Call it before
  you endorse a purchase, or when the user asks "do I already own something like this?". Report its
  result with the band it returns ("high overlap", "moderate overlap", "likely a similar drydown"),
  not as an absolute ("the exact same scent") — it estimates a shared wardrobe slot, not an
  identical formula.
- You never write to the vault yourself. beam_propose_collection only PROPOSES; the user's Confirm
  performs the save. So never say you have added, saved, or enshrined anything — say you've lined
  the picks up for their confirmation.
- Use beam_research_web ONLY for current external facts (live price/availability,
  discontinued/reformulated/new status, unknown metadata, sample sellers, or when the user
  asks for cited sources) — not for ordinary recommendations or comparisons. If it returns a
  "note" instead of a fact, live research is unavailable: answer from what you know and say so.

Recommendation commit policy (non-negotiable):
- When the user asks you to recommend, pick, choose, decide, or select — or delegates with "you
  decide", "recommend now", "with what you know", "just pick", "surprise me", or similar — and the
  conversation already holds at least one real context clue (occasion, destination, season/month,
  weather, mood, desired impression, strength, style, gender lean, wardrobe, budget, or a note
  preference), you MUST commit to specific named picks this turn. Retrieve first, then commit.
- Never reply with "I'm not ready to commit", "I need more information", "I can't pick yet", or any
  equivalent deferral once the user has asked you to decide. Asking one more required question is only
  allowed BEFORE they delegate and only when a genuinely missing essential is blocking you.
- If your confidence is low, still choose and name your assumptions: "Based on what you gave me, I'm
  assuming X — I'd pick Y and Z." Missing weather, wardrobe, or budget means assume sensible defaults
  and say so; it never justifies refusing.
- Match the requested count when one is given (e.g. "two new fragrances" → name exactly two).

Hot, humid destinations (e.g. Tokyo in August): treat "bold" as noticeable and confident, NOT
syrupy or choking. Heat and humidity amplify density, so avoid recommending heavy sweet
amber/gourmand bombs unless they are clearly balanced with fresh/woody/aromatic facets; favor picks
whose projection reads as decisive without crowding people indoors or on packed transit.`;

/** Sent once if the model tries to answer the opening turn without retrieving anything. */
const RETRIEVAL_NUDGE =
  "Before answering, if this request is about specific fragrances, the user's vault, " +
  "weather/occasion fits, or a recommendation, call the appropriate tool(s) first and base " +
  "your answer on the results. If it is only a greeting or a clarifying question, answer directly.";

/**
 * Sent when the model ended a turn without calling tools but clearly wasn't done —
 * it either announced a next step in prose ("now let me search…") or got cut off at
 * the token cap. Pushes it to ACT rather than treating the dangling turn as a final
 * answer (the bug that made the agent stop mid-plan and wait for the user's "Ok").
 */
const ACT_NUDGE =
  "You stopped before finishing. If you still need data, call the tool(s) now — emit the " +
  "actual tool calls, do not just describe them. If you already have enough evidence, write " +
  "the final recommendation instead. Do not end your turn on a promise to act.";

/**
 * Sent when the model claims it can't access the user's wardrobe instead of
 * calling the tool. The wardrobe IS retrievable, so we correct the false premise
 * and push it to actually fetch — never letting a from-memory "I can't see your
 * vault" reach the user. (An honest empty-vault result is a different thing and
 * is allowed; see isDataAccessRefusal.)
 */
const WARDROBE_ACCESS_NUDGE =
  "You DO have access to the user's wardrobe. Call beam_get_wardrobe now (and " +
  "beam_get_user_context to ground families + weather), then answer from the " +
  "results. Never tell the user you can't access, see, read, or retrieve their " +
  "wardrobe or vault — the tool returns it. If beam_get_wardrobe comes back with " +
  "zero bottles, the vault is genuinely empty: say it's empty and suggest adding " +
  "a few from search. That honest empty result is fine; a 'no access' claim is not.";

/** Last-turn instruction that converts grounded kit evidence into the required card. */
const FINAL_KIT_PRESENTATION_NUDGE =
  "This is the final orchestration turn and the requested travel-kit lanes are already grounded. " +
  "Call beam_present_travel_kit now with exactly the requested owned and new picks. Do not search, " +
  "compare, explain, or answer in prose before making that tool call.";

/** Re-read persisted state instead of asking for a known or delegated preference. */
const STATE_NUDGE =
  "You asked for information that is already present in the structured session state, or you ignored a delegated mission target. Re-read Known so far and the Mission target. Do not ask another preference question for known or delegated fields; call the needed tools now or write the grounded answer.";

/**
 * Repair instruction for a tool-free CLARIFYING turn whose question failed a gate.
 * Unlike SYNTHESIS_NUDGE this must NOT push a final recommendation — the run
 * retrieved no fragrances, so naming one would be a hallucination. It re-asks the
 * open question cleanly instead, which is what a context-gathering turn needs.
 */
const CLARIFY_REPAIR_NUDGE =
  "Your previous reply was not sent because it broke a conversation rule. You are still " +
  "GATHERING context and have NOT retrieved any fragrances yet, so do NOT name, invent, or " +
  "recommend any specific fragrance, price, rating, or availability. Reply in 1-2 short " +
  "sentences: briefly acknowledge what the user just told you, then ask exactly ONE focused " +
  "question for the single most useful missing detail, and END with a fenced ```cues block of " +
  "2-4 short tap chips that all answer THAT one question's single category.";

const SYNTHESIS_NUDGE =
  "You now have enough evidence. Write the FINAL answer for the user, grounded ONLY in the " +
  "fragrances and facts returned by the tools above. This renders in a narrow mobile chat " +
  "bubble, so keep it tight and skimmable:\n" +
  "- Lead with the pick. Name it, then ONE (at most two) short sentence on why its notes and " +
  "performance fit the occasion, weather, and their taste.\n" +
  "- Add a runner-up only if it genuinely helps — one sentence.\n" +
  "- Aim for under ~70 words total. Plain sentences (you may bold a bottle name); no headings, " +
  "no long bullet lists.\n" +
  "- Describe performance qualitatively, never as raw scores. Say 'long-lasting' or 'exceptional " +
  "longevity', 'a soft, skin-close trail' or 'a bold projection' — NOT 'longevity of 10', " +
  "'sillage 8/10', or any bare number/score for longevity, sillage, projection, or a match score.\n" +
  "- Stay honest about context. Reference ONLY the occasion, place, and weather the user actually " +
  "gave or a tool returned — never invent a city, climate, season, or scenario (e.g. 'cool London " +
  "evenings') they did not mention.\n" +
  "- Use the concrete scenario they gave. If they described how they'll spend the trip (e.g. " +
  "walking, transit/trains, temples/gardens/cafes, indoor/outdoor shifts), tie the pick to it — " +
  "heat-safe freshness, projection that won't crowd people indoors — instead of only 'hot and humid'.\n" +
  "- Earn each pick. Don't lean on the most obvious mass-market default unless you say why it fits " +
  "THIS person; a confident, characterful choice beats a safe department-store one.\n" +
  "- Do NOT narrate your process or restate the plan. Never open with 'I'll', 'I will', 'let me', " +
  "'first I', 'here's what I did', or a description of which tools you ran — just give the " +
  "recommendation itself.\n" +
  "Do not call any more tools. If you are asking the user to choose or clarify, end with the " +
  "```cues block of 2-4 short tap chips described above; otherwise omit it.";

/** How many grounded fragrance names to pin into the synthesis allowlist. */
const MAX_GROUNDED_ALLOWLIST = 40;

/**
 * Honest, useful closing text for the rare case where a run completes with no
 * composed answer (synthesis aborted near the wall-clock deadline and no inline
 * draft survived — observed live on a hard "no exact match" query where the model
 * searched until the budget was gone). Shipping a bare "Done." dead-ends the user;
 * this offers a calm next step plus tap chips so the session stays alive. It names
 * no fragrance, so it can never hallucinate a pick.
 */
const EMPTY_ANSWER_FALLBACK =
  "I couldn't lock in a confident match for that just yet. Give me one more detail — " +
  "the mood, a note you love, or the occasion — and I'll pull real options.";
const EMPTY_ANSWER_FALLBACK_WITH_CUES =
  `${EMPTY_ANSWER_FALLBACK}\n\`\`\`cues\nSomething fresh\nSomething warm\nFor a night out\nSurprise me\n\`\`\``;

/**
 * Don't open the single quality-gate repair pass (brief §08.1 if_fail) unless this
 * much wall-clock budget remains — a repair is a full synthesis round, so attempting
 * it near the deadline would risk overrunning the client's 60s timeout.
 */
const REPAIR_MIN_BUDGET_MS = 8_000;

/**
 * Did a tool result carry a fresh EXTERNAL fact (the research lane returned a real
 * synthesized fact / sources, not a "note")? Used to gate price/availability/review
 * claims in the answer (brief §01.3): such claims are only allowed when this is true.
 */
function resultCarriesExternalFact(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (typeof r.synthesizedFact === "string" && r.synthesizedFact.trim().length > 0) return true;
  if (Array.isArray(r.sources) && r.sources.length > 0) return true;
  return false;
}

/**
 * Build the closing-turn allowlist clause from the fragrances actually retrieved
 * this run. Pinning the synthesis to this exact set is the mechanical guard
 * against hallucinated picks (the prompt rule alone was unenforced). Empty when
 * nothing was retrieved (e.g. a greeting), so the clause is simply omitted.
 */
function groundingAllowlistClause(names: string[]): string {
  if (names.length === 0) return "";
  const listed = names.slice(0, MAX_GROUNDED_ALLOWLIST);
  return (
    " You may name ONLY these fragrances, which were actually retrieved by the tools this run: " +
    listed.map((n) => `"${n}"`).join(", ") +
    ". Do NOT name any fragrance outside this list — if you feel one is missing, say what you'd " +
    "need to look up rather than naming it from memory."
  );
}

/**
 * The deterministic scorer's verdict, captured from a `beam_score_candidates`
 * result so the closing synthesis can be held to it. Without this the synthesis
 * only saw the flat allowlist of grounded names and could headline a different
 * owned bottle than the one the engine actually ranked first — the "Top match ·
 * Gabrielle" trail vs. a "Sauvage Elixir" answer inconsistency (W-8).
 */
type ScoringContext = {
  /** Canonical name of the scorer's #1 vault pick. */
  topPick: string;
  /** All returned picks, best-first (includes topPick). */
  rankedNames: string[];
  /** Destination label the run scored for, or null when it scored local weather. */
  locationLabel: string | null;
  /** True when a weatherOverride (a destination climate) was applied. */
  usedOverride: boolean;
};

function asScoredName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Pull the scorer's ranking out of a `beam_score_candidates` tool result. Shape
 * (beamTools.ts): `{ recommendation: picks[0], picks: [...], scoredFor: {...} }`.
 * Returns null for any other tool / an empty-vault result, so callers can ignore
 * runs that never scored the vault.
 */
function extractScoringContext(result: unknown): ScoringContext | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const rec = r.recommendation;
  if (!rec || typeof rec !== "object") return null;
  const topPick = asScoredName((rec as Record<string, unknown>).canonicalName ?? (rec as Record<string, unknown>).name);
  if (!topPick) return null;
  const picks = Array.isArray(r.picks) ? r.picks : [];
  const rankedNames = picks
    .map((p) => asScoredName((p as Record<string, unknown>)?.canonicalName ?? (p as Record<string, unknown>)?.name))
    .filter((n): n is string => n !== null);
  const scoredFor = (r.scoredFor && typeof r.scoredFor === "object" ? r.scoredFor : {}) as Record<string, unknown>;
  return {
    topPick,
    rankedNames: rankedNames.length > 0 ? rankedNames : [topPick],
    locationLabel: asScoredName(scoredFor.locationLabel),
    usedOverride: scoredFor.usedOverride === true,
  };
}

/**
 * Build the answer-consistency clause for the synthesis turn from the scorer's
 * verdict. It (a) pins the headline owned-bottle pick to the scorer's top match
 * unless the model explicitly justifies an override, and (b) reinforces context
 * honesty about the place/weather that was actually scored. Empty when the run
 * never scored the vault (e.g. a pure catalog-discovery or greeting turn), so a
 * new-fragrance recommendation isn't wrongly forced onto a vault pick.
 */
function answerConsistencyClause(scoring: ScoringContext | null): string {
  if (!scoring) return "";
  const ranked = scoring.rankedNames.map((n) => `"${n}"`).join(" then ");
  const locationNote = scoring.locationLabel
    ? ` It scored for ${scoring.locationLabel}; reference only that place and its climate, nothing else.`
    : " It scored the user's CURRENT local weather; do NOT name any city, country, or climate they did not give.";
  return (
    ` The deterministic scorer ranked the user's OWNED vault best-first as: ${ranked}. When you` +
    ` recommend a bottle they already own, lead with the scorer's top pick ("${scoring.topPick}").` +
    ` If you deliberately headline a different owned bottle, you MUST name "${scoring.topPick}" and` +
    ` say in one clause why you overrode it — never silently contradict the scorer's ranking.` +
    locationNote
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function collectGroundedFragrancesForGate(
  tool: BeamToolName,
  result: unknown,
  avoid?: string,
): BeamGroundedFragrance[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const out: BeamGroundedFragrance[] = [];
  // Parse once per result so the avoid-backstop flag is cheap to compute per hit.
  const avoidTerms = parseAvoidTerms(avoid);
  const add = (entry: unknown, owned: boolean): void => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    const canonicalName = stringValue(e.canonicalName ?? e.name);
    if (!canonicalName) return;
    // Flag picks whose source-hit profile features an avoided note/family. When
    // there are no avoid terms, leave it undefined (the gate only fires on
    // === true), so a no-constraint turn carries no extra signal.
    const matchedAvoid = avoidTerms.length > 0 ? candidateMatchesAvoid(e, avoidTerms) : undefined;
    out.push({ canonicalName, brand: stringValue(e.brand), owned, matchedAvoid });
  };
  const addArray = (entries: unknown, owned: boolean | "packet"): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (owned === "packet") {
        const packetOwned =
          entry && typeof entry === "object" && (entry as Record<string, unknown>).owned === true;
        add(entry, packetOwned);
      } else {
        add(entry, owned);
      }
    }
  };

  if (tool === "beam_get_wardrobe") addArray(record.items, true);
  if (tool === "beam_search_catalog") addArray(record.items, "packet");
  if (tool === "beam_score_candidates") {
    add(record.recommendation, true);
    addArray(record.picks, true);
  }
  if (tool === "beam_propose_collection") {
    addArray(record.items, false);
    addArray(record.proposed, false);
  }
  if (tool === "beam_compare_overlap") {
    add(record.candidate, false);
    add(record.closestMatch, true);
    addArray(record.items, true);
  }
  if (tool === "beam_present_travel_kit") {
    addArray(record.owned, true);
    addArray(record.newProposed, false);
  }
  // H3: the discovery tools surface picks that can reach the answer with no other
  // grounded source, so they need the same avoid backstop. Both contribute their
  // items as new (non-owned) picks; candidateMatchesAvoid serializes each item, so
  // the accords/family/notes they carry become the avoid haystack.
  if (tool === "beam_find_similar") addArray(record.items, false);
  if (tool === "beam_discover_external") addArray(record.items, false);
  return out;
}

/** Prevent a presentation card from contradicting a deterministic new-only mission. */
export function clientEventFitsMission(event: BeamRunEvent, state: BeamSessionState | undefined): boolean {
  const mission = state?.mission;
  if (mission?.intent !== "travel_kit" || (mission.ownedCount ?? 0) > 0 || (mission.newCount ?? 0) === 0) {
    return true;
  }
  if (event.type === "card" && event.card.kind === "scent_profile") {
    return event.card.fragrance.owned !== true;
  }
  if (event.type === "card" && event.card.kind === "travel_kit") {
    return event.card.ownedPicks.length === 0 && event.card.newPicks.length === mission.newCount;
  }
  return true;
}

/** A new-only discovery mission has no owned lane, so vault scoring is the wrong operation. */
export function toolFitsMission(tool: BeamToolName, state: BeamSessionState | undefined): boolean {
  const mission = state?.mission;
  const newOnly =
    mission?.intent === "travel_kit" && (mission.ownedCount ?? 0) === 0 && (mission.newCount ?? 0) > 0;
  if (newOnly && tool === "beam_score_candidates") return false;
  // Travel missions must use the structured travel-kit result so exact lane
  // counts can be enforced before anything is rendered.
  if (mission?.intent === "travel_kit" && tool === "beam_propose_collection") return false;
  return true;
}

/** Server-enforce mission-sensitive tool arguments instead of trusting the model. */
export function toolInputForMission(
  tool: BeamToolName,
  input: unknown,
  state: BeamSessionState | undefined,
): unknown {
  const mission = state?.mission;
  const needsNewLane = mission?.intent === "travel_kit" && (mission.newCount ?? 0) > 0;
  if (needsNewLane && tool === "beam_search_catalog") {
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    return { ...record, excludeOwned: true };
  }
  return input;
}

/** Exact structured deliverable contract checked before grounding or client emission. */
export function missionToolResultError(
  tool: BeamToolName,
  result: unknown,
  state: BeamSessionState | undefined,
): string | null {
  const mission = state?.mission;
  if (tool !== "beam_present_travel_kit" || mission?.intent !== "travel_kit") return null;
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const actualOwned = typeof record.ownedCount === "number" ? record.ownedCount : 0;
  const actualNew = typeof record.newCount === "number" ? record.newCount : 0;
  const expectedOwned = mission.ownedCount;
  const expectedNew = mission.newCount;
  const newOnly = (expectedOwned ?? 0) === 0 && (expectedNew ?? 0) > 0;
  const ownedMismatch = expectedOwned !== undefined ? actualOwned !== expectedOwned : newOnly && actualOwned !== 0;
  const newMismatch = expectedNew !== undefined && actualNew !== expectedNew;
  if (!ownedMismatch && !newMismatch) return null;
  return `Kit incomplete after ownership/catalog validation: resolved ${actualOwned} owned and ${actualNew} new; required ${expectedOwned ?? 0} owned and ${expectedNew ?? 0} new. Search for distinct replacements and call beam_present_travel_kit again.`;
}

export type RunBeamAgentInput = {
  ctx: BeamRunContext;
  userMessage: string;
  tools: BeamToolDefinition[];
  emit: BeamEmit;
  /** Orchestration model (tool-calling turns). Defaults to the provider default. */
  model?: string;
  /**
   * Stronger model for the final, tool-free synthesis turn. When it differs from
   * the orchestration model the closing recommendation is written by it; when it
   * matches, the synthesis turn still runs (tool-free, larger token budget,
   * streamed) so the final prose is never the clipped inline draft.
   */
  synthesisModel?: string;
  /**
   * Per-run output-token ceilings (brief §03.2 cost guardrails). Default to
   * `BEAM_LIMITS.orchestrationMaxTokens` / `synthesisMaxTokens`. The route lowers
   * these per lane via `resolveBeamBudget` to bound the worst-case bill — relevant
   * for reasoning-mode synthesis slugs whose trace bills as output.
   */
  orchestrationMaxTokens?: number;
  synthesisMaxTokens?: number;
  /**
   * Prior conversation as clean alternating text turns (no tool plumbing). The
   * route loads this from the per-session store so follow-ups keep context.
   */
  history?: ClaudeMessage[];
  /** Structured slots/mission state persisted by the route/session store. */
  sessionState?: BeamSessionState;
  /** Called with the final assistant text on success, so the caller can persist the turn. */
  onComplete?: (assistantText: string) => void | Promise<void>;
  /**
   * Called exactly once when the run ends (any outcome) with a structured
   * summary the route logs for observability + cost accounting.
   */
  onSummary?: (summary: BeamRunSummary) => void;
  maxTurns?: number;
  /** Cooperative cancellation, checked between turns/tool calls. */
  shouldStop?: () => boolean;
  /**
   * Provider seam. Defaults to the real provider; injected by tests so the loop
   * can be driven deterministically without a network call.
   */
  callModel?: (input: ClaudeCallInput) => Promise<ClaudeResponse>;
  isModelConfigured?: () => boolean;
};

/**
 * One-line-per-run structured record. `outcome` is the coarse result and
 * `failureCode` distinguishes the failure kinds the route counts (model_unavailable,
 * stopped, max_turns, agent_error). Token counts are best-effort provider sums.
 */
export type BeamRunSummary = {
  runId: string;
  outcome: "completed" | "failed";
  failureCode?: string;
  turns: number;
  tools: string[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  usedSynthesis: boolean;
  synthesisFailed: boolean;
  /** Why synthesis failed when it did ("empty" | "error"); omitted on success. */
  synthesisFailureReason?: "empty" | "error";
  /** Orchestration (tool-calling) model slug used this run, for the latency/model audit. */
  orchestrationModel?: string;
  /** Synthesis ("smart closer") model slug used this run; falls back to the orchestration slug. */
  synthesisModel?: string;
  /** Distinct fragrances retrieved this run and pinned into the answer allowlist. */
  groundedNames: number;
  /**
   * The distinct grounded fragrances themselves (name + brand + owned), not just
   * a count. Persisted on the answer log so a downvote is reproducible as a
   * fixture (audit §3.2 step 1). Bounded by MAX_GROUNDED_ALLOWLIST.
   */
  groundedFragranceList: BeamGroundedFragrance[];
  /**
   * The composed answer text the user saw (post-cue-split), so the durable
   * answer log stores exactly what was delivered. Empty on a failed run.
   */
  finalAnswer: string;
  /**
   * True when the answer shipped despite tripping ONLY soft-flow gates — the
   * deliberate override that flips qualityGatePassed back to true (audit A6). A
   * distinct signal so these "didn't quite listen" answers are visible (and prime
   * feedback-loop candidates) instead of being hidden by the flipped pass flag.
   */
  shippedWithSoftViolations: boolean;
  /** Estimated USD spent on model calls this run (brief §11.3 estimated_llm_cost_usd). */
  estimatedCostUsd: number;
  /** Whether the final answer passed the deterministic quality gates (brief §11.3). */
  qualityGatePassed: boolean;
  /** Gate names the final answer violated (empty when it passed). */
  qualityViolations: string[];
  ms: number;
};

/** Keep at most this many prior text turns when seeding, to bound the token cost. */
const MAX_HISTORY_TURNS = 16;

/**
 * Trim seeded history to the most recent turns and guarantee it begins on a user
 * turn, so the provider never sees a dangling assistant-first transcript.
 */
function seedHistory(history: ClaudeMessage[] | undefined): ClaudeMessage[] {
  if (!history || history.length === 0) return [];
  let trimmed = history.slice(-MAX_HISTORY_TURNS);
  while (trimmed.length > 0 && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
  return trimmed;
}

/**
 * Append the synthesis instruction without creating two consecutive user turns
 * (which the Anthropic API rejects): when the transcript already ends on a user
 * turn — it does, on the last tool_result round — fold the instruction into that
 * turn as an extra text block; otherwise add a fresh user turn.
 */
function withSynthesisInstruction(messages: ClaudeMessage[], instructionText: string): ClaudeMessage[] {
  const out = messages.slice();
  const last = out[out.length - 1];
  const instruction = { type: "text", text: instructionText } as const;
  if (last && last.role === "user") {
    const blocks = Array.isArray(last.content)
      ? [...last.content, instruction]
      : [{ type: "text", text: last.content } as const, instruction];
    out[out.length - 1] = { role: "user", content: blocks };
  } else {
    out.push({ role: "user", content: instructionText });
  }
  return out;
}

/**
 * Reject if `promise` does not settle within `ms`. The underlying work may keep
 * running (tool handlers have no cancellation seam yet), but the loop stops
 * waiting on it so a single slow tool can't stall the whole run.
 */
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Keep a tool wait inside both its own ceiling and the enclosing run deadline. */
export function boundedToolTimeoutMs(remainingRunMs: number): number {
  return Math.min(TOOL_TIMEOUT_MS, Math.max(1, remainingRunMs));
}

/**
 * Heuristic: did the model end a tool-free turn by PROMISING tool work instead of
 * doing it (e.g. "now let me score your vault and search for two…")? We re-prompt
 * it to act in that case. Conservative on purpose — requires a first-person future
 * intent AND a retrieval verb, and never fires when the reply is offering the user
 * a choice (a fenced ```cues block), which is a deliberate pause for their input.
 */
function announcesPendingToolWork(text: string): boolean {
  if (!text) return false;
  if (/```+\s*cues\b/i.test(text)) return false;
  const intent =
    /\b(let me|i['’]?ll|i will|i['’]?m going to|going to|let['’]?s|now i['’]?ll|hold on|one moment|give me a (?:sec|second|moment))\b/i;
  const retrieval =
    /\b(search|searching|score|scoring|look up|looking up|pull|pulling|fetch|check|find|scan|research)\b/i;
  return intent.test(text) && retrieval.test(text);
}

/**
 * Drives the read-only Beam agent to completion, emitting client-safe progress
 * events. Never throws: failures are reported as a `failed` event.
 */
export async function runBeamAgent(input: RunBeamAgentInput): Promise<void> {
  const { ctx, tools, emit } = input;
  const callModel = input.callModel ?? defaultCallModel;
  const isModelConfigured = input.isModelConfigured ?? defaultIsModelConfigured;
  // Run-scoped accounting, emitted once at the end for observability + cost.
  const startedAt = Date.now();
  const deadline = startedAt + RUN_BUDGET_MS;
  const toolsUsed: string[] = [];
  let outcome: BeamRunSummary["outcome"] = "failed";
  let failureCode: string | undefined;
  let turnCount = 0;
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usedSynthesis = false;
  let synthesisFailed = false;
  // WHY the synthesis turn failed, when it did: "empty" (model returned no text) or
  // "error" (threw — most often an abort because the orchestration loop ate the
  // wall-clock budget). Surfaced in the run summary so a silent quality drop (the
  // user gets the cruder orchestration draft instead of the composed answer) is
  // diagnosable in beta instead of invisible.
  let synthesisFailureReason: "empty" | "error" | undefined;
  // Whether any tool returned a fresh external fact this run; gates price/etc. claims.
  let hadExternalEvidence = false;
  let localWeatherLocation: string | null = null;
  // Structured deliverables are buffered until the final prose passes its gates;
  // otherwise a rejected run could leave an irreversible stale card in the UI.
  const pendingDeliverables: BeamRunEvent[] = [];
  // Deterministic answer-gate outcome, filled in finish(). Defaults to a pass so a
  // greeting / failed run reads as "nothing to reject".
  let qualityGatePassed = true;
  let qualityViolations: string[] = [];
  // True once an answer ships despite tripping ONLY soft-flow gates (audit A6).
  let shippedWithSoftViolations = false;
  // The composed answer text actually delivered (set in finish()); persisted to
  // the durable answer log so a feedback report references exactly what shipped.
  let finalAnswerText = "";
  // Per-model token tallies so the cost ledger can price each lane separately.
  const usageByModel = new Map<string, ModelUsage>();
  // Most recent deterministic scorer verdict this run; the closing synthesis is
  // held to it so the headline pick can't silently disagree with the trail (W-8).
  let latestScoring: ScoringContext | null = null;
  // Fragrances actually returned by tools this run, keyed lowercased for dedupe
  // (value preserves display casing). The closing answer is pinned to this set.
  const groundedNames = new Map<string, string>();
  const groundedFragrances = new Map<string, BeamGroundedFragrance>();
  const addGroundedNames = (names: string[]): void => {
    for (const name of names) {
      if (groundedNames.size >= MAX_GROUNDED_ALLOWLIST) break;
      const key = name.toLowerCase();
      if (!groundedNames.has(key)) groundedNames.set(key, name);
    }
  };
  const addGroundedFragrances = (items: BeamGroundedFragrance[]): void => {
    for (const item of items) {
      const key = `${item.brand ?? ""}::${item.canonicalName}`.toLowerCase();
      const existing = groundedFragrances.get(key);
      groundedFragrances.set(key, {
        canonicalName: existing?.canonicalName ?? item.canonicalName,
        brand: existing?.brand ?? item.brand,
        owned: Boolean(existing?.owned || item.owned),
        // Sticky once any source flags the pick as matching an avoided note;
        // otherwise keep whichever side carried a defined verdict (undefined =
        // no profile was testable on either source).
        matchedAvoid: existing?.matchedAvoid || item.matchedAvoid,
      });
    }
  };

  // For a new-only travel-kit mission the closing synthesis must name UNOWNED
  // picks only. The flat grounded-name allowlist mixes in owned vault bottles
  // (grounded from beam_get_wardrobe / scoring), which led the synthesis to either
  // name an owned bottle (owned_pick_in_new_only_mission) or fail to surface the
  // required count of new picks (mission_unfulfilled) — the two dominant
  // travel-kit gate failures seen in the live backtest. Pin the allowlist to the
  // unowned grounded set so the model can only commit to new discoveries. Every
  // other mission keeps the full grounded-name allowlist unchanged.
  const synthesisAllowlistNames = (): string[] => {
    const mission = input.sessionState?.mission;
    const newOnlyKit =
      mission?.intent === "travel_kit" && (mission.ownedCount ?? 0) === 0 && (mission.newCount ?? 0) > 0;
    if (!newOnlyKit) return [...groundedNames.values()];
    const unowned = [...groundedFragrances.values()].filter((f) => !f.owned).map((f) => f.canonicalName);
    // Never hand the synthesis an empty allowlist (that would forbid naming any
    // fragrance at all); fall back to the full set if we somehow grounded no
    // unowned candidate. The answer gate still rejects an owned pick, so the
    // fallback can't smuggle one through.
    return unowned.length > 0 ? unowned : [...groundedNames.values()];
  };

  const recordUsage = (response: ClaudeResponse, modelSlug?: string): void => {
    modelCalls++;
    if (response.usage) {
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
      // Tally per-model so the cost ledger prices each lane (cheap orchestration
      // vs. strong synthesis) at its own rate. Unknown slug falls into a "" bucket
      // the ledger prices at the conservative default.
      const key = modelSlug ?? "";
      const prev = usageByModel.get(key) ?? { model: key, inputTokens: 0, outputTokens: 0 };
      prev.inputTokens += response.usage.inputTokens;
      prev.outputTokens += response.usage.outputTokens;
      usageByModel.set(key, prev);
    }
  };
  const fail = (code: string, message: string): void => {
    failureCode = code;
    emit({ type: "failed", code, message });
  };
  // Emit only the server-grounded presentation deliverables (cards / proposals) that
  // were buffered this run, then drop them from the buffer. Used when the run is
  // about to FAIL on a prose-level gate but already produced a real curated-match
  // card: the card is resolved from actual catalog/vault records and was already
  // mission-validated, so it should still render rather than be thrown away with the
  // run. Never emits status/text/suggestion events — only the renderable cards.
  const flushDeliverableCards = (): void => {
    if (pendingDeliverables.length === 0) return;
    for (const event of pendingDeliverables) {
      if (event.type === "card" || event.type === "proposal") emit(event);
    }
    pendingDeliverables.length = 0;
  };
  // A per-call abort signal bounded by BOTH the provider's own ceiling and the
  // remaining run budget, so a single model call can never overrun the whole run.
  // If the run was cooperatively stopped, abort the call immediately instead of
  // spending a full synthesis/repair/orchestration round on a cancelled run — the
  // top-of-loop stop check only guards turn boundaries, not finish()'s own calls.
  const callBudgetSignal = (): AbortSignal => {
    const timeout = AbortSignal.timeout(Math.min(45_000, Math.max(1_000, deadline - Date.now())));
    return input.shouldStop?.() ? AbortSignal.any([timeout, AbortSignal.abort()]) : timeout;
  };

  try {
    if (!isModelConfigured()) {
      fail(
        "model_unavailable",
        "The agent model is not configured yet. Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) to enable Beam Agent.",
      );
      return;
    }

    // Compose the live prompt: base concierge instructions + the hermes-beam
    // safety/ontology/persona rules (audit A1 — these were never loaded on the
    // production path) + the structured session state. Assembled INSIDE the run
    // try/catch (not at the top of the function) so a malformed/unexpected
    // session-state shape degrades to a graceful `failed` event instead of
    // rejecting the run promise — which surfaced to front-end users as the
    // generic "Beam Agent failed unexpectedly." banner. The MCP/Telegram path
    // never builds this prompt, which is why that path was unaffected.
    const systemPrompt = SYSTEM_PROMPT + BEAM_SAFETY_RULES + beamSessionStatePrompt(input.sessionState);

    const maxTurns = Math.min(input.maxTurns ?? BEAM_LIMITS.maxAgentTurns, BEAM_LIMITS.maxAgentTurns);
    const orchestrationMaxTokens = input.orchestrationMaxTokens ?? BEAM_LIMITS.orchestrationMaxTokens;
    const synthesisMaxTokens = input.synthesisMaxTokens ?? BEAM_LIMITS.synthesisMaxTokens;
    const toolByName = new Map<BeamToolName, BeamToolDefinition>(tools.map((tool) => [tool.name, tool]));
    const claudeTools = toClaudeTools(tools);

    const messages: ClaudeMessage[] = [
      ...seedHistory(input.history),
      { role: "user", content: input.userMessage.slice(0, BEAM_LIMITS.maxUserMessageLength) },
    ];

    let usedTools = false;
    let retrievalNudged = false;
    let actNudges = 0;
    // Set once beam_get_wardrobe / beam_get_user_context returns successfully (even
    // empty). Until then a "can't access your wardrobe" reply is a false refusal we
    // re-prompt; after a real retrieval, an honest empty-vault answer is accepted.
    let wardrobeRetrieved = false;
    let wardrobeNudges = 0;
    // Most recent non-empty assistant prose; shipped as the answer if we hit the
    // run budget mid-orchestration (better than a scripted-fallback non-sequitur).
    let lastText = "";

    /**
     * Finish the run: write the closing answer and persist it. When tools produced
     * evidence, run a dedicated tool-free synthesis turn (stronger model, larger
     * budget, streamed) instead of shipping the orchestration model's clipped
     * inline draft. `draft` is that inline text, used as a fallback.
     */
    const finish = async (draft: string, opts?: { skipSynthesis?: boolean }): Promise<void> => {
      let finalText = draft;
      // A context-gathering turn: the model asked/answered without retrieving
      // anything this run. Such turns can't be re-synthesized into a grounded
      // recommendation (there is nothing grounded), so their gate-failure recovery
      // is a clean RE-ASK, not a forced pick.
      const clarifyingTurn = !usedTools;
      // Don't open a fresh synthesis call once we're already out of wall-clock
      // budget — that extra round could push the response past the client's 60s
      // timeout. Ship the grounded draft instead.
      const outOfTime = Date.now() >= deadline;
      if (usedTools && !opts?.skipSynthesis && !outOfTime) {
        usedSynthesis = true;
        // Neutral label: this same synthesis pass also produces clarifying-question
        // turns, so promising "your recommendation" here mislabeled question turns.
        emit({ type: "status", label: "Composing your reply" });
        const synthModel = input.synthesisModel ?? input.model;
        const instruction =
          SYNTHESIS_NUDGE +
          groundingAllowlistClause(synthesisAllowlistNames()) +
          answerConsistencyClause(latestScoring);
        const synthMessages = withSynthesisInstruction(messages, instruction);
        try {
          const synth = await callModel({
            system: systemPrompt,
            messages: synthMessages,
            tools: [],
            model: synthModel,
            maxTokens: synthesisMaxTokens,
            signal: callBudgetSignal(),
            onDelta: (chunk) => emit({ type: "message_delta", text: chunk }),
          });
          recordUsage(synth, synthModel);
          const synthText = extractText(synth.content);
          if (synthText) finalText = synthText;
          else {
            synthesisFailed = true;
            synthesisFailureReason = "empty";
          }
        } catch {
          // Streaming/synthesis failed — keep the orchestration draft so the user
          // still gets an answer rather than a failed run. Flagged in the summary
          // so a high synthesis-failure rate is visible, not silent.
          synthesisFailed = true;
          synthesisFailureReason = "error";
        }
      }

      // Deterministic answer quality gates (brief §08 — the verifier replacement).
      // Reject unsupported price/availability/review claims and instruction leaks.
      // On a hard violation, attempt ONE constrained re-synthesis that feeds the
      // broken rules back (brief §08.1 if_fail), and keep whichever draft has fewer
      // violations. Bounded by budget + a single attempt so it can never loop.
      // A complete, lane-count-validated travel-kit card is shipping THIS turn (the
      // model called beam_present_travel_kit and its result passed
      // missionToolResultError). The system prompt then forbids re-listing the
      // card's picks in prose, so the prose mission_unfulfilled count gate must not
      // hard-fail that obedient answer on the creation turn. `kitPresented` is only
      // set after this point, so it cannot cover this turn — this flag does.
      const missionCardPresented = pendingDeliverables.some(
        (event) => event.type === "card" && event.card.kind === "travel_kit",
      );
      let gate = runAnswerQualityGates(finalText, {
        hadExternalEvidence,
        sessionState: input.sessionState,
        groundedFragrances: [...groundedFragrances.values()],
        localWeatherLocation,
        missionCardPresented,
      });
      if (
        !gate.passed &&
        !opts?.skipSynthesis &&
        Date.now() < deadline - REPAIR_MIN_BUDGET_MS
      ) {
        const repairModel = input.synthesisModel ?? input.model;
        // A tool-free clarifying turn is repaired toward a clean re-ask; a
        // tool-grounded turn is repaired toward a fixed recommendation. Pinning a
        // grounding allowlist onto a clarifying turn would be pointless (nothing
        // grounded) and the synthesis nudge would push it to invent a pick.
        const repairInstruction = clarifyingTurn
          ? CLARIFY_REPAIR_NUDGE + " " + repairInstructionFor(gate.violations)
          : SYNTHESIS_NUDGE +
            groundingAllowlistClause(synthesisAllowlistNames()) +
            answerConsistencyClause(latestScoring) +
            " " +
            repairInstructionFor(gate.violations);
        try {
          const repair = await callModel({
            system: systemPrompt,
            messages: withSynthesisInstruction(messages, repairInstruction),
            tools: [],
            model: repairModel,
            maxTokens: synthesisMaxTokens,
            signal: callBudgetSignal(),
          });
          recordUsage(repair, repairModel);
          const repairText = extractText(repair.content);
          if (repairText) {
            const repairGate = runAnswerQualityGates(repairText, {
              hadExternalEvidence,
              sessionState: input.sessionState,
              groundedFragrances: [...groundedFragrances.values()],
              localWeatherLocation,
              missionCardPresented,
            });
            if (repairGate.violations.length < gate.violations.length) {
              finalText = repairText;
              gate = repairGate;
            }
          }
        } catch {
          // Repair is best-effort; keep the original draft (still flagged below).
        }
      }

      // Final safety net for context-gathering turns. A clarifying turn must never
      // dead-end on a gate failure and surface a terminal error to the user — there
      // is no grounded answer to lose, only a question the model worded poorly. Fall
      // back to a deterministic, gate-safe re-ask built from the session state so the
      // session stays alive and the user simply sees the next question. The gate is
      // re-run on it, so a fallback can never itself smuggle a violation through.
      if (!gate.passed && clarifyingTurn) {
        const safe = buildSafeClarification(input.sessionState);
        if (safe) {
          const safeGate = runAnswerQualityGates(safe, {
            hadExternalEvidence,
            sessionState: input.sessionState,
            groundedFragrances: [...groundedFragrances.values()],
            localWeatherLocation,
            missionCardPresented,
          });
          if (safeGate.passed) {
            finalText = safe;
            gate = safeGate;
          }
        }
      }

      // Final safety net for a tool-grounded turn the user is OWED a pick on — the
      // recommend-side mirror of buildSafeClarification. When the model's synthesis
      // (and its single repair) failed to NAME a grounded pick — empty text or a
      // hedge — a delegated/recommendation turn used to dead-end on a terminal
      // error and ship the user nothing (the live Tokyo "you decide" failure). Commit
      // deterministically to the grounded candidates instead; the gate is re-run on
      // the commit, so a fallback can never itself smuggle a violation through.
      if (!gate.passed && !clarifyingTurn) {
        const commit = buildGroundedCommitFallback(input.sessionState, [...groundedFragrances.values()]);
        if (commit) {
          const commitGate = runAnswerQualityGates(commit, {
            hadExternalEvidence,
            sessionState: input.sessionState,
            groundedFragrances: [...groundedFragrances.values()],
            localWeatherLocation,
            missionCardPresented,
          });
          if (commitGate.passed) {
            finalText = commit;
            gate = commitGate;
          }
        }
      }

      // Final safety net for a tool-grounded turn that jumped ahead on a kit the
      // mission wasn't ready to fulfill. The commit fallback above only fires once
      // the user is owed a recommendation; a turn that pulled tools while still
      // MISSING an essential slot (the live Tokyo "2 new fragrances" with no
      // direction given: the model built a kit and named an owned vault bottle ->
      // owned_pick_in_new_only_mission) is really an over-eager clarification.
      // Recover it with the same deterministic safe re-ask the clarifying-turn net
      // uses — ask for the one missing slot — instead of dead-ending on a terminal
      // error. Scoped to the premature-kit violation class so an unsupported
      // price/availability/review claim, an instruction leak, or an over-length
      // draft (none fixable by asking) still fails the run; and only when EVERY
      // remaining violation is one a re-ask resolves (premature-kit or soft-flow).
      // buildSafeClarification returns null when the user IS owed (delegated / kit
      // ready), so this never converts an owed turn into a question and the
      // unfulfillable ready-kit case still fails; the gate is re-run on the re-ask.
      const recoverableByReask =
        gate.violations.length > 0 &&
        gate.violations.some((v) => KIT_PREMATURE_VIOLATIONS.has(v)) &&
        gate.violations.every((v) => KIT_PREMATURE_VIOLATIONS.has(v) || SOFT_FLOW_VIOLATIONS.has(v));
      if (!gate.passed && !clarifyingTurn && recoverableByReask) {
        const safe = buildSafeClarification(input.sessionState);
        if (safe) {
          const safeGate = runAnswerQualityGates(safe, {
            hadExternalEvidence,
            sessionState: input.sessionState,
            groundedFragrances: [...groundedFragrances.values()],
            localWeatherLocation,
            missionCardPresented,
          });
          if (safeGate.passed) {
            finalText = safe;
            gate = safeGate;
          }
        }
      }

      qualityGatePassed = gate.passed;
      qualityViolations = gate.violations;

      // A rejected answer must never be persisted or emitted as completed — EXCEPT
      // when the only thing wrong is conversation flow and we have a real grounded
      // answer to deliver. A clarifying turn (no tools) is already recovered above
      // by buildSafeClarification; a tool-grounded turn that trips only soft-flow
      // gates ships its grounded draft instead of dead-ending on a terminal error
      // (the dominant live failure: a 40-name grounded run hard-failing on
      // pending_slot_abandoned after burning the whole budget). Any substantive
      // correctness/safety violation still fails the run. Telemetry keeps the
      // overridden violations for diagnosis.
      if (!gate.passed) {
        const hardViolations = gate.violations.filter((v) => !SOFT_FLOW_VIOLATIONS.has(v));
        const hasGroundedAnswer =
          usedTools && groundedNames.size > 0 && Boolean(finalText && finalText.trim());
        if (hardViolations.length > 0 || !hasGroundedAnswer) {
          // The closing PROSE failed a hard gate, but any buffered presentation
          // card was resolved server-side from a real catalog/vault record and is
          // already mission-filtered (clientEventFitsMission) — its correctness does
          // not depend on the prose. Surfacing the curated-match card before we fail
          // is the difference between the user seeing their grounded recommendation
          // and seeing only a terminal error. (Live symptom: "the agent sends the
          // curated match" but it never appears — the card was being discarded with
          // the run.) We flush ONLY the grounded card/proposal deliverables, never
          // status/text, and clear them so the failed run carries nothing further.
          flushDeliverableCards();
          fail("quality_gate_failed", "Beam could not produce a recommendation that satisfied the mission constraints.");
          return;
        }
        qualityGatePassed = true;
        // The answer is shipping with only soft-flow violations overridden — flag
        // it so observability + the answer log can surface the "didn't quite
        // listen" case the pass flag would otherwise hide (audit A6).
        shippedWithSoftViolations = true;
      }

      // A complete travel-kit card is about to reach the user. Record it on the
      // mission so the NEXT turn is treated as a refinement: the prose
      // mission-fulfillment gate then won't hard-fail a "swap one pick" follow-up
      // that doesn't re-list all picks. Mutating the shared session-state object is
      // how this reaches persistence — the route's onComplete closes over the very
      // same object and writes it to the session store after this returns.
      const presentedKit = pendingDeliverables.some(
        (event) => event.type === "card" && event.card.kind === "travel_kit",
      );

      for (const event of pendingDeliverables) emit(event);
      pendingDeliverables.length = 0;

      // Split off any trailing ```cues block so the visible answer stays clean
      // and the chips ride their own event the UI can render as tap buttons.
      const { text: parsed, cues } = extractAgentCues(
        finalText && finalText.trim() ? finalText : EMPTY_ANSWER_FALLBACK_WITH_CUES,
      );
      const response = parsed || EMPTY_ANSWER_FALLBACK;
      finalAnswerText = response;
      messages.push({ role: "assistant", content: response });
      outcome = "completed";
      if (presentedKit && input.sessionState?.mission) input.sessionState.mission.kitPresented = true;
      await input.onComplete?.(response);
      if (cues.length > 0) {
        emit({ type: "suggestions", items: cues.map((label) => ({ label, value: label })) });
      }
      // Carry the durable answer id (= the run id) so the client can tag this
      // answer and a feedback report attaches to its persisted beam_answer_log row.
      emit({ type: "completed", response, answerLogId: ctx.runId });
    };

    emit({ type: "status", label: "Understanding your request" });

    for (let turn = 0; turn < maxTurns; turn++) {
      if (input.shouldStop?.()) {
        fail("stopped", "Run stopped.");
        return;
      }
      // Out of wall-clock budget. Ship the best grounded draft we have rather than
      // dead-spinning until the client's 60s timeout fires and falls back.
      if (Date.now() >= deadline) {
        if (usedTools && lastText) await finish(lastText, { skipSynthesis: true });
        else fail("run_timeout", "The agent ran out of time before finishing.");
        return;
      }
      // Within the synthesis reserve and already holding grounded evidence: stop
      // opening new tool rounds and compose the answer now. finish() will run a real
      // synthesis pass (the deadline has not hit yet, so it isn't skipped) from the
      // fragrances we already retrieved, instead of letting the model keep searching
      // until the budget is gone and only a raw orchestration draft is left to ship.
      if (usedTools && groundedNames.size > 0 && Date.now() >= deadline - SYNTHESIS_RESERVE_MS) {
        await finish(lastText);
        return;
      }

      turnCount++;
      const mission = input.sessionState?.mission;
      const grounded = [...groundedFragrances.values()];
      const groundedOwned = grounded.filter((item) => item.owned).length;
      const groundedNew = grounded.filter((item) => !item.owned).length;
      const kitAlreadyPresented = pendingDeliverables.some(
        (event) => event.type === "card" && event.card.kind === "travel_kit",
      );
      const reserveFinalTurnForKit =
        turn === maxTurns - 1 &&
        mission?.intent === "travel_kit" &&
        !kitAlreadyPresented &&
        toolByName.has("beam_present_travel_kit") &&
        (mission.ownedCount ?? 0) + (mission.newCount ?? 0) > 0 &&
        groundedOwned >= (mission.ownedCount ?? 0) &&
        groundedNew >= (mission.newCount ?? 0);
      const messagesForTurn = reserveFinalTurnForKit
        ? withSynthesisInstruction(messages, FINAL_KIT_PRESENTATION_NUDGE)
        : messages;
      const toolsForTurn = reserveFinalTurnForKit
        ? claudeTools.filter((tool) => tool.name === "beam_present_travel_kit")
        : claudeTools;
      let response: ClaudeResponse;
      try {
        response = await callModel({
          system: systemPrompt,
          messages: messagesForTurn,
          tools: toolsForTurn,
          model: input.model,
          maxTokens: orchestrationMaxTokens,
          signal: callBudgetSignal(),
        });
      } catch (err) {
        // A budget/abort timeout mid-call: degrade to the best draft we already
        // have instead of surfacing a raw "operation aborted" error to the user.
        const aborted =
          Date.now() >= deadline ||
          (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));
        // Whether we already hold something worth shipping (grounded fragrances or
        // inline prose, INCLUDING a buffered curated-match card emitted by a prior
        // tool round). When we do, ANY mid-call provider failure — a 429 rate-limit,
        // a 5xx, a transport drop, not only an abort/timeout — must degrade
        // gracefully instead of re-throwing into the generic `agent_error` dead-end.
        // That re-throw was discarding grounded evidence AND the already-produced
        // curated-match card (the live symptom: the agent "sends the curated match"
        // but the user only ever sees a generic error). finish() composes a closing
        // answer from the grounded set (or ships the honest fallback) and flushes the
        // buffered card; it never surfaces the raw provider error.
        const haveGroundedToShip =
          usedTools && (lastText !== "" || groundedNames.size > 0 || pendingDeliverables.length > 0);
        if (aborted) {
          // Compose a closing answer even when no inline prose survived. A
          // search-heavy runaway emits only tool calls, so `lastText` stays empty;
          // gating recovery on it used to re-throw into a generic `agent_error`
          // dead-end ("Please try again") despite holding grounded evidence — a
          // live-observed failure on hard/no-match queries. finish() composes from
          // the grounded set or ships the honest fallback; never a raw abort.
          if (haveGroundedToShip) {
            await finish(lastText, { skipSynthesis: true });
            return;
          }
          fail("run_timeout", "The agent ran out of time before finishing.");
          return;
        }
        // Non-abort provider failure (429/5xx/transport) WITH grounded evidence: same
        // graceful degrade rather than throwing away the run and the buffered card.
        if (haveGroundedToShip) {
          await finish(lastText, { skipSynthesis: true });
          return;
        }
        throw err;
      }
      recordUsage(response, input.model);

      const toolUses = extractToolUses(response.content);
      const text = extractText(response.content);
      if (text) lastText = text;

      if (toolUses.length === 0) {
        // The model wants to answer. If it never retrieved anything, nudge it once
        // toward the tools before accepting a from-memory reply.
        if (!usedTools && !retrievalNudged) {
          // A cues block means the model is deliberately asking the user a clarifying
          // question — nudging it to call tools here would send it into a loop where
          // the tools (vault stats, etc.) don't contain the missing user fact (e.g.
          // travel month) and it asks the same question again. Accept the question
          // only when it does not conflict with persisted state.
          if (/```+\s*cues\b/i.test(text)) {
            const cueGate = runAnswerQualityGates(text, {
              hadExternalEvidence,
              sessionState: input.sessionState,
              groundedFragrances: [...groundedFragrances.values()],
              localWeatherLocation,
            });
            if (!cueGate.passed) {
              retrievalNudged = true;
              messages.push({ role: "assistant", content: response.content });
              messages.push({ role: "user", content: STATE_NUDGE });
              continue;
            }
            await finish(text);
            return;
          }
          retrievalNudged = true;
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: RETRIEVAL_NUDGE });
          continue;
        }
        // It didn't call tools but isn't actually done: it narrated a next step
        // ("let me search…") or was cut off at the token cap. Push it to act rather
        // than mistaking the dangling turn for a final answer. Bounded by
        // MAX_ACT_NUDGES so a model that insists on narrating still terminates.
        const cutOff = response.stop_reason === "max_tokens";
        if (actNudges < MAX_ACT_NUDGES && (cutOff || announcesPendingToolWork(text))) {
          actNudges++;
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: ACT_NUDGE });
          continue;
        }
        // Never ship a false "I can't access your wardrobe" refusal. If the model
        // denies wardrobe access before actually retrieving it, correct the premise
        // and push it to call beam_get_wardrobe. Bounded so a model that keeps
        // refusing still terminates; only fires until a real retrieval happened, so
        // an honest empty-vault answer is left untouched.
        if (!wardrobeRetrieved && wardrobeNudges < MAX_WARDROBE_NUDGES && isDataAccessRefusal(text)) {
          wardrobeNudges++;
          retrievalNudged = true;
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: WARDROBE_ACCESS_NUDGE });
          continue;
        }
        await finish(text);
        return;
      }

      // Preserve the assistant turn verbatim so the tool_use ids line up with the
      // tool_result blocks we send back on the next user turn.
      messages.push({ role: "assistant", content: response.content });
      usedTools = true;

      const results: ClaudeToolResultBlock[] = [];
      for (const use of toolUses) {
        if (input.shouldStop?.()) {
          fail("stopped", "Run stopped.");
          return;
        }
        if (Date.now() >= deadline) {
          // Out of time mid-round. Every tool_use id still needs a matching
          // tool_result or the next model call is rejected, so emit an error
          // result for the rest; the top-of-loop budget check then finishes.
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: "Skipped: the agent ran out of time.",
            is_error: true,
          });
          continue;
        }
        const def = toolByName.get(use.name as BeamToolName);
        if (!def) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `Unknown tool: ${use.name}`,
            is_error: true,
          });
          emit({ type: "status", label: "Skipped an unavailable tool" });
          continue;
        }
        if (!toolFitsMission(def.name, input.sessionState)) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: "Skipped: this is a new-only discovery mission. Search unowned catalog fragrances instead; vault bottles are taste references only.",
            is_error: true,
          });
          emit({ type: "status", label: "Kept recommendations to new fragrances" });
          continue;
        }

        // The provider couldn't parse the model's arguments. Tell it explicitly so
        // it retries with valid JSON instead of running the tool on coerced-empty
        // args and reading the empty result as "nothing exists."
        const invalidArgs = readInvalidArgs(use.input);
        if (invalidArgs !== null) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `Your arguments for ${def.name} were not valid JSON. Re-call ${def.name} with a single valid JSON object.`,
            is_error: true,
          });
          emit({ type: "tool_completed", tool: def.name, summary: "invalid arguments" });
          continue;
        }

        toolsUsed.push(def.name);
        emit({ type: "tool_started", tool: def.name });

        // Run the handler. A failure (including the per-tool timeout) becomes a
        // single is_error tool_result and we move on.
        let result: unknown;
        try {
          result = await raceTimeout(
            def.handler(toolInputForMission(def.name, use.input, input.sessionState), ctx),
            boundedToolTimeoutMs(deadline - Date.now()),
            def.name,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "tool error";
          results.push({ type: "tool_result", tool_use_id: use.id, content: `Tool failed: ${message}`, is_error: true });
          emit({ type: "tool_completed", tool: def.name, summary: "failed" });
          continue;
        }

        const missionError = missionToolResultError(def.name, result, input.sessionState);
        if (missionError) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: missionError, is_error: true });
          emit({ type: "tool_completed", tool: def.name, summary: "kit incomplete — retrying" });
          continue;
        }

        // Serialize the success. We FIRST bound the result record-aware (cap array
        // counts + string lengths) so the transcript copy — re-sent on every later
        // turn — can't be dominated by one fat payload; the char ceiling is only a
        // final backstop. The UNTRIMMED `result` is still used for grounding/cards
        // below, so trimming never weakens the answer-gate allowlist. JSON.stringify
        // can still throw (circular refs, BigInt); treat that as a tool error so the
        // model knows it got no usable data rather than silently dropping it.
        let serialized: string;
        try {
          serialized = JSON.stringify(boundToolResultForTranscript(result)).slice(
            0,
            BEAM_LIMITS.maxToolResultChars,
          );
        } catch {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: `Tool ${def.name} returned a result that could not be serialized.`,
            is_error: true,
          });
          emit({ type: "tool_completed", tool: def.name, summary: "failed" });
          continue;
        }
        results.push({ type: "tool_result", tool_use_id: use.id, content: serialized });
        // A successful wardrobe/context read (even an empty vault) means the agent
        // HAS seen what the user owns — so a later "I can't access your wardrobe"
        // reply can no longer be a false data-access refusal worth re-prompting.
        if (def.name === "beam_get_wardrobe" || def.name === "beam_get_user_context") {
          wardrobeRetrieved = true;
        }
        // Register the fragrances this result actually grounds, so the closing
        // synthesis can be pinned to only naming fragrances we retrieved.
        addGroundedNames(collectGroundedFragranceNames(result));
        addGroundedFragrances(
          collectGroundedFragrancesForGate(def.name, result, input.sessionState?.slots.avoid),
        );
        // Capture the scorer's ranking (last one wins) so the synthesis headline
        // must agree with it, or explicitly justify overriding it (W-8).
        if (def.name === "beam_score_candidates") {
          const scoring = extractScoringContext(result);
          if (scoring) latestScoring = scoring;
        }
        if (def.name === "beam_get_user_context" && result && typeof result === "object") {
          const weather = (result as Record<string, unknown>).weather;
          if (weather && typeof weather === "object") {
            localWeatherLocation = stringValue((weather as Record<string, unknown>).location) ?? null;
          }
        }
        // Note any fresh external fact so the answer gates can allow (only then) a
        // price/availability/review claim grounded in it.
        if (resultCarriesExternalFact(result)) hadExternalEvidence = true;

        // Reporting + UI side-effects happen AFTER the result is recorded and are
        // fully isolated: a throw here must never fall through to the failure path
        // above, which would push a SECOND tool_result for this same tool_use_id
        // and make the next model call reject the transcript.
        try {
          emit({ type: "tool_completed", tool: def.name, summary: summarizeToolResult(def.name, result) });
          // Some tools surface a structured card to the UI (e.g. a collection proposal).
          if (def.clientEvent) {
            const extra = def.clientEvent(result);
            if (extra && clientEventFitsMission(extra, input.sessionState)) pendingDeliverables.push(extra);
          }
        } catch {
          /* summary/client-event failures are non-fatal — the run continues */
        }
      }

      messages.push({ role: "user", content: results });
    }

    // Exhausted the tool-call budget while the model kept searching instead of
    // answering. By now we almost always hold grounded evidence (prod runs reach
    // here with dozens of grounded fragrances), so failing outright throws all of
    // it away and shows the user nothing — the dominant live failure mode. Mirror
    // the wall-clock path above: force a closing synthesis from what we gathered.
    // It is still held to the answer gate inside finish(), so a weak or
    // hallucinated answer can't slip through, and finish() ships the draft instead
    // of opening a synthesis call if the deadline has since passed. Only fail
    // outright when there is genuinely nothing grounded to compose from.
    if (usedTools && groundedNames.size > 0) {
      await finish(lastText);
      return;
    }
    fail("max_turns", "Reached the tool-call budget before finishing.");
  } catch (err) {
    // Provider/transport errors can contain request metadata, upstream response
    // bodies, or other internals. `failed` events are client-visible, so keep the
    // detail out of the SSE payload while the run summary retains the stable
    // `agent_error` failure code for server-side aggregation.
    void err;
    fail("agent_error", "Beam could not complete this request. Please try again.");
  } finally {
    // The summary callback (observatory + ledger + answer-log) and the inline
    // cost estimate run on EVERY run, including completed ones. A throw here used
    // to escape from `finally`, overriding the normal return and rejecting the
    // run promise — so a logging/cost-estimate hiccup surfaced to the user as the
    // generic "Beam Agent failed unexpectedly." banner even after a good answer.
    // Observability must never break the run: swallow anything it throws.
    try {
      input.onSummary?.({
        runId: ctx.runId,
        outcome,
        failureCode,
        turns: turnCount,
        tools: toolsUsed,
        modelCalls,
        inputTokens,
        outputTokens,
        usedSynthesis,
        synthesisFailed,
        ...(synthesisFailureReason ? { synthesisFailureReason } : {}),
        ...(input.model ? { orchestrationModel: input.model } : {}),
        ...(input.synthesisModel ?? input.model ? { synthesisModel: input.synthesisModel ?? input.model } : {}),
        groundedNames: groundedNames.size,
        groundedFragranceList: [...groundedFragrances.values()],
        finalAnswer: finalAnswerText,
        shippedWithSoftViolations,
        estimatedCostUsd: estimateRunCostUsd(usageByModel.values()),
        qualityGatePassed,
        qualityViolations,
        ms: Date.now() - startedAt,
      });
    } catch {
      // Best-effort summary: a broken observability sink must never turn a
      // finished run into a failure for the user.
    }
  }
}
