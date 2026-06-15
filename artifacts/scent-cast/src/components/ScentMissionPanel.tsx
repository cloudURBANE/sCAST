import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react';
import {
  applyScentMissionUpdates,
  createScentMissionState,
  isScentMissionDestination,
  isScentMissionEnergy,
  type ScentMissionDestination,
  type ScentMissionEnergy,
  type ScentMissionNodeId,
  type ScentMissionRecommendation,
  type ScentMissionResponse,
  type ScentMissionState,
  type ScentWeatherRecommendation,
} from '@workspace/scent-weather-engine';
import {
  buildAgentReveal,
  buildMissionWardrobe,
  buildMissionWeather,
  findWardrobeMatch,
  missionProgress,
} from '@/lib/scentMissionClient';
import {
  humanizeBeamTool,
  runBeamAgentMission,
  type BeamProposalItem,
  type BeamSuggestion,
} from '@/lib/beamAgentClient';
import { formatAgentResponse } from '@/lib/beamMessageFormat';
import { BeamMessage } from '@/components/BeamMessage';
import type { Fragrance } from '@/components/Wardrobe';
import type { WeatherData } from '@/context/WeatherContext';
import { useDragToScroll } from '@/hooks/useDragToScroll';
import { useMarqueeSwipe } from '@/hooks/useMarqueeSwipe';
import { isIpadSafariPerformanceMode } from '@/lib/platform';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?.trim()
  .replace(/\/+$/, '');
