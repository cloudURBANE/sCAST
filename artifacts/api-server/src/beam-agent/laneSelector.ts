/**
 * Beam Agent — deterministic concierge lane selector (brief §03.1–§03.2).
 *
 * The cost-optimized stack reserves the pricier MiniMax M3 lane for long /
 * multi-turn / nuanced work and runs the cheap MiniMax M2.5 lane for everything
 * else. The brief models this as a router; we do it WITHOUT an extra router LLM
 * call on the hot path — a small, pure heuristic over signals already available
 * at the route (the user message + how many prior turns the session carries).
 * That keeps routing free and deterministic while honoring the rules:
 *   - "never use deep/expensive model for a simple lookup" (§03.1)
 *   - escalate on nuanced tone, trip/collection/audit, layered strategy (§03.2)
 *
 * Deep (Kimi) is intentionally NOT selectable here: it stays gated behind the
 * research lane (brief §14.2 "do not call Kimi for normal fragrance chat").
 */
export type ConciergeLane = "default" | "premium";

export type LaneSignals = {
  /** The raw user message for this turn. */
  message: string;
  /** Number of prior text turns already in the session (user + assistant). */
  historyTurns?: number;
  /**
   * The active session mission intent, if one is already established. A
   * mid-mission follow-up message ("Green and tea") often carries no premium
   * keyword and is short, so message-only routing would drop it to the cheap
   * lane mid-plan and starve the multi-step trip work (prod Run 2). The mission
   * intent is the durable signal the per-turn message lacks — thread it in.
   */
  activeMissionIntent?: "travel_kit" | "recommendation";
};

/**
 * Premium-lane triggers (brief §03.2 use_minimax_m3_if): genuinely multi-step or
 * strategic work — trip / collection kits, redundancy/audit logic, wardrobe
 * optimization, layering and purchase strategy. Kept as word-boundary patterns so
 * "audit" matches but "auditorium" does not.
 *
 * Deliberately NOT triggers: everyday one-shot asks like "date night" and
 * "signature scent". Those are the bread-and-butter of fragrance chat and don't
 * need premium orchestration; escalating them just sent routine traffic to the
 * pricier tier. They fall through to the cheap default lane (and the closing
 * synthesis turn still runs the strong model regardless of lane).
 */
const PREMIUM_PATTERNS: RegExp[] = [
  /\bcollection audit\b/i,
  /\baudit\b/i,
  /\bredundan(?:t|cy)\b/i,
  /\b(?:wardrobe|collection)\s+optimi[sz]/i,
  /\btrip\b/i,
  /\btravel(?:ing|ling)?\b/i,
  /\bkit\b/i,
  /\bpacking\b/i,
  /\blayer(?:ing|ed)?\b/i,
  /\bpurchase strategy\b/i,
  /\bcapsule\b/i,
];

/**
 * Above this many prior turns a session is "deep enough" to justify the premium
 * lane regardless of the latest message (brief §03.2 conversation_context proxy).
 * Eight turns ≈ four exchanges — a genuinely multi-turn planning session.
 */
const PREMIUM_HISTORY_TURNS = 8;

/**
 * A very long single message also escalates: it carries enough context/constraints
 * that the cheaper lane tends to flatten it (brief §03.2 conversation_context_tokens).
 */
const PREMIUM_MESSAGE_CHARS = 600;

/** Pick the concierge lane for a turn. Pure; safe to call with any input. */
export function selectConciergeLane(signals: LaneSignals): ConciergeLane {
  const message = typeof signals.message === "string" ? signals.message : "";
  const historyTurns = Number.isFinite(signals.historyTurns) ? (signals.historyTurns as number) : 0;

  // An active trip/kit mission is premium-worthy for its whole lifetime: it is
  // the genuinely multi-step "trip / collection kit" work §03.2 escalates on,
  // and the keyword that established it ("trip kit for Tokyo") lives in an
  // earlier turn, not the current short follow-up. Only travel_kit forces the
  // premium lane — a plain "recommendation" mission is routine fragrance chat
  // that still routes by message/history like everything else.
  if (signals.activeMissionIntent === "travel_kit") return "premium";

  if (historyTurns >= PREMIUM_HISTORY_TURNS) return "premium";
  if (message.length >= PREMIUM_MESSAGE_CHARS) return "premium";
  if (PREMIUM_PATTERNS.some((re) => re.test(message))) return "premium";
  return "default";
}
