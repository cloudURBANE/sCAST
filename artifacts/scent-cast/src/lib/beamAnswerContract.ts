/* --------------------------------------------------------------------------
 * Beam recommendation flow — completion contract + state machine (pure)
 *
 * The panel used to derive its status from optimistic UI: any completed run
 * read as "Answered", even when the model only said "let me pull your vault and
 * search the catalog before I commit to picks." That is a thinking/searching
 * beat, not an answer. These pure helpers give the panel ONE deterministic place
 * to decide:
 *   • whether a finished turn actually delivered picks (the completion contract),
 *   • what flow state the panel is in (the state machine),
 *   • and the truthful copy for the recap label, primary CTA, and composer
 *     placeholder that follow from that state.
 *
 * Everything here is framework-free and unit-tested (beamAnswerContract.test.ts)
 * so cue/location formatting and status wording can't silently drift.
 * ------------------------------------------------------------------------ */

/** Outcome of a single completed agent turn. */
export type BeamTurnOutcome = 'answered' | 'needs_more_info' | 'pending';

/** Coarse flow state that drives the CTA, placeholder, and status affordances. */
export type BeamFlowState =
  | 'idle'
  | 'collecting_cues'
  | 'thinking'
  | 'answered'
  | 'needs_more_info'
  | 'error';

/* ---------------------------------------------------------------- location -- */

// US state / territory postal abbreviations. A trailing 2-letter token that
// matches one of these is a state — title-case the city, keep the state UPPER
// ("duluth mn" → "Duluth, MN"), and never title-case the abbreviation into "Mn".
const US_STATE_ABBR = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
]);

/** Title-case a free-text fragment ("tokyo" → "Tokyo", "new york" → "New York"). */
export function titleCaseWords(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Normalize a free-text location for display.
 *   "duluth mn"   → "Duluth, MN"
 *   "duluth, mn"  → "Duluth, MN"
 *   "new york ny" → "New York, NY"
 *   "tokyo"       → "Tokyo"
 * A trailing token is only treated as a state when it is a real US abbreviation,
 * so "smell in" or "go to" never get mangled into a bogus state.
 */
export function normalizeLocation(raw: string): string {
  const cleaned = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  // Honor an explicit comma first ("duluth, mn").
  const commaIdx = cleaned.lastIndexOf(',');
  if (commaIdx !== -1) {
    const city = cleaned.slice(0, commaIdx).trim();
    const tail = cleaned.slice(commaIdx + 1).trim();
    const abbr = tail.toUpperCase();
    if (US_STATE_ABBR.has(abbr)) return `${titleCaseWords(city)}, ${abbr}`;
    return titleCaseWords(cleaned.replace(/\s*,\s*/g, ', '));
  }

  const parts = cleaned.split(' ');
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last.length === 2 && US_STATE_ABBR.has(last.toUpperCase())) {
      const city = parts.slice(0, -1).join(' ');
      return `${titleCaseWords(city)}, ${last.toUpperCase()}`;
    }
  }
  return titleCaseWords(cleaned);
}

const DATE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\btomorrow\b/i, label: 'Tomorrow' },
  { re: /\btonight\b/i, label: 'Tonight' },
  { re: /\btoday\b/i, label: 'Today' },
  { re: /\bthis weekend\b/i, label: 'This Weekend' },
  { re: /\bnext weekend\b/i, label: 'Next Weekend' },
  { re: /\bthis week\b/i, label: 'This Week' },
  { re: /\bnext week\b/i, label: 'Next Week' },
  { re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, label: '' },
];

/**
 * Pull a human date/time context out of free text ("…Duluth mn tomorrow" →
 * "Tomorrow"), so the kit title can preserve it. Returns null when none is found.
 */
export function parseDateLabel(raw: string): string | null {
  const text = raw ?? '';
  for (const { re, label } of DATE_PATTERNS) {
    const m = text.match(re);
    if (m) return label || titleCaseWords(m[0].toLowerCase());
  }
  return null;
}

/**
 * Compose the panel's kit / scent-for title from already-extracted cues. Keeps
 * the existing "Your <place> · <month> kit" shape but routes the place through
 * normalizeLocation and appends a date context when present.
 */
export function formatKitTitle(opts: {
  destination: string;
  month?: string;
  dateLabel?: string | null;
}): string {
  const place = normalizeLocation(opts.destination);
  if (!place) return '';
  const segments = [place];
  if (opts.month && opts.month.trim()) segments.push(titleCaseWords(opts.month.trim()));
  else if (opts.dateLabel) segments.push(opts.dateLabel);
  return `Your ${segments.join(' · ')} kit`;
}

/* -------------------------------------------------------- completion gate -- */