const SCENT_MISSION_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/scent-mission`
  : '/api/scent-mission';

type PanelMessage = {
  id: string;
  role: 'agent' | 'user' | 'system';
  text: string;
  // Per-turn "thinking" trail, frozen onto the agent reply it produced. Rendered
  // as a collapsible "Thought for Ns · N steps" recap ABOVE this answer (the
  // ChatGPT / Claude pattern), so each turn keeps its own steps instead of one
  // floating trail under the whole log. Absent on user/system rows and on
  // scripted replies that ran no tools.
  activity?: BeamActivityStep[];
  elapsedMs?: number | null;
};

type AgentMode = 'fast' | 'research' | 'premium';
type ToneMode = 'playful' | 'balanced' | 'premium';

type FacetId =
  | 'mood'
  | 'occasion'
  | 'season'
  | 'projection'
  | 'budget'
  | 'genderExpression'
  | 'personality'
  | 'impression'
  | 'creativeDirection';

type FacetState = Partial<Record<FacetId, string>>;

type QuickReply = {
  facet: FacetId;
  label: string;
  value: string;
  destination?: ScentMissionDestination;
  energy?: ScentMissionEnergy;
};

const MODE_OPTIONS: Array<{ id: AgentMode; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }> }> = [
  { id: 'fast', label: 'Fast', icon: Zap },
  { id: 'research', label: 'Research', icon: Sparkles },
  { id: 'premium', label: 'Premium', icon: Lock },
];

const TONE_OPTIONS: Array<{ id: ToneMode; label: string }> = [
  { id: 'playful', label: 'Playful' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'premium', label: 'Premium' },
];

const FACET_LABELS: Record<FacetId, string> = {
  mood: 'Mood',
  occasion: 'Occasion',
  season: 'Season',
  projection: 'Projection',
  budget: 'Budget',
  genderExpression: 'Expression',
  personality: 'Personality',
  impression: 'Impression',
  creativeDirection: 'Direction',
};

const QUICK_REPLIES: QuickReply[] = [
  { facet: 'occasion', label: 'Work meeting', value: 'Work', destination: 'Work' },
  { facet: 'occasion', label: 'Date night', value: 'Date', destination: 'Date' },
  { facet: 'occasion', label: 'Night out', value: 'Night Out', destination: 'Night Out' },
  { facet: 'occasion', label: 'Staying in', value: 'Staying In', destination: 'Staying In' },
  { facet: 'mood', label: 'Calm', value: 'Calm', energy: 'Calm' },
  { facet: 'mood', label: 'Focused', value: 'Focused', energy: 'Focused' },
  { facet: 'mood', label: 'Confident', value: 'Confident', energy: 'Confident' },
  { facet: 'mood', label: 'Social', value: 'Social', energy: 'Social' },
  { facet: 'season', label: 'Summer heat', value: 'Summer heat' },
  { facet: 'season', label: 'Cool weather', value: 'Cool weather' },
  { facet: 'season', label: 'Rainy day', value: 'Rainy day' },
  { facet: 'projection', label: 'Skin-close', value: 'Skin-close' },
  { facet: 'projection', label: 'Moderate trail', value: 'Moderate trail' },
  { facet: 'projection', label: 'Statement', value: 'Statement' },
  { facet: 'budget', label: 'Use my vault', value: 'Use my vault' },
  { facet: 'budget', label: 'Under $150', value: 'Under $150' },
  { facet: 'budget', label: 'No budget cap', value: 'No budget cap' },
  { facet: 'genderExpression', label: 'Feminine leaning', value: 'Feminine leaning' },
  { facet: 'genderExpression', label: 'Masculine leaning', value: 'Masculine leaning' },
  { facet: 'genderExpression', label: 'Fluid', value: 'Fluid' },
  { facet: 'personality', label: 'Minimal', value: 'Minimal' },
  { facet: 'personality', label: 'Romantic', value: 'Romantic' },
  { facet: 'personality', label: 'Sharp', value: 'Sharp' },
  { facet: 'impression', label: 'Clean', value: 'Clean' },
  { facet: 'impression', label: 'Memorable', value: 'Memorable' },
  { facet: 'impression', label: 'Soft power', value: 'Soft power' },
  { facet: 'creativeDirection', label: 'Modern classic', value: 'Modern classic' },
  { facet: 'creativeDirection', label: 'Niche texture', value: 'Niche and textured' },
  { facet: 'creativeDirection', label: 'Dark elegant', value: 'Dark elegant' },
];

const RESOLUTION_SEQUENCE: ScentMissionNodeId[] = [
  'onboarding',
  'wardrobe-sync',
  'environment-scan',
  'resolution-standard',
];

const PROGRESS_COPY: Record<ScentMissionNodeId, string> = {
  onboarding: 'Locking your intent',
  'wardrobe-sync': 'Reading your vault',
  'environment-scan': 'Checking today air',
  'resolution-standard': 'Choosing the strongest match',
  'resolution-premium': 'Previewing premium depth',
};

// Shared "settle" easing for the panel's motion — a gentle decel that reads as
// expensive rather than springy. Matches the curve used across the Beam Agent.
const SCENT_EASE = [0.22, 1, 0.36, 1] as const;

// Minimum time the agent's typing bubble stays up on a chat turn. The API can
// answer in well under a second, which made the reply + cues snap in before the
// user had read anything; holding a short, deliberate "thinking" beat gives the
// turn the rhythm of a real concierge instead of an instant pop.
const MIN_THINKING_MS = 700;

// Hard ceiling on a single mission request. The Beam Agent backend is not always
// reachable (or can stall), and without this the typing dots would spin forever
// with no reply ever landing. On timeout we abort the fetch and surface a real
// message so the turn always resolves.
const MISSION_TIMEOUT_MS = 20000;

// The live Beam Agent calls an LLM plus catalog/research tools, so a single turn
// can legitimately run longer than the scripted mission. Cap it well above
// MISSION_TIMEOUT_MS; on timeout we abort and fall back to the scripted path.
const BEAM_AGENT_TIMEOUT_MS = 60000;

// Shared chat-bubble shell for the agent's typing indicator (used both on first
// open and while the agent is working a turn).
const BEAM_TYPING_BUBBLE_CLASS =
  'inline-flex max-w-[90%] items-center gap-1.5 self-start rounded-[calc(var(--radius-scent)-12px)] border border-scent-accent/22 bg-[linear-gradient(180deg,rgba(212,175,55,0.045),rgba(0,0,0,0.16))] px-4 py-3';

// Three dots with an organic, staggered shimmer so the agent reads as genuinely
// "thinking" rather than mechanically blinking.
const BeamTypingDots: React.FC = () => (
  <>
    {[0, 1, 2].map((dot) => (
      <motion.span
        key={dot}
        className="h-1.5 w-1.5 rounded-full bg-scent-accent/70"
        animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0], scale: [1, 1.18, 1] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: dot * 0.22 }}
      />
    ))}
  </>
);

/* --------------------------------------------------------------------------
 * Beam Agent live activity trail
 *
 * The Beam run streams `status` / `tool_started` / `tool_completed` events. The
 * old UI collapsed every event into ONE overwritten line and threw away the
 * grounded `tool_completed.summary` — so a real, working run read as a generic
 * spinner that flickered "Searching the catalog…" on a loop. Instead we keep an
 * ordered trail: each tool/phase is its own row that resolves from a spinner to
 * a check + the real result ("12 fragrances found", "Top match · Aventus"), so
 * the wait reads as visible, intelligent progress.
 * ------------------------------------------------------------------------ */

type BeamActivityStep = {
  id: number;
  /** Present when the row is a tool call; absent for phase/status rows. */
  tool?: string;
  label: string;
  detail?: string;
  state: 'active' | 'done';
  tone?: 'error';
};

const BEAM_ACTIVITY_BUBBLE_CLASS =
  'flex max-w-[92%] flex-col gap-1.5 self-start rounded-[calc(var(--radius-scent)-12px)] border border-scent-accent/22 bg-[linear-gradient(180deg,rgba(212,175,55,0.05),rgba(0,0,0,0.18))] px-3.5 py-3';

/** Human copy for each per-fragrance curate phase. */
const CURATE_STATUS_COPY: Record<'adding' | 'curating' | 'ready' | 'failed', string> = {
  adding: 'Adding',
  curating: 'Curating',
  ready: 'Ready ·',
  failed: 'Skipped',
};

/**
 * Turn a terse server summary into premium, tool-aware copy. The server keeps
 * summaries stable + terse ("12 result(s)", "picked Aventus"); presentation copy
 * lives here so it can read naturally per tool without a backend round-trip.
 */
function beamActivityDetail(tool: string, summary: string): string | undefined {
  const s = summary.trim();
  if (!s || s === 'done') return undefined;
  const count = s.match(/^(\d+)\s+(?:result|item|candidate)\(s\)$/);
  if (count) {
    const n = Number(count[1]);
    if (tool === 'beam_search_catalog') return `${n} ${n === 1 ? 'fragrance' : 'fragrances'} found`;
    if (tool === 'beam_get_wardrobe') return `${n} ${n === 1 ? 'bottle' : 'bottles'} in your vault`;
    if (tool === 'beam_get_fragrance_details') return `${n} ${n === 1 ? 'fragrance' : 'fragrances'} detailed`;
    return `${n} ${n === 1 ? 'result' : 'results'}`;
  }
  if (s.startsWith('picked ')) return `Top match · ${s.slice('picked '.length)}`;
  if (s === 'no match') return 'No clear match yet';
  if (s === 'scored vault') return 'Ranked your vault';
  const sources = s.match(/^researched \((\d+) source\(s\)\)$/);
  if (sources) {
    const n = Number(sources[1]);
    return `Cross-checked ${n} ${n === 1 ? 'source' : 'sources'}`;
  }
  if (s === 'no live result') return 'No fresh data — using catalog';
  // Already-grounded summaries ("8 bottles · woody, amber", "vault is empty").
  return s;
}

/** Mark the most recent row done — a new phase/tool implies the prior one finished. */
function sealLastActiveStep(steps: BeamActivityStep[]): BeamActivityStep[] {
  if (steps.length === 0) return steps;
  const last = steps[steps.length - 1];
  if (last.state !== 'active') return steps;
  return [...steps.slice(0, -1), { ...last, state: 'done' }];
}

function pushStatusStep(steps: BeamActivityStep[], id: number, label: string): BeamActivityStep[] {
  // Collapse a repeated status (e.g. the model re-emits the same phase label).
  if (steps.length > 0 && steps[steps.length - 1].label === label) return steps;
  return [...sealLastActiveStep(steps), { id, label, state: 'active' }];
}

function pushToolStep(steps: BeamActivityStep[], id: number, tool: string): BeamActivityStep[] {
  return [...sealLastActiveStep(steps), { id, tool, label: humanizeBeamTool(tool), state: 'active' }];
}

function completeToolStep(
  steps: BeamActivityStep[],
  fallbackId: number,
  tool: string,
  summary: string,
): BeamActivityStep[] {
  const failed = summary === 'failed' || summary === 'invalid arguments';
  const detail = failed
    ? summary === 'failed'
      ? 'Step failed'
      : 'Retrying that step'
    : beamActivityDetail(tool, summary);
  const tone = failed ? ('error' as const) : undefined;
  // Resolve the most recent in-flight row for this tool.
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].tool === tool && steps[i].state === 'active') {
      const next = steps.slice();
      next[i] = { ...next[i], state: 'done', detail, tone };
      return next;
    }
  }
  return [
    ...sealLastActiveStep(steps),
    { id: fallbackId, tool, label: humanizeBeamTool(tool), state: 'done', detail, tone },
  ];
}

const BeamActivityStepRow: React.FC<{ step: BeamActivityStep; calmMotion: boolean }> = ({
  step,
  calmMotion,
}) => (
  <div className="flex items-start gap-2">
    <span className="mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center">
      {step.state === 'active' ? (
        <Loader2 size={13} className={calmMotion ? '' : 'animate-spin'} aria-hidden />
      ) : step.tone === 'error' ? (
        <AlertTriangle size={12} className="text-scent-accent/55" aria-hidden />
      ) : (
        <Check size={13} className="text-scent-accent" aria-hidden />
      )}
    </span>
    <span className="min-w-0 flex-1 leading-snug">
      <span
        className={`text-[12px] ${
          step.state === 'active' ? 'text-[#fff7ec]' : 'text-scent-text-muted'
        }`}
      >
        {/* Drop the trailing "…" once the step has settled — an ellipsis next to a
            check reads as still-in-progress. */}
        {step.state === 'active' ? step.label : step.label.replace(/[.…]+$/, '')}
      </span>
      {step.detail ? (
        <span className="ml-1 text-[11.5px] text-scent-accent/75">· {step.detail}</span>
      ) : null}
    </span>
  </div>
);

/**
 * Condensed "thinking" trail. While the run is live it shows a single summary
 * line (the most recent step) with a Details toggle; once the run settles it
 * collapses to a quiet "Thought for Ns · N steps" recap the user can reopen —
 * the ChatGPT / Claude pattern. The full tool-by-tool list only renders when the
 * user expands it, so the conversation never gets buried under the trail.
 */
const ACTIVITY_TRAIL_BODY_ID = 'beam-activity-steps';

const BeamActivityTrail: React.FC<{
  steps: BeamActivityStep[];
  calmMotion: boolean;
  running: boolean;
  expanded: boolean;
  elapsedMs: number | null;
  onToggleExpand: () => void;
}> = ({ steps, calmMotion, running, expanded, elapsedMs, onToggleExpand }) => {
  if (steps.length === 0) return null;

  const activeCount = steps.filter((s) => s.state === 'active').length;
  const currentStep = [...steps].reverse().find((s) => s.state === 'active') ?? steps[steps.length - 1];
  const showSpinner = running && activeCount > 0;
  const elapsedSeconds = elapsedMs != null ? Math.max(1, Math.round(elapsedMs / 1000)) : null;
  const summaryLabel = showSpinner
    ? currentStep.label
    : elapsedSeconds != null
      ? `Thought for ${elapsedSeconds}s · ${steps.length} step${steps.length === 1 ? '' : 's'}`
      : `${steps.length} step${steps.length === 1 ? '' : 's'}`;

  const body = (
    <div className="mt-2.5 flex flex-col gap-2 border-t border-white/10 pt-2.5">
      {steps.map((step) => (
        <BeamActivityStepRow key={step.id} step={step} calmMotion={calmMotion} />
      ))}
    </div>
  );

  return (
    <motion.div
      layout={calmMotion ? false : 'position'}
      initial={calmMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      transition={{ duration: 0.24, ease: SCENT_EASE }}
      className={BEAM_ACTIVITY_BUBBLE_CLASS}
      role="status"
      aria-live="polite"
      aria-busy={running}
      aria-label="Beam Agent progress"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {showSpinner ? (
            <Loader2 size={13} className={calmMotion ? 'text-scent-accent' : 'animate-spin text-scent-accent'} aria-hidden />
          ) : (
            <Check size={13} className="text-scent-accent" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-snug text-[#fff7ec]">
          {summaryLabel}
        </span>
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-controls={ACTIVITY_TRAIL_BODY_ID}
          className="-mr-1 flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-scent-accent/80 transition-colors hover:text-scent-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-scent-accent/50"
        >
          <span>{expanded ? 'Hide' : 'Details'}</span>
          <ChevronDown
            size={13}
            className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          calmMotion ? (
            <div id={ACTIVITY_TRAIL_BODY_ID}>{body}</div>
          ) : (
            <motion.div
              id={ACTIVITY_TRAIL_BODY_ID}
              key="activity-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.24, ease: SCENT_EASE }}
              className="overflow-hidden"
            >
              {body}
            </motion.div>
          )
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
};

/**
 * Recover the page viewport after the iOS soft keyboard dismisses. WebKit
 * usually restores scroll itself, but when it leaves the page scrolled up we
 * correct it — only once the keyboard-driven `visualViewport` resize has settled
 * and only if still offset, using an instant scroll. A forced `behavior:'smooth'`
 * scroll fired immediately on blur fights the native dismissal and makes the page
 * shudder, so we deliberately avoid both.
 */
function recoverViewportAfterKeyboard(): void {
  if (typeof window === 'undefined') return;
  const correct = () => {
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  };
  const vv = window.visualViewport;
  if (!vv) {
    window.setTimeout(correct, 280);
    return;
  }
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    vv.removeEventListener('resize', onResize);
    correct();
  };
  const onResize = () => finish();
  vv.addEventListener('resize', onResize);
  // Fallback when no resize fires (desktop, or keyboard already gone).
  window.setTimeout(finish, 320);
}

function newMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function initialAgentMessage(itemCount: number): string {
  if (itemCount > 0) {
    // Foreshadow the cue lane so it never feels like the chips "pop up" on the
    // user — the agent says it will offer taps, then they appear just beneath.
    return 'Welcome. Tell me about your day — the mood, the moment, the impression you want to leave. I will line up a few cues you can tap below, or just type.';
  }
  return 'Add a few fragrances from search first, then I can curate a real match for you here.';
}

function formatFacetLine(facets: FacetState): string {
  const entries = (Object.entries(facets) as Array<[FacetId, string]>)
    .filter(([, value]) => value.trim().length > 0)
    .slice(0, 5);
  if (entries.length === 0) return 'No cues captured yet';
  return entries.map(([facet, value]) => `${FACET_LABELS[facet]}: ${value}`).join(' / ');
}

const ENOUGH_CONTEXT_PROMPT =
  'That is enough for me to curate from your vault — tap Confirm whenever you are ready, or add one more detail.';

function hasEnoughContext(facets: FacetState, mission: ScentMissionState, mode: AgentMode): boolean {
  if (mode === 'fast') return Boolean(mission.calibration.destination || mission.calibration.energy || Object.keys(facets).length > 0);
  if (!mission.calibration.destination || !mission.calibration.energy) return false;
  // Premium keeps one extra layer of depth; standard/research curate as soon as
  // destination + energy are set so the agent stops interrogating the user.
  if (mode === 'premium') return Boolean(facets.projection && (facets.creativeDirection || facets.impression));
  return true;
}

/**
 * The single facet the agent still needs before it can curate, or null when it
 * has enough context. Drives both the next question and the contextual quick
 * replies, so the two never drift out of sync (and the agent never loops on a
 * question it has already answered).
 */
function nextNeededFacet(
  facets: FacetState,
  mission: ScentMissionState,
  mode: AgentMode,
  itemCount: number,
): FacetId | null {
  if (itemCount === 0) return null;
  if (!mission.calibration.destination) return 'occasion';
  if (!mission.calibration.energy) return 'mood';
  if (hasEnoughContext(facets, mission, mode)) return null;
  if (!facets.projection) return 'projection';
  if (mode === 'premium' && !facets.creativeDirection) return 'creativeDirection';
  return null;
}

function firstMissingPrompt(
  facets: FacetState,
  mission: ScentMissionState,
  mode: AgentMode,
  itemCount: number,
): string {
  if (itemCount === 0) {
    return 'Add fragrances to your vault first, then I can make this specific instead of generic.';
  }
  switch (nextNeededFacet(facets, mission, mode, itemCount)) {
    case 'occasion':
      return 'What setting should this serve: work, date, staying in, night out, or something else?';
    case 'mood':
      return 'What should it make you feel: calm, focused, confident, social, or relaxed?';
    case 'projection':
      return 'How much trail should it leave: skin-close, moderate, or a statement?';
    case 'creativeDirection':
      return 'Give me a creative direction, like modern classic, textured niche, fresh signature, or dark elegance.';
    default:
      return ENOUGH_CONTEXT_PROMPT;
  }
}

function safeAssistantText(text: string | undefined, fallback: string): string {
  const value = text?.trim();
  if (!value) return fallback;
  if (/(mission tree|execute analysis|resolution node|sync node|hit execute|work through the mission)/i.test(value)) {
    return fallback;
  }
  return value;
}

function recommendationMessage(recommendation: ScentMissionRecommendation): string {
  const house = recommendation.brand ? ` by ${recommendation.brand}` : '';
  return `I would start with ${recommendation.name}${house}. ${recommendation.reason}`;
}

function modeInstruction(mode: AgentMode, tone: ToneMode, userMessage: string): string {
  const modeLine =
    mode === 'fast'
      ? 'Fast mode: answer briefly and curate as soon as enough context exists.'
      : mode === 'premium'
        ? 'Premium mode: keep the answer understated and prepare deeper scent architecture, without claiming premium is unlocked.'
        : 'Research mode: ask only the next high-value question before recommending.';
  return `${modeLine} Tone: ${tone}. User: ${userMessage}`;
}

function inferTextFacets(text: string): {
  facets: FacetState;
  destination?: ScentMissionDestination;
  energy?: ScentMissionEnergy;
} {
  const lower = text.toLowerCase();
  const facets: FacetState = {};
  let destination: ScentMissionDestination | undefined;
  let energy: ScentMissionEnergy | undefined;

  if (/\b(work|office|meeting|client|presentation)\b/.test(lower)) {
    facets.occasion = 'Work';
    destination = 'Work';
  } else if (/\b(date|romantic|dinner)\b/.test(lower)) {
    facets.occasion = 'Date';
    destination = 'Date';
  } else if (/\b(gym|workout|training|run)\b/.test(lower)) {
    facets.occasion = 'Gym';
    destination = 'Gym';
  } else if (/\b(night|bar|party|club|evening)\b/.test(lower)) {
    facets.occasion = 'Night Out';
    destination = 'Night Out';
  } else if (/\b(home|staying in|inside|indoors)\b/.test(lower)) {
    facets.occasion = 'Staying In';
    destination = 'Staying In';
  } else if (/\b(errands|day out|weekend|brunch)\b/.test(lower)) {
    facets.occasion = 'Going Out';
    destination = 'Going Out';
  }

  if (/\b(calm|quiet|soft|subtle)\b/.test(lower)) {
    facets.mood = 'Calm';
    energy = 'Calm';
  } else if (/\b(focused|focus|productive|sharp)\b/.test(lower)) {
    facets.mood = 'Focused';
    energy = 'Focused';
  } else if (/\b(confident|confidence|bold|commanding)\b/.test(lower)) {
    facets.mood = 'Confident';
    energy = 'Confident';
  } else if (/\b(social|approachable|friendly|chatty)\b/.test(lower)) {
    facets.mood = 'Social';
    energy = 'Social';
  } else if (/\b(relaxed|casual|easy)\b/.test(lower)) {
    facets.mood = 'Relaxed';
    energy = 'Relaxed';
  }

  if (/\b(summer|heat|hot)\b/.test(lower)) facets.season = 'Summer heat';
  if (/\b(winter|cold|cool)\b/.test(lower)) facets.season = 'Cool weather';
  if (/\b(rain|rainy|humid|humidity)\b/.test(lower)) facets.season = 'Rainy day';
  if (/\b(skin.?close|close to skin|intimate|subtle)\b/.test(lower)) facets.projection = 'Skin-close';
  if (/\b(moderate|balanced trail|office safe)\b/.test(lower)) facets.projection = 'Moderate trail';
  if (/\b(statement|strong|project|beast)\b/.test(lower)) facets.projection = 'Statement';
  if (/\b(feminine|femme)\b/.test(lower)) facets.genderExpression = 'Feminine leaning';
  if (/\b(masculine|masc)\b/.test(lower)) facets.genderExpression = 'Masculine leaning';
  if (/\b(unisex|fluid|androgynous)\b/.test(lower)) facets.genderExpression = 'Fluid';
  if (/\b(clean|fresh)\b/.test(lower)) facets.impression = 'Clean';
  if (/\b(memorable|notice|remembered)\b/.test(lower)) facets.impression = 'Memorable';
  if (/\b(soft power|polished|elegant)\b/.test(lower)) facets.impression = 'Soft power';
  if (/\b(modern classic|classic)\b/.test(lower)) facets.creativeDirection = 'Modern classic';
  if (/\b(niche|textured|artful)\b/.test(lower)) facets.creativeDirection = 'Niche and textured';
  if (/\b(dark|smoky|evening elegant)\b/.test(lower)) facets.creativeDirection = 'Dark elegant';

  return { facets, destination, energy };
}

function mergeCalibration(
  mission: ScentMissionState,
  destination?: ScentMissionDestination,
  energy?: ScentMissionEnergy,
): ScentMissionState {
  const nextDestination = destination && isScentMissionDestination(destination)
    ? destination
    : mission.calibration.destination;
  const nextEnergy = energy && isScentMissionEnergy(energy)
    ? energy
    : mission.calibration.energy;
  if (nextDestination === mission.calibration.destination && nextEnergy === mission.calibration.energy) {
    return mission;
  }
  return {
    ...mission,
    calibration: {
      ...mission.calibration,
      ...(nextDestination ? { destination: nextDestination } : {}),
      ...(nextEnergy ? { energy: nextEnergy } : {}),
    },
  };
}

function missionWithDefaultsForFast(mission: ScentMissionState): ScentMissionState {
  return mergeCalibration(
    mission,
    mission.calibration.destination ?? 'Going Out',
    mission.calibration.energy ?? 'Confident',
  );
}

/** Live progress surfaced to the host so the header can render outside the card. */
export interface ScentMissionStatus {
  progress: number;
  progressText: string;
  contextLine: string;
}

/** Per-fragrance progress reported while a confirmed collection is being added. */
export type CollectionCurateProgress = {
  index: number;
  total: number;
  name: string;
  status: 'adding' | 'curating' | 'ready' | 'failed';
};

/**
 * Host-provided action that adds a confirmed set of proposed fragrances to the
 * vault through the app's NORMAL wardrobe path, reporting per-item progress so
 * the panel can hold a "curating" state until each is image+profile ready.
 */
export type CurateCollectionFn = (
  items: BeamProposalItem[],
  onProgress: (progress: CollectionCurateProgress) => void,
) => Promise<{ added: number; total: number }>;

interface ScentMissionPanelProps {
  items: Fragrance[];
  weather: WeatherData | null;
  authToken: string | null;
  /** Leave Beam Agent mode and restore the search interior. */
  onExit: () => void;
  /** Open the existing recommendation overlay with the resolved match. */
  onRevealMatch: (item: Fragrance, engine: ScentWeatherRecommendation, reason: string) => void;
  /** Report progress so the host can render the header strip above the card. */
  onStatusChange?: (status: ScentMissionStatus) => void;
  /**
   * Host-provided element, rendered BELOW the bordered card, into which the cue
   * (quick-reply / Confirm) lane is portaled. This keeps the impressions out of
   * the card interior so the conversation never shrinks to make room for them.
   * Falls back to inline rendering when absent.
   */
  cueBarContainer?: HTMLElement | null;
  /**
   * Add a confirmed collection of proposed fragrances to the vault. Provided by
   * the host (which owns the wardrobe add/sync). Absent → the proposal card's
   * Confirm is disabled with a sign-in hint.
   */
  onCurateCollection?: CurateCollectionFn;
}

export const ScentMissionPanel: React.FC<ScentMissionPanelProps> = ({
  items,
  weather,
  authToken,
  onExit,
  onRevealMatch,
  onStatusChange,
  cueBarContainer,
  onCurateCollection,
}) => {
  const reduceMotion = useReducedMotion();
  const ipadPerformanceMode = useRef(isIpadSafariPerformanceMode()).current;
  const calmMotion = Boolean(reduceMotion) || ipadPerformanceMode;

  const [mission, setMission] = useState<ScentMissionState>(() => createScentMissionState());
  const [messages, setMessages] = useState<PanelMessage[]>(() => [
    {
      id: newMessageId(),
      role: 'agent',
      text: initialAgentMessage(items.length),
    },
  ]);
  const [facets, setFacets] = useState<FacetState>({});
  const [agentMode, setAgentMode] = useState<AgentMode>('research');
  const [tone, setTone] = useState<ToneMode>('balanced');
  const [composer, setComposer] = useState('');
  // Clear the placeholder the instant the field is tapped (native text-field
  // behavior) rather than holding the prompt copy under the caret.
  const [composerFocused, setComposerFocused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Pause the cue marquee while the user is pressing it, so a moving chip is
  // still easy to tap. Hover-pause (desktop) is handled in CSS.
  const [marqueePaused, setMarqueePaused] = useState(false);
  // The greeting bubble is held off the stage for a short beat after open, so
  // the panel never snaps in with the typing dots "already there." The agent
  // then arrives as a deliberate thinking pill once the open crossfade settles.
  // Skipped under reduced-motion / iPad performance mode (calmMotion).
  const [greetingMounted, setGreetingMounted] = useState(() => calmMotion);
  // Briefly show a typing indicator before the concierge's first line lands, so
  // the panel greets the user instead of snapping in a wall of copy. Skipped
  // entirely under reduced-motion / iPad performance mode (calmMotion).
  const [introReady, setIntroReady] = useState(() => calmMotion);
  // The impressions lane is held back until the greeting has settled, so the
  // panel never opens with a wall of cues — they fade in only once the agent
  // has actually asked for them.
  const [cuesReady, setCuesReady] = useState(() => calmMotion);
  // When a cue is tapped its value is staged into the composer (never sent as a
  // chat message). We hide the rest of that question's cues while a choice sits
  // in the box, so the lane reads as "you picked one — send or refine it".
  const [pendingCueFacet, setPendingCueFacet] = useState<FacetId | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressNote, setProgressNote] = useState('');
  // Ordered live-progress trail for a Beam agent run (status + tool steps).
  // Empty for the scripted `/api/scent-mission` path, which keeps the plain dots.
  const [activity, setActivity] = useState<BeamActivityStep[]>([]);
  // The thinking trail is condensed to a single summary line; the user taps to
  // expand the full tool-by-tool breakdown (ChatGPT / Claude pattern). Each new
  // run starts collapsed.
  const [activityExpanded, setActivityExpanded] = useState(false);
  // When the current run started, so a completed agent turn can freeze its
  // elapsed "Thought for Ns" onto the reply it produced.
  const runStartedAtRef = useRef<number | null>(null);
  // Latest snapshot of the live trail, so an agent reply can freeze its own steps
  // onto the message it produced (the per-turn recap) without threading state
  // through the async run. Synced from `activity` below.
  const activityListRef = useRef<BeamActivityStep[]>([]);
  // Expand state for each turn's frozen "Thought for Ns" recap, keyed by message
  // id. Each recap opens independently and defaults collapsed.
  const [expandedRecaps, setExpandedRecaps] = useState<Record<string, boolean>>({});
  const toggleRecap = useCallback(
    (id: string) => setExpandedRecaps((prev) => ({ ...prev, [id]: !prev[id] })),
    [],
  );
  // Tap-to-answer chips the agent offered with its last reply (e.g. trip-vibe
  // follow-ups). When set, these replace the static facet cues.
  const [agentSuggestions, setAgentSuggestions] = useState<BeamSuggestion[]>([]);
  // A collection the agent proposed adding to the vault, awaiting the user's
  // explicit Confirm. `curating` holds the per-item add/enrich progress; once it
  // finishes it becomes a short completion summary.
  const [proposal, setProposal] = useState<{ proposalId: string; items: BeamProposalItem[] } | null>(null);
  const [curating, setCurating] = useState<{
    total: number;
    progress: CollectionCurateProgress | null;
    done: { added: number; total: number } | null;
  } | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [resolved, setResolved] = useState<{
    recommendation: ScentMissionRecommendation;
    item: Fragrance | null;
  } | null>(null);
  // True once an agent turn reports the external catalog is unreachable/empty, so
  // the cue lane can offer recovery actions instead of vibe cues. Cleared on the
  // next user turn / a successful curation.
  const [catalogFailure, setCatalogFailure] = useState(false);
  // The last message the user actually sent — lets "Retry catalog search" re-run
  // the same turn without making them retype it.
  const [lastUserMessage, setLastUserMessage] = useState('');
  // Whether the conversation overflows past the top / bottom of its scroll box,
  // so the fade indicators only show when there is actually more to read.
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const quickReplyScrollRef = useRef<HTMLDivElement | null>(null);
  const cueTrackRef = useRef<HTMLDivElement | null>(null);
  const cueGroupRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const activityIdRef = useRef(0);

  // Desktop click-drag for the cue strip; touch keeps native momentum scroll.
  useDragToScroll(quickReplyScrollRef);

  // Recompute whether the conversation overflows its box, so the top/bottom fade
  // hints only appear when there is genuinely clipped content above/below.
  const updateScrollEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop > 6;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 6;
    setScrollEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Time each run (so a completed turn can freeze "Thought for Ns" onto its
  // reply) and reset the live trail to its collapsed summary whenever a fresh
  // run begins. Watching `busy` keeps this correct across every run path (agent
  // / scripted / resolution) without threading a start time through each one. The
  // elapsed value is read from `runStartedAtRef` at the moment the reply lands.
  useEffect(() => {
    if (busy) {
      runStartedAtRef.current = Date.now();
      setActivityExpanded(false);
    }
  }, [busy]);

  useEffect(() => {
    activityListRef.current = activity;
  }, [activity]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Land the user at the START of a new answer, not scrolled to its end. When a
  // fresh agent reply (or the curated-match reveal) arrives we align its top to
  // the top of the box; for the user's own turn we follow to the bottom. This is
  // the fix for "dropped mid-response": long answers begin at the beginning.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const behavior: ScrollBehavior = calmMotion ? 'auto' : 'smooth';
    const anchor =
      el.querySelector<HTMLElement>('[data-scroll-anchor="resolved"]') ??
      el.querySelector<HTMLElement>('[data-scroll-anchor="latest-agent"]');
    if (anchor) {
      const top = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTo({ top: Math.max(top - 10, 0), behavior });
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
    // Re-measure the fade hints once the (possibly smooth) scroll has settled.
    const id = window.setTimeout(updateScrollEdges, calmMotion ? 0 : 280);
    return () => window.clearTimeout(id);
  }, [messages, resolved, proposal, busy, calmMotion, updateScrollEdges]);

  useEffect(() => {
    if (greetingMounted) return;
    // Let the open crossfade settle on an empty stage first, then bring the
    // agent in. This is the fix for the dots showing "from the jump": the
    // conversation opens clean and the thinking pill arrives as its own beat.
    const id = window.setTimeout(() => setGreetingMounted(true), 420);
    return () => window.clearTimeout(id);
  }, [greetingMounted]);

  useEffect(() => {
    if (introReady || !greetingMounted) return;
    // Once the thinking pill has landed, hold it just long enough to read as the
    // agent composing, then expand it into the welcome line.
    const id = window.setTimeout(() => setIntroReady(true), 760);
    return () => window.clearTimeout(id);
  }, [introReady, greetingMounted]);

  // Reveal the impressions lane a beat after the greeting finishes expanding
  // (introReady kicks off the ~0.52s pill→welcome morph), so the cues glide in
  // once the bubble has settled instead of arriving over the top of its growth.
  useEffect(() => {
    if (cuesReady || !introReady) return;
    const id = window.setTimeout(() => setCuesReady(true), 480);
    return () => window.clearTimeout(id);
  }, [cuesReady, introReady]);

  // Re-arm the cue lane once the staged choice leaves the composer (sent or
  // cleared), so the next question's impressions can surface.
  useEffect(() => {
    if (pendingCueFacet && composer.trim().length === 0) {
      setPendingCueFacet(null);
    }
  }, [composer, pendingCueFacet]);

  const progress = missionProgress(mission);
  const enoughContext = hasEnoughContext(facets, mission, agentMode);
  const capturedCount = Object.keys(facets).length;

  const progressText = useMemo(() => {
    if (progressNote) return progressNote;
    if (resolved) return 'Match ready';
    if (capturedCount === 0) return 'Tell me about your day';
    return `${capturedCount} cue${capturedCount === 1 ? '' : 's'} captured`;
  }, [capturedCount, progressNote, resolved]);

  const contextLine = useMemo(() => {
    const weatherParts = [
      typeof weather?.temperature === 'number' ? `${Math.round(weather.temperature)}F` : null,
      typeof weather?.humidity === 'number' ? `${Math.round(weather.humidity)}% humidity` : null,
      typeof weather?.condition === 'string' ? weather.condition : null,
    ].filter(Boolean);
    return weatherParts.length > 0 ? weatherParts.join(' / ') : 'Weather context ready when available';
  }, [weather]);

  // Surface progress to the host so the title + progress + close can render in a
  // header strip above the bordered card rather than crowding the panel interior.
  useEffect(() => {
    onStatusChange?.({ progress, progressText, contextLine });
  }, [onStatusChange, progress, progressText, contextLine]);

  // The agent surfaces quick replies only for the cue it is currently asking
  // about, so they appear and disappear with the conversation instead of always
  // crowding the panel. Once there is enough context the lane is empty and the
  // Confirm action takes over.
  const neededFacet = nextNeededFacet(facets, mission, agentMode, items.length);
  const visibleQuickReplies = useMemo(() => {
    if (!neededFacet) return [];
    // A choice for the current question is already staged in the composer; keep
    // the lane clear until it is sent or cleared.
    if (pendingCueFacet === neededFacet) return [];
    return QUICK_REPLIES.filter((reply) => reply.facet === neededFacet);
  }, [neededFacet, pendingCueFacet]);

  const appendMessage = useCallback(
    (
      role: PanelMessage['role'],
      text: string,
      meta?: { activity?: BeamActivityStep[]; elapsedMs?: number | null },
    ) => {
      setMessages((prev) => [
        ...prev,
        {
          id: newMessageId(),
          role,
          text,
          ...(meta?.activity && meta.activity.length > 0
            ? { activity: meta.activity, elapsedMs: meta.elapsedMs ?? null }
            : {}),
        },
      ]);
    },
    [],
  );

  // Append an agent line after running it through the formatter: strips internal
  // tool/debug wording, collapses repeated catalog status rows, and fronts a
  // catalog-unavailable answer with polished, user-facing copy. Flips the
  // catalog-failure flag so the cue lane can surface recovery actions.
  const pushAgentText = useCallback(
    (
      raw: string,
      meta?: { activity?: BeamActivityStep[]; elapsedMs?: number | null },
    ): { catalogUnavailable: boolean } => {
      const { text, catalogUnavailable } = formatAgentResponse(raw);
      if (catalogUnavailable) setCatalogFailure(true);
      if (text) appendMessage('agent', text, meta);
      return { catalogUnavailable };
    },
    [appendMessage],
  );

  const callMission = useCallback(
    async (
      body: {
        action: 'chat' | 'execute_node';
        nodeId?: ScentMissionNodeId;
        userMessage?: string;
      },
      missionState: ScentMissionState,
    ): Promise<ScentMissionResponse | null> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Distinguish a timeout-abort (surface a real message) from a
      // supersede-abort (a newer request replaced this one — stay silent).
      let didTimeout = false;
      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, MISSION_TIMEOUT_MS);

      try {
        const res = await fetch(SCENT_MISSION_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            ...body,
            sessionId: sessionIdRef.current,
            mission: missionState,
            context: {
              weather: buildMissionWeather(weather),
              wardrobe: buildMissionWardrobe(items),
            },
          }),
        });

        const data = (await res.json().catch(() => null)) as
          | (ScentMissionResponse & { error?: string })
          | null;
        if (!res.ok || !data) {
          throw new Error(data?.error || `Mission request failed (${res.status}).`);
        }
        return data;
      } catch (err) {
        // A timeout reads as a normal failure (not an AbortError), so the turn's
        // catch handler shows a "try again" line instead of silently hanging.
        if (didTimeout) {
          throw new Error('The Beam Agent took too long to respond. Try again.');
        }
        throw err;
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    [authToken, items, weather],
  );

  // Conversational turns go to the live Beam Agent (tool-calling, grounded in the
  // signed-in user's vault). Returns `handled: true` when the agent answered (or
  // the turn was superseded by a newer one), and `false` when the caller should
  // fall back to the scripted `/api/scent-mission` path — so a missing
  // OPENROUTER_API_KEY or any agent error never leaves the user without a reply.
  const runAgentTurn = useCallback(
    async (message: string): Promise<{ handled: boolean }> => {
      // Guests have no token; the agent requires auth, so use the scripted path.
      if (!authToken) return { handled: false };

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Fresh trail per run — each turn tells its own story of steps. Any cues,
      // proposal, OR curated-match reveal from a previous reply are now stale (the
      // user just answered). `resolved` belongs to the scripted resolution path and
      // is NOT produced by the agent; if a prior scripted turn left one mounted it
      // would otherwise linger pinned at the bottom of the scroll, decoupled from
      // the live conversation (the "curated match stuck under the chat" bug).
      activityIdRef.current = 0;
      setActivity([]);
      setAgentSuggestions([]);
      setProposal(null);
      setCurating(null);
      setResolved(null);

      let didTimeout = false;
      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, BEAM_AGENT_TIMEOUT_MS);

      try {
        const result = await runBeamAgentMission({
          message,
          sessionId: sessionIdRef.current,
          weather: buildMissionWeather(weather),
          authToken,
          apiBaseUrl: API_BASE_URL,
          signal: controller.signal,
          onEvent: (event) => {
            // Build the ordered activity trail AND keep the one-line header note
            // (progressNote) in sync for the host strip above the card.
            if (event.type === 'status') {
              setProgressNote(event.label);
              const id = (activityIdRef.current += 1);
              setActivity((prev) => pushStatusStep(prev, id, event.label));
            } else if (event.type === 'tool_started') {
              setProgressNote(humanizeBeamTool(event.tool));
              const id = (activityIdRef.current += 1);
              setActivity((prev) => pushToolStep(prev, id, event.tool));
            } else if (event.type === 'tool_completed') {
              const id = (activityIdRef.current += 1);
              setActivity((prev) => completeToolStep(prev, id, event.tool, event.summary));
            } else if (event.type === 'suggestions') {
              // Stored now; rendered as cue chips once the run settles (!busy).
              setAgentSuggestions(event.items);
            } else if (event.type === 'proposal') {
              // The agent lined up a collection — surface a confirmation card
              // once the run settles. Nothing is added until the user taps Confirm.
              if (event.items.length > 0) setProposal({ proposalId: event.proposalId, items: event.items });
            } else if (event.type === 'message_delta') {
              // Synthesis is streaming the answer — hold a stable phase note
              // rather than flashing raw partial text.
              setProgressNote('Writing your recommendation');
            }
          },
        });

        if (result.status === 'completed') {
          sessionIdRef.current = result.sessionId;
          setSessionId(result.sessionId);
          // Freeze this run's trail onto the reply: seal any still-active row (the
          // run is over) and capture the elapsed time, so the answer carries its
          // own collapsible "Thought for Ns" recap above it.
          const frozenSteps = activityListRef.current.map((step) =>
            step.state === 'active' ? { ...step, state: 'done' as const } : step,
          );
          const elapsedMs =
            runStartedAtRef.current != null ? Date.now() - runStartedAtRef.current : null;
          pushAgentText(result.response, { activity: frozenSteps, elapsedMs });
          return { handled: true };
        }
        // status === 'failed' (model_unavailable, max_turns, agent_error, …):
        // fall back to the scripted path so the user still gets an answer.
        return { handled: false };
      } catch (err) {
        // A supersede-abort (newer turn replaced this one) must stay silent and
        // NOT trigger the fallback. A timeout-abort or network error falls back.
        if (controller.signal.aborted && !didTimeout) {
          return { handled: true };
        }
        return { handled: false };
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    [authToken, pushAgentText, weather],
  );

  const applyResponse = useCallback(
    (
      response: ScentMissionResponse,
      base: ScentMissionState,
      options?: { appendAssistant?: boolean },
    ) => {
      sessionIdRef.current = response.sessionId;
      setSessionId(response.sessionId);
      const nextMission = applyScentMissionUpdates(base, response.nodeUpdates, response.missionPatch);
      setMission(nextMission);

      const patchedCalibration = response.missionPatch?.calibration;
      if (patchedCalibration?.destination || patchedCalibration?.energy) {
        setFacets((prev) => ({
          ...prev,
          ...(patchedCalibration.destination ? { occasion: patchedCalibration.destination } : {}),
          ...(patchedCalibration.energy ? { mood: patchedCalibration.energy } : {}),
        }));
      }

      if (response.recommendation) {
        setResolved({
          recommendation: response.recommendation,
          item: findWardrobeMatch(items, response.recommendation),
        });
      }

      if (options?.appendAssistant) {
        const text = response.recommendation
          ? recommendationMessage(response.recommendation)
          : response.premiumLock
            ? 'Premium mode is staged for deeper note architecture. Standard curation remains ready here.'
            : response.assistantMessage;
        if (text) appendMessage('agent', text);
      }
      return nextMission;
    },
    [appendMessage, items],
  );

  const updateFacetsAndMission = useCallback(
    (
      nextFacetPatch: FacetState,
      calibration?: { destination?: ScentMissionDestination; energy?: ScentMissionEnergy },
      baseMission = mission,
    ) => {
      const nextFacets = { ...facets, ...nextFacetPatch };
      const nextMission = mergeCalibration(baseMission, calibration?.destination, calibration?.energy);
      setFacets(nextFacets);
      setMission(nextMission);
      return { nextFacets, nextMission };
    },
    [facets, mission],
  );

  const runResolution = useCallback(
    async (
      trigger: 'fast' | 'curate',
      startingMission = mission,
      startingFacets = facets,
    ) => {
      if (busy) return;
      if (items.length === 0) {
        appendMessage('agent', firstMissingPrompt(startingFacets, startingMission, agentMode, items.length));
        return;
      }

      let currentMission = trigger === 'fast'
        ? missionWithDefaultsForFast(startingMission)
        : startingMission;

      if (!currentMission.calibration.destination || !currentMission.calibration.energy) {
        appendMessage('agent', firstMissingPrompt(startingFacets, currentMission, agentMode, items.length));
        setMission(currentMission);
        return;
      }

      setBusy(true);
      setResolved(null);
      setActivity([]);
      setAgentSuggestions([]);
      setProposal(null);
      setCurating(null);
      setCatalogFailure(false);
      setMission(currentMission);
      setProgressNote(trigger === 'fast' ? 'Fast curation in progress' : 'Curating from your vault');

      try {
        for (const nodeId of RESOLUTION_SEQUENCE) {
          const nodeStatus = currentMission.nodes[nodeId];
          if (nodeStatus === 'complete') continue;
          if (nodeStatus === 'locked') {
            appendMessage('system', 'The Beam Agent needs one more cue before it can continue.');
            break;
          }

          const runningMission: ScentMissionState = {
            ...currentMission,
            nodes: { ...currentMission.nodes, [nodeId]: 'running' },
          };
          setMission(runningMission);
          setProgressNote(PROGRESS_COPY[nodeId]);
          const response = await callMission({ action: 'execute_node', nodeId }, runningMission);
          if (!response) continue;
          currentMission = applyResponse(response, runningMission, {
            appendAssistant: nodeId === 'resolution-standard',
          });
          if (response.recommendation) break;
        }
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          appendMessage(
            'system',
            err instanceof Error ? err.message : 'The Beam Agent could not complete that turn. Try again.',
          );
        }
      } finally {
        setBusy(false);
        setProgressNote('');
      }
    },
    [agentMode, appendMessage, applyResponse, busy, callMission, facets, items.length, mission],
  );

  const handleQuickReply = useCallback(
    (reply: QuickReply) => {
      if (busy) return;
      // A cue is a shortcut for typing — it drops the option straight into the
      // composer instead of firing a chat message. The user reviews it and hits
      // send (or refines it) so nothing is committed behind their back, and the
      // conversation stays clean. We deliberately do not focus the field, so the
      // mobile keyboard stays down and the next cue is a tap away.
      setComposer(reply.label);
      setPendingCueFacet(reply.facet);
    },
    [busy],
  );

  // An agent-offered chip (follow-up question answer). Same low-friction pattern
  // as a facet cue — it fills the composer so the user reviews + sends — but it
  // carries no facet, so the staged-cue Confirm/Cancel pair is not implied.
  const handleAgentSuggestion = useCallback(
    (suggestion: BeamSuggestion) => {
      if (busy) return;
      setComposer(suggestion.value || suggestion.label);
      setPendingCueFacet(null);
    },
    [busy],
  );

  // The user approved the proposed collection. Add each through the host's
  // normal wardrobe path, holding a "curating" state until they're ready, then
  // report back. This is the only place the flow writes to the vault.
  const handleConfirmProposal = useCallback(async () => {
    if (!proposal || !onCurateCollection || curating) return;
    const collection = proposal.items;
    setProposal(null);
    setCurating({ total: collection.length, progress: null, done: null });
    try {
      const result = await onCurateCollection(collection, (p) => {
        setCurating((prev) => ({ total: collection.length, done: prev?.done ?? null, progress: p }));
      });
      setCurating({ total: collection.length, progress: null, done: result });
      const names = collection.map((item) => item.name);
      const summary =
        result.added === 0
          ? "I couldn't add those to your vault just now — want me to try again?"
          : result.added === result.total
            ? `Done — all ${result.total} are in your vault and curated: ${names.join(', ')}. Ready to wear.`
            : `Added ${result.added} of ${result.total} to your vault — the rest are still curating and will appear shortly.`;
      appendMessage('agent', summary);
    } catch {
      setCurating(null);
      appendMessage('system', 'Adding the collection ran into a problem. Please try again.');
    }
  }, [proposal, onCurateCollection, curating, appendMessage]);

  const handleDeclineProposal = useCallback(() => {
    if (curating && !curating.done) return;
    setProposal(null);
    appendMessage('agent', "No problem — I'll hold off. Tell me what to change and I'll line up a different set.");
  }, [curating, appendMessage]);

  // The core send path, decoupled from the form event so recovery actions (e.g.
  // "Retry catalog search") can re-run a turn without retyping. `echoUser` adds
  // the user bubble (false for an automatic retry of the prior turn).
  const submitMessage = useCallback(
    async (rawText: string, opts?: { echoUser?: boolean }) => {
      const trimmed = rawText.trim();
      if (!trimmed || busy || (curating !== null && curating.done === null)) return;
      const echoUser = opts?.echoUser ?? true;

      // A fresh turn clears any prior catalog-failure recovery state.
      setCatalogFailure(false);
      setLastUserMessage(trimmed);
      if (echoUser) appendMessage('user', trimmed);

      const inferred = inferTextFacets(trimmed);
      const { nextFacets, nextMission } = updateFacetsAndMission(
        inferred.facets,
        { destination: inferred.destination, energy: inferred.energy },
      );
      const canCurate = hasEnoughContext(nextFacets, nextMission, agentMode);

      // Routing. Fast mode is the express scripted lane: skip the conversation
      // and curate straight into the "Curated match" reveal card. Every other
      // mode sends free text to the live tool-calling agent (the conversational
      // brain) — it answers in the chat, grounded in the real vault + catalog.
      // The scripted reveal card is reserved for the EXPLICIT Confirm / Curate
      // button so the two engines never interleave inside one conversation (the
      // bug where a typed request surprised the user with a reveal card while
      // they were mid-chat with the agent).
      if (agentMode === 'fast') {
        await runResolution('fast', nextMission, nextFacets);
        return;
      }

      setBusy(true);
      setProgressNote('Thinking');
      const thinkingStartedAt = Date.now();
      try {
        // Try the live tool-calling agent first. If it answers (or is superseded)
        // we're done; otherwise fall through to the scripted mission path below.
        const agentTurn = await runAgentTurn(trimmed);
        if (agentTurn.handled) {
          return;
        }
        // Agent declined/failed — drop its trail so the scripted fallback shows
        // its own plain thinking beat, not a half-built agent timeline.
        setActivity([]);

        const response = await callMission(
          { action: 'chat', userMessage: modeInstruction(agentMode, tone, trimmed) },
          nextMission,
        );
        // Hold the typing beat for a deliberate minimum so the reply (and the
        // next set of cues) never snaps in before the user can read it.
        const elapsed = Date.now() - thinkingStartedAt;
        if (!calmMotion && elapsed < MIN_THINKING_MS) {
          await new Promise((resolve) => setTimeout(resolve, MIN_THINKING_MS - elapsed));
        }
        if (response) {
          applyResponse(response, nextMission, { appendAssistant: false });
        }
        const fallback = firstMissingPrompt(nextFacets, nextMission, agentMode, items.length);
        const assistantText = canCurate ? ENOUGH_CONTEXT_PROMPT : fallback;
        pushAgentText(safeAssistantText(response?.assistantMessage, assistantText));
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          appendMessage('system', err instanceof Error ? err.message : 'The Beam Agent is unreachable. Try again.');
          appendMessage('agent', firstMissingPrompt(nextFacets, nextMission, agentMode, items.length));
        }
      } finally {
        setBusy(false);
        setProgressNote('');
      }
    },
    [
      agentMode,
      appendMessage,
      applyResponse,
      busy,
      calmMotion,
      callMission,
      curating,
      items.length,
      pushAgentText,
      runAgentTurn,
      runResolution,
      tone,
      updateFacetsAndMission,
    ],
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = composer.trim();
      if (!trimmed || busy || (curating !== null && curating.done === null)) return;
      setComposer('');
      await submitMessage(trimmed, { echoUser: true });
    },
    [busy, composer, curating, submitMessage],
  );

  // ── State-aware recovery / refinement actions ──────────────────────────────
  // Catalog-failure recovery: re-run the same turn, curate from the vault, or
  // invite the user to name bottles to search.
  const retryCatalog = useCallback(() => {
    if (busy) return;
    const msg = lastUserMessage.trim();
    if (msg) void submitMessage(msg, { echoUser: false });
    else void runResolution('curate');
  }, [busy, lastUserMessage, runResolution, submitMessage]);

  const promptManualBottles = useCallback(() => {
    if (busy) return;
    setCatalogFailure(false);
    appendMessage(
      'agent',
      "Tell me the bottles you'd like me to look at — type a name or two and I'll work them into the rotation.",
    );
    composerRef.current?.focus();
  }, [appendMessage, busy]);

  // Completed-state actions: refine the pick, look at more bottles, or restart.
  const refinePick = useCallback(() => {
    if (busy) return;
    appendMessage(
      'agent',
      'Happy to adjust — tell me what to change: lighter, bolder, a different vibe, or a new setting.',
    );
    composerRef.current?.focus();
  }, [appendMessage, busy]);

  const startOver = useCallback(() => {
    if (busy) return;
    abortRef.current?.abort();
    setResolved(null);
    setCatalogFailure(false);
    setFacets({});
    setMission(createScentMissionState());
    setComposer('');
    setPendingCueFacet(null);
    setProgressNote('');
    appendMessage('agent', 'Fresh start — tell me about your day and I will curate again.');
  }, [appendMessage, busy]);

  const handlePremiumPreview = useCallback(async () => {
    if (busy) return;
    setAgentMode('premium');
    setBusy(true);
    setProgressNote(PROGRESS_COPY['resolution-premium']);
    try {
      const response = await callMission({ action: 'execute_node', nodeId: 'resolution-premium' }, mission);
      if (response) applyResponse(response, mission, { appendAssistant: true });
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        appendMessage('system', err instanceof Error ? err.message : 'Premium preview is unavailable.');
      }
    } finally {
      setBusy(false);
      setProgressNote('');
    }
  }, [appendMessage, applyResponse, busy, callMission, mission]);

  const handleReveal = useCallback(() => {
    if (!resolved?.item) return;
    onRevealMatch(resolved.item, resolved.recommendation.engine, resolved.recommendation.reason);
  }, [onRevealMatch, resolved]);

  // Bridge the live agent's structured pick to the SAME immersive overlay the
  // scripted resolver opens. The agent's proposal already carries the catalog
  // profile, so we score the hero (item[0]) client-side against the current
  // weather + calibration and project it into the reveal — no second server
  // round-trip, and it stays coherent with the chat (it's this turn's own pick).
  const proposalReveal = useMemo(
    () =>
      proposal && proposal.items.length > 0
        ? buildAgentReveal(proposal.items[0], mission.calibration, buildMissionWeather(weather))
        : null,
    [proposal, mission.calibration, weather],
  );

  const handleRevealProposalHero = useCallback(() => {
    if (!proposalReveal) return;
    onRevealMatch(proposalReveal.fragrance, proposalReveal.engine, proposalReveal.reason);
  }, [onRevealMatch, proposalReveal]);

  // The placeholder doubles as the instructions: tap a cue below to fill this
  // field, or type — then send. Keeps the flow self-evident with no extra chrome.
  const composerPlaceholder =
    agentMode === 'fast'
      ? 'Tap a cue below or type, then send'
      : agentMode === 'premium'
        ? 'Tap a cue or describe the impression'
        : 'Tap a cue below, or describe your day';

  const actionControls = (
    <div className="relative mx-auto mt-4 w-full max-w-[42.75rem] sm:mt-5">
      <div className="mb-2 flex min-h-[1.25rem] items-center justify-end gap-2 pr-1">
        {/* The large persistent "BEAM AGENT" caption used to sit here and eat
            vertical space while labeling nothing. We now show ONLY the live
            status while the agent is working; at rest the small avatar badge
            alone signals the concierge. */}
        <AnimatePresence initial={false}>
          {busy ? (
            <motion.span
              key="beam-agent-thinking"
              initial={calmMotion ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: 3 }}
              transition={{ duration: 0.18, ease: SCENT_EASE }}
              className="scent-type-label text-scent-accent/70"
              data-thinking="true"
            >
              {progressNote || 'Thinking'}
            </motion.span>
          ) : null}
        </AnimatePresence>
        {/* Pulse the avatar while the agent is busy OR composing its opening
            greeting, so the open reads as the agent coming alive and writing —
            not a static panel that suddenly drops dots into an empty box. */}
        <span
          className="scent-beam-avatar"
          data-thinking={busy || !introReady ? 'true' : undefined}
        >
          <img
            src="/scent-concierge-avatar.png"
            alt="ScentCast Beam Agent"
            width={36}
            height={36}
            loading="lazy"
            decoding="async"
            className="h-9 w-9 rounded-full border border-scent-accent/35 object-cover shadow-[0_2px_10px_rgba(0,0,0,0.45)]"
          />
        </span>
      </div>
      <form
        ref={composerFormRef}
        onSubmit={handleSubmit}
        className="scent-lux-input scent-vault-search-input scent-beam-composer flex h-[60px] w-full items-center gap-2 rounded-full px-2.5 transition-colors sm:h-[68px] sm:px-3.5"
      >
        <button
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-controls="scent-mission-settings"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-scent-accent/35 bg-black/35 text-scent-accent transition-colors hover:bg-scent-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
          aria-label="Adjust Beam Agent settings"
          title="Adjust settings"
        >
          <SlidersHorizontal size={17} strokeWidth={1.8} aria-hidden />
        </button>
        <input
          ref={composerRef}
          type="text"
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => {
            setComposerFocused(false);
            recoverViewportAfterKeyboard();
          }}
          placeholder={composerFocused ? '' : composerPlaceholder}
          aria-label="Message the Beam Agent"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-1 text-center text-sm font-medium text-[#fff7ec] outline-none placeholder:text-scent-text-subtle sm:text-base"
        />
        <button
          type="submit"
          disabled={busy || !composer.trim() || (curating !== null && curating.done === null)}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-scent-accent/42 bg-black/35 text-scent-accent transition-colors hover:bg-scent-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:opacity-40"
          aria-label="Send message"
        >
          {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Send size={16} aria-hidden />}
        </button>
      </form>

      <AnimatePresence initial={false}>
        {settingsOpen ? (
          <motion.div
            id="scent-mission-settings"
            initial={calmMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            transition={calmMotion ? { duration: 0.18, ease: [0.22, 1, 0.36, 1] } : { type: 'spring', stiffness: 380, damping: 30 }}
            className="absolute bottom-full left-0 right-0 z-20 mb-3 rounded-[calc(var(--radius-scent)-8px)] border border-scent-accent/22 bg-[#0c0a07]/95 p-3 text-center shadow-[0_-10px_34px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,236,183,0.06)]"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="scent-type-label mb-1.5 text-center text-scent-accent/80">Response mode</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {MODE_OPTIONS.map(({ id, label, icon: Icon }) => {
                    const selected = agentMode === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setAgentMode(id)}
                        aria-pressed={selected}
                        className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40 ${
                          selected
                            ? 'border-scent-accent/78 bg-scent-accent/13 text-[#fff7ec]'
                            : 'border-white/20 text-scent-text-muted hover:border-scent-accent/45 hover:text-[#fff7ec]'
                        }`}
                      >
                        <Icon size={12} strokeWidth={2} aria-hidden />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="scent-type-label mb-1.5 text-center text-scent-accent/80">Tone</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {TONE_OPTIONS.map(({ id, label }) => {
                    const selected = tone === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTone(id)}
                        aria-pressed={selected}
                        className={`min-h-8 rounded-full border px-3 py-1 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40 ${
                          selected
                            ? 'border-scent-accent/70 text-[#fff7ec]'
                            : 'border-white/18 text-scent-text-muted hover:border-scent-accent/42 hover:text-[#fff7ec]'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );

  // The impressions / Confirm lane lives BELOW the card (portaled into the host
  // container) so it never crowds or shrinks the conversation. When there are
  // more than two contextual cues they scroll as a marquee any time the agent is
  // waiting on input; two or fewer stay centered and static.
  const showCueMarquee = !calmMotion && visibleQuickReplies.length > 2;

  // Changes whenever the cue set changes, the cue bar becomes ready, or the portal
  // container is resolved. This ensures the swipe listeners attach against the live DOM node.
  const cueMarqueeKey = `${cuesReady}-${Boolean(cueBarContainer)}|` +
    visibleQuickReplies.map((reply) => `${reply.facet}-${reply.value}`).join('|');

  // Make the cue marquee swipeable like every other marquee in the app (hero,
  // atmosphere, community) instead of a pause-only CSS ticker — and, critically,
  // give it the iOS pan-y/touchmove contract the shared hook owns so horizontal
  // drags survive Safari's pointercancel.
  useMarqueeSwipe(cueTrackRef, {
    distanceVar: '--cue-marquee-distance',
    durationVar: '--cue-marquee-duration',
    resetKey: cueMarqueeKey,
  });

  // Feed the hook the live loop distance: the `-50%` keyframe advances by exactly
  // one group's width per loop, so the measured group width is the px distance.
  useLayoutEffect(() => {
    if (!showCueMarquee) return;
    const track = cueTrackRef.current;
    const group = cueGroupRef.current;
    if (!track || !group) return;
    let cancelled = false;
    let raf = 0;

    const measure = () => {
      if (cancelled) return;
      const distance = group.getBoundingClientRect().width;
      if (distance <= 0) return;
      track.style.setProperty('--cue-marquee-distance', `${distance}px`);
      track.dataset.marqueeReady = 'true';
    };

    track.dataset.marqueeReady = 'false';
    const start = () => {
      raf = window.requestAnimationFrame(measure);
    };
    // Fonts changing width after load would desync the loop; measure once they settle.
    if (document.fonts?.ready) {
      void document.fonts.ready.then(start);
    } else {
      start();
    }

    const resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(group);
    window.addEventListener('resize', measure);

    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [showCueMarquee, cueMarqueeKey]);

  const cueChipClass =
    'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/20 px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40 disabled:opacity-45';

  const renderCueChip = (reply: QuickReply, key: string) => (
    <button
      key={key}
      type="button"
      onClick={() => handleQuickReply(reply)}
      disabled={busy}
      data-facet={reply.facet}
      className={cueChipClass}
      title={`${FACET_LABELS[reply.facet]}: ${reply.value}`}
    >
      {reply.label}
    </button>
  );

  // The curated-match reveal is the payoff of the whole flow, so it does not
  // simply pop in: the card eases up while its lines stagger in beneath it.
  const revealContainer = useMemo(
    () => ({
      hidden: calmMotion ? {} : { opacity: 0, y: 12, scale: 0.985 },
      show: {
        opacity: 1,
        y: 0,
        scale: 1,
        transition: calmMotion
          ? { duration: 0 }
          : { duration: 0.46, ease: SCENT_EASE, staggerChildren: 0.07, delayChildren: 0.1 },
      },
    }),
    [calmMotion],
  );
  const revealItem = useMemo(
    () => ({
      hidden: calmMotion ? {} : { opacity: 0, y: 8 },
      show: {
        opacity: 1,
        y: 0,
        transition: calmMotion ? { duration: 0 } : { duration: 0.36, ease: SCENT_EASE },
      },
    }),
    [calmMotion],
  );

  const hasConfirmAction = items.length > 0 && (enoughContext || agentMode === 'fast');
  const hasPreviewAction = agentMode === 'premium';
  const hasActionRow = hasConfirmAction || hasPreviewAction;
  // A cue has been tapped into the composer but not sent yet. Tapping a cue used
  // to blank the lane entirely, forcing the user to hunt for the small send
  // arrow; instead we surface an explicit Confirm / Cancel pair right where the
  // cues were.
  const hasStagedCue = Boolean(pendingCueFacet) && composer.trim().length > 0;
  // ── State-aware cue lane ───────────────────────────────────────────────────
  // The lane's content tracks the conversation state instead of always showing
  // vibe cues: after a catalog failure it offers recovery actions; after a
  // curated match it offers refine / search-more / restart. These take over the
  // lane (the vibe cues, agent suggestions, and Confirm row are suppressed) so
  // the chips below the card always match what just happened.
  type StateAction = { key: string; label: string; icon: LucideIcon; onClick: () => void };
  const recoveryActions: StateAction[] =
    catalogFailure && !resolved
      ? [
          { key: 'retry', label: 'Retry catalog search', icon: RefreshCw, onClick: retryCatalog },
          {
            key: 'vault',
            label: 'Build from my vault',
            icon: Sparkles,
            onClick: () => void runResolution('curate'),
          },
          { key: 'manual', label: "I'll name bottles to search", icon: Search, onClick: promptManualBottles },
        ]
      : [];
  const completedActions: StateAction[] = resolved
    ? [
        { key: 'refine', label: 'Refine this pick', icon: Wand2, onClick: refinePick },
        { key: 'more', label: 'Search more bottles', icon: Search, onClick: promptManualBottles },
        { key: 'restart', label: 'Start over', icon: RotateCcw, onClick: startOver },
      ]
    : [];
  const stateActions = recoveryActions.length ? recoveryActions : completedActions;
  const hasStateActions = stateActions.length > 0;
  const stateActionLabel = recoveryActions.length ? 'Catalog unavailable — pick a path' : 'What next?';

  // The agent asked a follow-up and offered tap chips. While they're showing
  // they own the lane — they ARE the answer to its question — so they take
  // precedence over the static facet cues until the user taps or types. A strong
  // conversation state (catalog failure / resolved match) still outranks them.
  const showAgentSuggestions = agentSuggestions.length > 0 && !busy && !hasStateActions;
  // Hold the whole lane back until the greeting has settled, so the panel never
  // opens with a row of cues already sitting there.
  const cueBar =
    !cuesReady ||
    (!hasStateActions &&
      !showAgentSuggestions &&
      visibleQuickReplies.length === 0 &&
      !hasActionRow &&
      !hasStagedCue) ? null : (
      <motion.div
        initial={calmMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
        transition={{ duration: 0.42, ease: SCENT_EASE }}
        className="mx-auto w-full max-w-[42.75rem]"
        aria-label="Beam Agent quick replies"
        data-testid="scent-mission-cue-bar"
      >
        {hasStateActions ? (
          <div data-testid="scent-mission-state-actions">
            <p className="scent-type-label text-center text-scent-text-subtle">{stateActionLabel}</p>
            <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
              {stateActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.key}
                    type="button"
                    onClick={action.onClick}
                    disabled={busy}
                    className={cueChipClass}
                  >
                    <Icon size={12} aria-hidden />
                    {action.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : showAgentSuggestions ? (
          <div className="flex flex-col items-center" data-testid="beam-agent-suggestions">
            <p className="scent-type-label text-center text-scent-text-subtle">
              Tap to answer, or type your own
            </p>
            <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
              {agentSuggestions.map((suggestion, index) => (
                <motion.button
                  key={`${suggestion.label}-${index}`}
                  type="button"
                  onClick={() => handleAgentSuggestion(suggestion)}
                  disabled={busy}
                  initial={calmMotion ? false : { opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.18, ease: SCENT_EASE, delay: calmMotion ? 0 : index * 0.045 }}
                  className={cueChipClass}
                  title={suggestion.label}
                >
                  {suggestion.label}
                </motion.button>
              ))}
            </div>
          </div>
        ) : (
          <>
        {hasActionRow ? (
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {hasConfirmAction ? (
              <button
                type="button"
                onClick={() => void runResolution(agentMode === 'fast' ? 'fast' : 'curate')}
                disabled={busy}
                className="scent-primary-button scent-beam-confirm-button inline-flex min-h-11 shrink-0 items-center justify-center rounded-[var(--radius-scent)] px-7 py-2.5 text-[12px] font-bold uppercase tracking-[0.18em] disabled:opacity-55"
              >
                <span>Confirm</span>
              </button>
            ) : null}
            {hasPreviewAction ? (
              <button
                type="button"
                onClick={() => void handlePremiumPreview()}
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-scent-accent/42 px-3 py-1.5 scent-type-chip text-scent-accent transition-colors hover:bg-scent-accent/10 disabled:opacity-45"
              >
                <Lock size={12} aria-hidden />
                Preview
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Contextual cues for the agent's current question. A single quiet line
            spells out the flow so the lane needs no thinking: tap → it fills the
            box → send. */}
        {visibleQuickReplies.length > 0 ? (
          <>
          <p className={`scent-type-label text-center text-scent-text-subtle ${hasActionRow ? 'mt-2.5' : ''}`}>
            Choose a cue or type your own
          </p>
          {showCueMarquee ? (
            <div
              className="scent-cue-marquee mt-1.5"
              data-marquee-paused={marqueePaused || busy ? 'true' : undefined}
              onPointerDown={() => setMarqueePaused(true)}
              onPointerUp={() => setMarqueePaused(false)}
              onPointerCancel={() => setMarqueePaused(false)}
              onPointerLeave={() => setMarqueePaused(false)}
            >
              <div
                ref={cueTrackRef}
                className="scent-cue-marquee-track"
                style={{ '--cue-marquee-duration': `${Math.max(visibleQuickReplies.length * 3.2, 9)}s` } as React.CSSProperties}
              >
                {[0, 1].map((copy) => (
                  <div
                    className="scent-cue-marquee-group"
                    key={copy}
                    ref={copy === 0 ? cueGroupRef : undefined}
                    aria-hidden={copy === 1}
                  >
                    {visibleQuickReplies.map((reply) =>
                      renderCueChip(reply, `${copy}-${reply.facet}-${reply.value}`),
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div
              ref={quickReplyScrollRef}
              className="mt-1.5 flex flex-nowrap items-center justify-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide select-none"
              style={{ touchAction: 'pan-x', overscrollBehaviorX: 'contain' }}
            >
              <AnimatePresence initial={false} mode="popLayout">
                {visibleQuickReplies.map((reply) => (
                  <motion.button
                    key={`${reply.facet}-${reply.value}`}
                    type="button"
                    onClick={() => handleQuickReply(reply)}
                    disabled={busy}
                    data-facet={reply.facet}
                    initial={calmMotion ? false : { opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={calmMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className={cueChipClass}
                    title={`${FACET_LABELS[reply.facet]}: ${reply.value}`}
                  >
                    {reply.label}
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
          )}
          </>
        ) : null}

        {/* Staged choice: a cue is sitting in the composer waiting to be sent.
            Give it an explicit Confirm / Cancel pair instead of a blank lane. */}
        {visibleQuickReplies.length === 0 && !hasActionRow && hasStagedCue ? (
          <div className="-mt-2 flex flex-col items-center">
            <p className="scent-type-label mb-1.5 text-center text-scent-text-subtle">
              Send this, or edit it above
            </p>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => composerFormRef.current?.requestSubmit()}
                disabled={busy}
                className="scent-primary-button inline-flex min-h-10 items-center justify-center rounded-[var(--radius-scent)] px-5 py-2 text-[11px] font-bold uppercase tracking-[0.16em] disabled:opacity-55"
              >
                <span>Confirm</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setComposer('');
                  setPendingCueFacet(null);
                }}
                disabled={busy}
                className="inline-flex min-h-10 items-center justify-center rounded-full border border-white/20 px-4 py-1.5 scent-type-chip text-[11px] text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] disabled:opacity-45"
              >
                <span>Cancel</span>
              </button>
            </div>
          </div>
        ) : null}
          </>
        )}
      </motion.div>
    );

  // Anchor the scroll-to-top behavior on the newest agent reply (its top is
  // aligned to the top of the box). Only the LAST message qualifies, so the
  // user's own turn still follows to the bottom.
  const lastMessage = messages[messages.length - 1];
  const latestAgentId = lastMessage && lastMessage.role === 'agent' ? lastMessage.id : null;

  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-col text-center" data-testid="scent-mission-panel">
      {/* The title, progress, and close control now live in a header strip above
          the card (see App.tsx) so this surface is just the conversation. */}
      <div className="relative mx-auto w-full max-w-[42.75rem]">
      {/* Subtle top/bottom fade hints — shown only when the conversation actually
          overflows above/below, so a long answer reads as "more to scroll"
          rather than a hard clip. Pointer-events-none keeps them non-blocking. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-black to-transparent transition-opacity duration-300 ${scrollEdges.top ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-7 bg-gradient-to-t from-black to-transparent transition-opacity duration-300 ${scrollEdges.bottom ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={scrollRef}
        onScroll={updateScrollEdges}
        className="flex w-full h-[min(34dvh,17rem)] flex-col gap-2.5 overflow-y-auto pr-1 text-left scrollbar-hide sm:h-[min(36dvh,20rem)]"
        role="log"
        aria-live="polite"
        aria-label="Beam Agent conversation"
      >
        {/* Intro: the greeting opens as a compact pill holding just the typing
            dots — the agent visibly "thinking" — then the pill GROWS into its
            full first line (`layout="size"`, ~0.52s) while the welcome text
            fades up inside it. The dots are popped out of flow the instant the
            line is ready, so the bubble measures straight to its final size and
            the box morph carries that growth in one smooth pass. This morph is
            the open's "appeal" beat; only the greeting runs it — every other
            turn (and the greeting itself, once introReady) renders real TEXT,
            never a permanent dots placeholder. */}
        {messages.map((message, index) => {
          const isIntroGreeting = index === 0 && message.role === 'agent';
          // Keep the stage empty until the greeting beat — the bubble (and its
          // dots) only mount once the open transition has settled (420ms).
          if (isIntroGreeting && !greetingMounted) return null;
          // The greeting shows dots until the compose hold elapses (introReady),
          // then morphs into its line. No other message is ever in "typing".
          const typing = isIntroGreeting && !introReady;
          const isLatestAgent = message.id === latestAgentId;
          // A completed agent turn carries its own frozen "thinking" steps; we
          // render them as a collapsible recap directly ABOVE this answer (the
          // ChatGPT / Claude pattern). While the newest run is still settling
          // (busy) the live trail below is animating out, so hold this recap one
          // beat to keep the two from stacking for a frame.
          // `hasRecap` is a fixed property of the message (its frozen steps), so
          // the wrapper structure never changes across a busy→settled flip and the
          // answer bubble never remounts. `showRecap` only gates the recap's
          // visibility — held one beat on the newest turn while the live trail
          // below animates out, so the two never stack.
          const recapSteps = message.role === 'agent' ? message.activity : undefined;
          const hasRecap = !!recapSteps && recapSteps.length > 0;
          const showRecap = hasRecap && (!busy || !isLatestAgent);
          const bubble = (
            <motion.div
              key={message.id}
              // The newest agent reply carries the scroll-to-top anchor — unless a
              // recap wrapper above takes it — so a long answer lands at its FIRST
              // line rather than dropping the user mid-response (scroll effect).
              data-scroll-anchor={isLatestAgent && !hasRecap ? 'latest-agent' : undefined}
              // Only the greeting morphs its box: `layout="size"` animates the
              // grow from thinking-pill to welcome-line without sliding the
              // bubble when later turns push it down. Other bubbles keep the
              // simple fade/rise and never run a layout pass.
              layout={isIntroGreeting && !calmMotion ? 'size' : false}
              initial={calmMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.24,
                ease: SCENT_EASE,
                layout: { duration: 0.52, ease: SCENT_EASE },
              }}
              className={`relative max-w-[90%] rounded-[calc(var(--radius-scent)-12px)] border px-3.5 py-2.5 text-[13px] leading-relaxed sm:text-sm ${
                message.role === 'user'
                  ? 'self-end border-white/14 bg-white/[0.07] text-[#fff7ec]'
                  : message.role === 'system'
                    ? 'self-start border-red-400/25 bg-red-500/10 text-red-100'
                    : 'self-start border-scent-accent/22 bg-[linear-gradient(180deg,rgba(212,175,55,0.045),rgba(0,0,0,0.16))] text-scent-text-muted'
              }`}
              aria-label={typing ? 'Beam Agent is typing' : undefined}
            >
              {message.role === 'system' ? (
                <AlertTriangle size={13} className="mr-1.5 inline align-[-2px]" aria-hidden />
              ) : null}
              {isIntroGreeting ? (
                <AnimatePresence mode="popLayout" initial={false}>
                  {typing ? (
                    <motion.span
                      key="intro-dots"
                      className="inline-flex items-center gap-1.5 py-0.5"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18, ease: SCENT_EASE }}
                      aria-hidden
                    >
                      <BeamTypingDots />
                    </motion.span>
                  ) : (
                    // Fades up a beat into the box growth, so the text resolves as
                    // the bubble settles rather than appearing before it expands.
                    <motion.span
                      key="intro-text"
                      className="block"
                      initial={calmMotion ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.36, ease: SCENT_EASE, delay: 0.08 }}
                    >
                      {message.text}
                    </motion.span>
                  )}
                </AnimatePresence>
              ) : message.role === 'agent' ? (
                // Agent answers arrive as Markdown; render them through the
                // structured renderer so no raw `**` / `##` / `---` reaches the
                // screen and a long recommendation reads as a scannable card.
                <BeamMessage text={message.text} />
              ) : (
                message.text
              )}
            </motion.div>
          );
          if (!hasRecap) return bubble;
          // Per-turn recap sits ABOVE its answer, both left-aligned in a column.
          // The wrapper carries the scroll anchor so a fresh reply lands on the
          // "Thought for Ns" line, then the answer — not buried beneath it. The
          // recap child is held back (showRecap) for one beat on the newest turn.
          return (
            <div
              key={`${message.id}-turn`}
              className="flex w-full flex-col gap-1.5"
              data-scroll-anchor={isLatestAgent ? 'latest-agent' : undefined}
            >
              {showRecap ? (
                <BeamActivityTrail
                  steps={recapSteps ?? []}
                  calmMotion={calmMotion}
                  running={false}
                  expanded={!!expandedRecaps[message.id]}
                  elapsedMs={message.elapsedMs ?? null}
                  onToggleExpand={() => toggleRecap(message.id)}
                />
              ) : null}
              {bubble}
            </div>
          );
        })}

        {/* Live progress WHILE the agent works the current turn. When a run
            streams real steps we show the condensed thinking trail (one summary
            line, tap to expand the tool-by-tool breakdown); before the first
            event (or on the scripted path) we fall back to the quiet typing dots.
            Once the run settles this unmounts and the steps live on as a
            collapsible "Thought for Ns" recap ABOVE the answer they produced
            (rendered per-message above). Calm motion keeps the trail but drops
            the animation. */}
        <AnimatePresence initial={false}>
          {introReady && !resolved && busy ? (
            activity.length > 0 ? (
              <BeamActivityTrail
                key="agent-activity"
                steps={activity}
                calmMotion={calmMotion}
                running={busy}
                expanded={activityExpanded}
                elapsedMs={null}
                onToggleExpand={() => setActivityExpanded((v) => !v)}
              />
            ) : busy && !calmMotion ? (
              <motion.div
                key="agent-typing"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.24, ease: SCENT_EASE }}
                className={BEAM_TYPING_BUBBLE_CLASS}
                aria-label="Beam Agent is typing"
              >
                <BeamTypingDots />
              </motion.div>
            ) : null
          ) : null}
        </AnimatePresence>

        {/* The agent's pick, rendered as the cinematic payoff — not a flat list.
            "Reveal Match" opens the SAME immersive overlay the scripted resolver
            uses, seeded client-side from this turn's hero pick. "Add to vault"
            still curates the full collection; nothing is written until tapped. */}
        <AnimatePresence initial={false}>
          {proposal && proposalReveal && !busy && !curating ? (
            <motion.div
              key="beam-proposal"
              data-scroll-anchor="resolved"
              variants={revealContainer}
              initial={calmMotion ? false : 'hidden'}
              animate="show"
              exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              className="scent-match-reveal max-w-[92%] self-start rounded-[calc(var(--radius-scent)-10px)] border border-scent-accent/32 bg-[linear-gradient(180deg,rgba(212,175,55,0.07),rgba(0,0,0,0.28))] p-4 text-left"
              data-testid="beam-proposal-card"
              data-calm={calmMotion ? 'true' : undefined}
            >
              <motion.p variants={revealItem} className="scent-type-label text-scent-accent">
                {proposal.items.length > 1 ? 'Signature pick' : 'Your match'}
              </motion.p>
              {proposalReveal.fragrance.brand ? (
                <motion.p variants={revealItem} className="mt-2 font-serif text-xs uppercase tracking-[0.2em] text-scent-text-muted">
                  {proposalReveal.fragrance.brand}
                </motion.p>
              ) : null}
              <motion.p variants={revealItem} className="font-serif italic text-2xl leading-tight text-[#fff7ec]">
                {proposalReveal.fragrance.name}
              </motion.p>
              <motion.p variants={revealItem} className="mt-2 text-sm italic leading-relaxed text-scent-text-muted">
                {proposalReveal.reason}
              </motion.p>

              <motion.button
                variants={revealItem}
                type="button"
                onClick={handleRevealProposalHero}
                className="scent-primary-button mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-scent)] px-5 py-2.5"
              >
                <Sparkles size={15} aria-hidden />
                <span className="font-serif italic text-base">Reveal Match</span>
              </motion.button>

              {proposal.items.length > 1 ? (
                <motion.div variants={revealItem} className="mt-4">
                  <p className="scent-type-label text-scent-text-subtle">Also lined up</p>
                  <ul className="mt-1.5 flex max-h-[6rem] flex-col gap-1.5 overflow-y-auto pr-1 scrollbar-hide">
                    {proposal.items.slice(1).map((item) => (
                      <li key={`${item.brand}-${item.name}`} className="flex items-baseline justify-between gap-3">
                        <span className="font-serif italic text-[13px] text-[#fff7ec] sm:text-sm">{item.name}</span>
                        <span className="scent-type-label shrink-0 text-scent-text-subtle">{item.brand}</span>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ) : null}

              <motion.div variants={revealItem} className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleConfirmProposal()}
                  disabled={!onCurateCollection}
                  className="inline-flex min-h-10 items-center justify-center rounded-full border border-scent-accent/42 px-4 py-1.5 scent-type-chip text-[11px] text-[#fff7ec] transition-colors hover:bg-scent-accent/12 disabled:opacity-55"
                >
                  {proposal.items.length > 1 ? `Add ${proposal.items.length} to vault` : 'Add to vault'}
                </button>
                <button
                  type="button"
                  onClick={handleDeclineProposal}
                  className="inline-flex min-h-10 items-center justify-center rounded-full border border-white/20 px-4 py-1.5 scent-type-chip text-[11px] text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec]"
                >
                  Not now
                </button>
              </motion.div>
              {!onCurateCollection ? (
                <motion.p variants={revealItem} className="mt-2 scent-type-label text-scent-text-subtle">Sign in to save to your vault.</motion.p>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Curating hold: each pick is added through the normal wardrobe path and
            we wait until it's image + profile ready before reporting back. */}
        <AnimatePresence initial={false}>
          {curating ? (
            <motion.div
              key="beam-curating"
              initial={calmMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: 0.24, ease: SCENT_EASE }}
              className="max-w-[92%] self-start rounded-[calc(var(--radius-scent)-10px)] border border-scent-accent/24 bg-[linear-gradient(180deg,rgba(212,175,55,0.05),rgba(0,0,0,0.2))] px-3.5 py-3 text-left"
              role="status"
              aria-label="Curating your collection"
            >
              <div className="flex items-center gap-2">
                {curating.done ? (
                  <Check size={14} className="text-scent-accent" aria-hidden />
                ) : (
                  <Loader2 size={14} className={calmMotion ? 'text-scent-accent' : 'animate-spin text-scent-accent'} aria-hidden />
                )}
                <span className="scent-type-label text-scent-accent">
                  {curating.done ? 'Collection curated' : 'Curating your collection…'}
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] text-scent-text-muted">
                {curating.done
                  ? `Added ${curating.done.added} of ${curating.done.total} to your vault.`
                  : curating.progress
                    ? `${CURATE_STATUS_COPY[curating.progress.status]} ${curating.progress.name} (${Math.min(curating.progress.index + 1, curating.total)}/${curating.total})`
                    : 'Preparing your collection…'}
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {resolved ? (
            <motion.div
              key="resolved"
              // The reveal is the payoff; align its top to the box top so the
              // user reads the curated match from the brand line down.
              data-scroll-anchor="resolved"
              variants={revealContainer}
              initial={calmMotion ? false : 'hidden'}
              animate="show"
              exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              className="scent-match-reveal max-w-[92%] self-start rounded-[calc(var(--radius-scent)-10px)] border border-scent-accent/32 bg-[linear-gradient(180deg,rgba(212,175,55,0.07),rgba(0,0,0,0.28))] p-4 text-left"
              data-calm={calmMotion ? 'true' : undefined}
            >
              <motion.p variants={revealItem} className="scent-type-label text-scent-accent">Curated match</motion.p>
              {resolved.recommendation.brand ? (
                <motion.p variants={revealItem} className="mt-2 font-serif text-xs uppercase tracking-[0.2em] text-scent-text-muted">
                  {resolved.recommendation.brand}
                </motion.p>
              ) : null}
              <motion.p variants={revealItem} className="font-serif italic text-2xl leading-tight text-[#fff7ec]">
                {resolved.recommendation.name}
              </motion.p>
              <motion.p variants={revealItem} className="mt-2 text-sm italic leading-relaxed text-scent-text-muted">
                {resolved.recommendation.reason}
              </motion.p>
              {resolved.item ? (
                <motion.button
                  variants={revealItem}
                  type="button"
                  onClick={handleReveal}
                  className="scent-primary-button mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-scent)] px-5 py-2.5"
                >
                  <Sparkles size={15} aria-hidden />
                  <span className="font-serif italic text-base">Reveal Match</span>
                </motion.button>
              ) : (
                <motion.p variants={revealItem} className="mt-3 text-[12px] text-scent-text-subtle">
                  This pick is no longer in your local vault, so the full overlay is unavailable.
                </motion.p>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      </div>

      <p className="sr-only">
        {formatFacetLine(facets)}
      </p>
      {actionControls}
      {/* Impressions lane: portaled below the card into the host container. A
          host passes the prop (as `null` for one frame until its ref attaches),
          so when it's `null` we render nothing and let the host's reserved slot
          hold the space — rendering the inline fallback here first would yank the
          lane down into the portal on the next frame. Only a consumer that omits
          the prop entirely (`undefined`) gets the inline fallback. */}
      {cueBarContainer
        ? createPortal(<AnimatePresence initial={false}>{cueBar}</AnimatePresence>, cueBarContainer)
        : cueBarContainer === null
          ? null
          : cueBar
            ? <div className="mt-3"><AnimatePresence initial={false}>{cueBar}</AnimatePresence></div>
            : null}
    </div>
  );
};
