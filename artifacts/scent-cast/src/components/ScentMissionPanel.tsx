import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle,
  Loader2,
  Lock,
  Send,
  SlidersHorizontal,
  Sparkles,
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
  buildMissionWardrobe,
  buildMissionWeather,
  findWardrobeMatch,
  missionProgress,
} from '@/lib/scentMissionClient';
import type { Fragrance } from '@/components/Wardrobe';
import type { WeatherData } from '@/context/WeatherContext';
import { useDragToScroll } from '@/hooks/useDragToScroll';
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

function newMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function initialAgentMessage(itemCount: number): string {
  if (itemCount > 0) {
    return 'Welcome. Tell me the mood, occasion, or impression you want to leave today.';
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

function isRecommendationIntent(text: string): boolean {
  return /\b(recommend|wear|pick|curate|choose|signature|match)\b/i.test(text);
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
}

export const ScentMissionPanel: React.FC<ScentMissionPanelProps> = ({
  items,
  weather,
  authToken,
  onExit,
  onRevealMatch,
  onStatusChange,
  cueBarContainer,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Pause the cue marquee while the user is pressing it, so a moving chip is
  // still easy to tap. Hover-pause (desktop) is handled in CSS.
  const [marqueePaused, setMarqueePaused] = useState(false);
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
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [resolved, setResolved] = useState<{
    recommendation: ScentMissionRecommendation;
    item: Fragrance | null;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const quickReplyScrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);

  // Desktop click-drag for the cue strip; touch keeps native momentum scroll.
  useDragToScroll(quickReplyScrollRef);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Glide to the latest turn rather than snapping, so a new line or the match
    // reveal slides into view as one continuous motion. Instant under calm mode.
    el.scrollTo({ top: el.scrollHeight, behavior: calmMotion ? 'auto' : 'smooth' });
  }, [messages, resolved, busy, calmMotion]);

  useEffect(() => {
    if (introReady) return;
    // Hold just long enough for the open crossfade (~0.42s) to settle, then a
    // brief typing beat, so the greeting lands deliberately without feeling slow.
    const id = window.setTimeout(() => setIntroReady(true), 920);
    return () => window.clearTimeout(id);
  }, [introReady]);

  // Reveal the impressions lane a short beat after the greeting settles.
  useEffect(() => {
    if (cuesReady || !introReady) return;
    const id = window.setTimeout(() => setCuesReady(true), 320);
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
    if (capturedCount === 0) return 'Ready for your cues';
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

  const appendMessage = useCallback((role: PanelMessage['role'], text: string) => {
    setMessages((prev) => [...prev, { id: newMessageId(), role, text }]);
  }, []);

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
    },
    [authToken, items, weather],
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

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = composer.trim();
      if (!trimmed || busy) return;
      setComposer('');
      appendMessage('user', trimmed);

      const inferred = inferTextFacets(trimmed);
      const { nextFacets, nextMission } = updateFacetsAndMission(
        inferred.facets,
        { destination: inferred.destination, energy: inferred.energy },
      );
      const wantsRecommendation = isRecommendationIntent(trimmed);
      const canCurate = hasEnoughContext(nextFacets, nextMission, agentMode);

      if (agentMode === 'fast' || (wantsRecommendation && canCurate)) {
        await runResolution(agentMode === 'fast' ? 'fast' : 'curate', nextMission, nextFacets);
        return;
      }

      setBusy(true);
      setProgressNote('Listening');
      try {
        const response = await callMission(
          { action: 'chat', userMessage: modeInstruction(agentMode, tone, trimmed) },
          nextMission,
        );
        if (response) {
          applyResponse(response, nextMission, { appendAssistant: false });
        }
        const fallback = firstMissingPrompt(nextFacets, nextMission, agentMode, items.length);
        const assistantText = canCurate ? ENOUGH_CONTEXT_PROMPT : fallback;
        appendMessage('agent', safeAssistantText(response?.assistantMessage, assistantText));
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          appendMessage('system', err instanceof Error ? err.message : 'The Beam Agent is unreachable. Try again.');
          appendMessage('agent', firstMissingPrompt(nextFacets, nextMission, agentMode, items.length));
        }
      } finally {
        setBusy(false);
        setProgressNote('');
        composerRef.current?.focus({ preventScroll: true });
      }
    },
    [
      agentMode,
      appendMessage,
      applyResponse,
      busy,
      callMission,
      composer,
      items.length,
      runResolution,
      tone,
      updateFacetsAndMission,
    ],
  );

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

  // The placeholder doubles as the instructions: tap a cue below to fill this
  // field, or type — then send. Keeps the flow self-evident with no extra chrome.
  const composerPlaceholder =
    agentMode === 'fast'
      ? 'Tap a cue below or type, then send'
      : agentMode === 'premium'
        ? 'Tap a cue or describe the impression'
        : 'Tap a cue below, or describe your day';

  const actionControls = (
    <div className="mx-auto mt-4 w-full max-w-[42.75rem] sm:mt-5">
      <div className="mb-2 flex items-center justify-end gap-2 pr-1">
        <span className="scent-type-label text-scent-accent/70">Beam Agent</span>
        <img
          src="/scent-concierge-avatar.png"
          alt="ScentCast Beam Agent"
          width={36}
          height={36}
          loading="lazy"
          decoding="async"
          className="h-9 w-9 rounded-full border border-scent-accent/35 object-cover shadow-[0_2px_10px_rgba(0,0,0,0.45)]"
        />
      </div>
      <form
        onSubmit={handleSubmit}
        className="scent-lux-input scent-vault-search-input scent-beam-composer flex h-[60px] w-full items-center gap-2 rounded-full px-2.5 transition-colors focus-within:ring-2 focus-within:ring-scent-accent/12 sm:h-[68px] sm:px-3.5"
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
          onBlur={() => {
            // Recover the iOS Safari viewport once the soft keyboard dismisses.
            window.setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 90);
          }}
          placeholder={composerPlaceholder}
          aria-label="Message the Beam Agent"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-1 text-center text-sm font-medium text-[#fff7ec] outline-none placeholder:text-scent-text-subtle sm:text-base"
        />
        <button
          type="submit"
          disabled={busy || !composer.trim()}
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
            initial={calmMotion ? false : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="mt-3 rounded-[calc(var(--radius-scent)-8px)] border border-scent-accent/18 bg-black/58 p-3 text-left shadow-[inset_0_1px_0_rgba(255,236,183,0.06)]"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="scent-type-label mb-1.5 text-scent-accent/80">Response mode</p>
                <div className="flex flex-wrap gap-1.5">
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
                <p className="scent-type-label mb-1.5 text-scent-accent/80">Tone</p>
                <div className="flex flex-wrap gap-1.5">
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

  const hasActionRow = enoughContext || agentMode === 'fast' || agentMode === 'premium';
  // Hold the whole lane back until the greeting has settled, so the panel never
  // opens with a row of cues already sitting there.
  const cueBar =
    !cuesReady || (visibleQuickReplies.length === 0 && !hasActionRow) ? null : (
      <div
        className="mx-auto w-full max-w-[42.75rem]"
        aria-label="Beam Agent quick replies"
        data-testid="scent-mission-cue-bar"
      >
        {hasActionRow ? (
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {enoughContext || agentMode === 'fast' ? (
              <button
                type="button"
                onClick={() => void runResolution(agentMode === 'fast' ? 'fast' : 'curate')}
                disabled={busy || items.length === 0}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-scent-accent/68 bg-scent-accent/12 px-3 py-1.5 scent-type-chip text-[#fff7ec] transition-colors hover:bg-scent-accent/18 disabled:opacity-45"
              >
                <Sparkles size={12} aria-hidden />
                Confirm
              </button>
            ) : null}
            {agentMode === 'premium' ? (
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
            Tap one to fill the box, then send
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
                className="scent-cue-marquee-track"
                style={{ '--cue-marquee-duration': `${Math.max(visibleQuickReplies.length * 3.2, 9)}s` } as React.CSSProperties}
              >
                {[0, 1].map((copy) => (
                  <div className="scent-cue-marquee-group" key={copy} aria-hidden={copy === 1}>
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
      </div>
    );

  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-col text-center" data-testid="scent-mission-panel">
      {/* The title, progress, and close control now live in a header strip above
          the card (see App.tsx) so this surface is just the conversation. */}
      <div
        ref={scrollRef}
        className="mx-auto flex w-full max-w-[42.75rem] h-[min(30dvh,15rem)] flex-col gap-2.5 overflow-y-auto pr-1 text-left scrollbar-hide sm:h-[min(32dvh,18rem)]"
        role="log"
        aria-live="polite"
        aria-label="Beam Agent conversation"
      >
        {/* Intro typing → first line crossfade: the dots fade out as the
            greeting fades in, so the panel never hard-cuts between the two. */}
        <AnimatePresence initial={false}>
          {!introReady ? (
            <motion.div
              key="intro-typing"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.24, ease: SCENT_EASE }}
              className="inline-flex max-w-[90%] items-center gap-1.5 self-start rounded-[calc(var(--radius-scent)-12px)] border border-scent-accent/22 bg-[linear-gradient(180deg,rgba(212,175,55,0.045),rgba(0,0,0,0.16))] px-4 py-3"
              aria-label="Beam Agent is typing"
            >
              {[0, 1, 2].map((dot) => (
                <motion.span
                  key={dot}
                  className="h-1.5 w-1.5 rounded-full bg-scent-accent/70"
                  animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut', delay: dot * 0.18 }}
                />
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {introReady
          ? messages.map((message) => (
              <motion.div
                key={message.id}
                initial={calmMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: SCENT_EASE }}
                className={`max-w-[90%] rounded-[calc(var(--radius-scent)-12px)] border px-3.5 py-2.5 text-[13px] leading-relaxed sm:text-sm ${
                  message.role === 'user'
                    ? 'self-end border-white/14 bg-white/[0.07] text-[#fff7ec]'
                    : message.role === 'system'
                      ? 'self-start border-red-400/25 bg-red-500/10 text-red-100'
                      : 'self-start border-scent-accent/22 bg-[linear-gradient(180deg,rgba(212,175,55,0.045),rgba(0,0,0,0.16))] text-scent-text-muted'
                }`}
              >
                {message.role === 'system' ? (
                  <AlertTriangle size={13} className="mr-1.5 inline align-[-2px]" aria-hidden />
                ) : null}
                {message.text}
              </motion.div>
            ))
          : null}

        {/* Working state fades in, then hands off to the match reveal: the
            "Beaming" pill exits as the curated card eases up in its place. */}
        <AnimatePresence initial={false}>
          {busy ? (
            <motion.div
              key="thinking"
              initial={calmMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={calmMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: 0.22, ease: SCENT_EASE }}
              className="scent-beam-thinking inline-flex max-w-[90%] items-center gap-2.5 self-start rounded-full border border-scent-accent/24 bg-black/36 px-4 py-2"
              data-calm={calmMotion ? 'true' : undefined}
              aria-label={progressNote || 'The Beam Agent is working'}
            >
              <span className="scent-beam-orb" aria-hidden />
              <span className="scent-beam-label text-[12px] font-semibold uppercase tracking-[0.12em]">
                {progressNote || 'Beaming'}
              </span>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {resolved ? (
            <motion.div
              key="resolved"
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

      <p className="sr-only">
        {formatFacetLine(facets)}
      </p>
      {actionControls}
      {/* Impressions lane: portaled below the card when the host provides a
          container, otherwise rendered inline as a graceful fallback. */}
      {cueBarContainer
        ? createPortal(cueBar, cueBarContainer)
        : cueBar
          ? <div className="mt-3">{cueBar}</div>
          : null}
    </div>
  );
};