// "I'm still working" language. A completed turn whose text reads like this —
// and which carries no actual picks — is pending/searching, NOT an answer.
const PENDING_LANGUAGE =
  /\b(before i (commit|pick|decide|recommend|finalize)|let me (pull|search|check|look|dig|take|review|gather)|i'?ll (pull|search|check|look|dig|gather|need a)|i am going to (pull|search|check|look)|pulling (up )?your vault|search(ing)? the catalog|checking the catalog|give me (a )?(sec|second|moment|minute)|hold on|one moment|still (searching|looking|pulling|working|gathering)|working on (it|that|your))\b/i;

// Surface markers of a real recommendation: a bolded fragrance name leading an
// em-dash breakdown ("**Aventus Cologne** — …"), an explicit pick phrase, or a
// numbered/bulleted pick list.
const RECOMMENDATION_MARKERS = [
  /\*\*[^*\n]{2,}\*\*\s*[—–-]/, // **Name** — notes…
  /\b(here are your|here's your|here is your|i'?d (go with|reach for|pick|suggest)|my (top )?pick(s)?( (is|are))?\b|go with|reach for|i recommend|recommendation:)/i,
  /^\s*(\d+[.)]|[-•*])\s+\S+.*[—–-]/m, // "1. Name — …" / "- Name — …"
];

export function hasPendingLanguage(text: string): boolean {
  return PENDING_LANGUAGE.test(text ?? '');
}

export function looksLikeRecommendation(text: string): boolean {
  const t = text ?? '';
  return RECOMMENDATION_MARKERS.some((re) => re.test(t));
}

function endsWithQuestion(text: string): boolean {
  return /\?\s*$/.test((text ?? '').trim());
}

/**
 * The completion contract. A turn is only `answered` when it delivered a real
 * payload (card/proposal) or its text carries actual picks AND isn't hedged with
 * "let me search first" language. Otherwise it is `pending` (the agent is still
 * working / stalled) or `needs_more_info` (it asked a clarifying question).
 */
export function classifyTurnOutcome(input: {
  text: string;
  /** A native card or a non-empty proposal was emitted this turn. */
  deliveredResult: boolean;
  /** The turn offered clarifying cue chips. */
  emittedCues: boolean;
}): BeamTurnOutcome {
  const { text, deliveredResult, emittedCues } = input;
  const recommends = looksLikeRecommendation(text);
  // A delivered card/proposal is an answer — unless the prose is purely a
  // "before I commit" stall with no picks of its own (defensive; rare).
  if (deliveredResult) {
    return hasPendingLanguage(text) && !recommends ? 'pending' : 'answered';
  }
  if (hasPendingLanguage(text) && !recommends) return 'pending';
  if (recommends) return 'answered';
  if (emittedCues || endsWithQuestion(text)) return 'needs_more_info';
  // No picks, no question, no stall phrasing — treat as not-yet-answered rather
  // than falsely claiming an answer.
  return 'pending';
}

/** Truthful recap label for a settled turn ("Answered in 12s" only when real). */
export function recapLabelForOutcome(outcome: BeamTurnOutcome, seconds: number | null): string {
  const suffix = seconds != null ? ` in ${seconds}s` : '';
  switch (outcome) {
    case 'answered':
      return `Answered${suffix}`;
    case 'needs_more_info':
      return seconds != null ? `Asked a question · ${seconds}s` : 'Asked a question';
    case 'pending':
    default:
      return seconds != null ? `Still working · ${seconds}s` : 'Still working';
  }
}

/* ------------------------------------------------------------ state machine -- */

export function deriveFlowState(input: {
  busy: boolean;
  catalogFailure: boolean;
  hasMatch: boolean;
  lastTurnOutcome: BeamTurnOutcome | null;
  hasClarifyingCues: boolean;
  conversationStarted: boolean;
}): BeamFlowState {
  const { busy, catalogFailure, hasMatch, lastTurnOutcome, hasClarifyingCues, conversationStarted } =
    input;
  if (busy) return 'thinking';
  if (catalogFailure) return 'error';
  if (hasMatch || lastTurnOutcome === 'answered') return 'answered';
  // A completed turn that produced no picks (stall) is a contract failure the
  // user can recover from — surface it as an actionable error, not "answered".
  if (lastTurnOutcome === 'pending') return 'error';
  if (hasClarifyingCues || lastTurnOutcome === 'needs_more_info') return 'needs_more_info';
  if (conversationStarted) return 'collecting_cues';
  return 'idle';
}

/** Primary "Recommend now" CTA copy + availability for the current state. */
export function recommendCtaForState(state: BeamFlowState): {
  hidden: boolean;
  disabled: boolean;
  label: string;
} {
  switch (state) {
    case 'thinking':
      return { hidden: false, disabled: true, label: 'Finding picks…' };
    case 'answered':
      // The answer is on screen — refine actions take over; don't re-offer the
      // same primary CTA with a now-stale meaning.
      return { hidden: true, disabled: false, label: 'Recommend now' };
    case 'needs_more_info':
      return { hidden: false, disabled: false, label: 'Recommend now anyway' };
    case 'error':
      return { hidden: false, disabled: false, label: 'Try again' };
    case 'idle':
    case 'collecting_cues':
    default:
      return { hidden: false, disabled: false, label: 'Recommend now' };
  }
}

/**
 * Composer placeholder for the current state. Returns null for cold-start states
 * so the caller keeps its mode-specific opening copy.
 */
export function composerPlaceholderForState(state: BeamFlowState): string | null {
  switch (state) {
    case 'thinking':
      return 'Composing your recommendation…';
    case 'answered':
      return 'Ask for alternatives, stronger picks, or a different vibe…';
    case 'needs_more_info':
      return 'Add the missing detail — place, date, or vibe…';
    case 'error':
      return 'Adjust a detail and try again…';
    case 'idle':
    case 'collecting_cues':
    default:
      return null;
  }
}
