import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle,
  Archive,
  Check,
  CloudSun,
  Compass,
  Loader2,
  Lock,
  Send,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  applyScentMissionUpdates,
  createScentMissionState,
  isScentMissionDestination,
  isScentMissionEnergy,
  SCENT_MISSION_NODE_ORDER,
  type ScentMissionNodeId,
  type ScentMissionNodeStatus,
  type ScentMissionRecommendation,
  type ScentMissionResponse,
  type ScentMissionState,
  type ScentWeatherRecommendation,
} from '@workspace/scent-weather-engine';
import {
  activeMissionNode,
  buildMissionWardrobe,
  buildMissionWeather,
  findWardrobeMatch,
  missionProgress,
  suggestedMissionChips,
} from '@/lib/scentMissionClient';
import type { Fragrance } from '@/components/Wardrobe';
import type { WeatherData } from '@/context/WeatherContext';
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

function newMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

const NODE_META: Record<
  ScentMissionNodeId,
  { label: string; sublabel: string; icon: LucideIcon; execute: string }
> = {
  onboarding: {
    label: 'Calibration',
    sublabel: 'Destination + energy',
    icon: Compass,
    execute: 'Lock Calibration',
  },
  'wardrobe-sync': {
    label: 'Vault Sync',
    sublabel: 'Profile your collection',
    icon: Archive,
    execute: 'Sync Vault',
  },
  'environment-scan': {
    label: 'Environment Scan',
    sublabel: 'Live atmosphere + UV',
    icon: CloudSun,
    execute: 'Scan Environment',
  },
  'resolution-standard': {
    label: 'Resolution',
    sublabel: 'Weather-aligned match',
    icon: Sparkles,
    execute: 'Execute Analysis',
  },
  'resolution-premium': {
    label: 'Molecular Intelligence',
    sublabel: 'Premium resolution',
    icon: Lock,
    execute: 'Unlock Premium',
  },
};

const DESTINATION_OPTIONS = ['Staying In', 'Going Out', 'Work', 'Night Out', 'Date', 'Gym'] as const;
const ENERGY_OPTIONS = ['Calm', 'Focused', 'Confident', 'Social', 'Relaxed'] as const;

/* Vertical placement of the 5 nodes inside the 100×420 tree viewBox. */
const NODE_Y = [36, 124, 212, 300, 388];
const TRUNK_X = 30;

function nodeStatusRing(status: ScentMissionNodeStatus): string {
  switch (status) {
    case 'complete':
      return 'border-scent-accent/80 bg-scent-accent/15 text-scent-accent';
    case 'active':
    case 'running':
      return 'border-scent-accent bg-black/60 text-[#fff7ec] shadow-[0_0_18px_rgba(212,175,55,0.35)]';
    case 'blocked':
      return 'border-scent-accent/45 bg-black/50 text-scent-accent/75';
    default:
      return 'border-white/15 bg-black/40 text-white/30';
  }
}

interface ScentMissionPanelProps {
  items: Fragrance[];
  weather: WeatherData | null;
  authToken: string | null;
  /** Leave mission mode and restore the search/vault panel. */
  onExit: () => void;
  /** Open the existing recommendation overlay with the resolved match. */
  onRevealMatch: (item: Fragrance, engine: ScentWeatherRecommendation, reason: string) => void;
}

export const ScentMissionPanel: React.FC<ScentMissionPanelProps> = ({
  items,
  weather,
  authToken,
  onExit,
  onRevealMatch,
}) => {
  const reduceMotion = useReducedMotion();
  const ipadPerformanceMode = useRef(isIpadSafariPerformanceMode()).current;
  const calmMode = Boolean(reduceMotion) || ipadPerformanceMode;

  const [mission, setMission] = useState<ScentMissionState>(() => createScentMissionState());
  const [messages, setMessages] = useState<PanelMessage[]>(() => [
    {
      id: newMessageId(),
      role: 'agent',
      text: 'Mission online. I match a fragrance from your vault to today’s air and your plans. Lock your calibration to begin — or ask me anything.',
    },
  ]);
  const [composer, setComposer] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [resolved, setResolved] = useState<{
    recommendation: ScentMissionRecommendation;
    item: Fragrance | null;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Keep the latest message in view inside the chat scroller (never the page).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, resolved]);

  const activeNode = activeMissionNode(mission);
  const progress = missionProgress(mission);
  const chips = useMemo(() => suggestedMissionChips(mission), [mission]);

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
          sessionId,
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
    [authToken, items, sessionId, weather],
  );

  const applyResponse = useCallback(
    (response: ScentMissionResponse, base: ScentMissionState) => {
      setSessionId(response.sessionId);
      const nextMission = applyScentMissionUpdates(base, response.nodeUpdates, response.missionPatch);
      setMission(nextMission);
      if (response.assistantMessage) appendMessage('agent', response.assistantMessage);
      if (response.recommendation) {
        setResolved({
          recommendation: response.recommendation,
          item: findWardrobeMatch(items, response.recommendation),
        });
      }
      return nextMission;
    },
    [appendMessage, items],
  );

  const handleExecuteNode = useCallback(
    async (nodeId: ScentMissionNodeId) => {
      if (busy) return;
      setBusy(true);
      // Premium stays blocked server-side; only real nodes flip to "running".
      const runningMission: ScentMissionState =
        nodeId === 'resolution-premium'
          ? mission
          : { ...mission, nodes: { ...mission.nodes, [nodeId]: 'running' } };
      setMission(runningMission);
      try {
        const response = await callMission({ action: 'execute_node', nodeId }, runningMission);
        if (response) applyResponse(response, runningMission);
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          setMission(mission); // restore pre-run statuses
          appendMessage(
            'system',
            err instanceof Error ? err.message : 'Mission step failed. Try again.',
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [appendMessage, applyResponse, busy, callMission, mission],
  );

  const handleSendChat = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setComposer('');
      appendMessage('user', trimmed);
      setBusy(true);
      try {
        const response = await callMission({ action: 'chat', userMessage: trimmed }, mission);
        if (response) applyResponse(response, mission);
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          appendMessage(
            'system',
            err instanceof Error ? err.message : 'The mission agent is unreachable. Try again.',
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [appendMessage, applyResponse, busy, callMission, mission],
  );

  const setCalibration = useCallback((patch: { destination?: string; energy?: string }) => {
    setMission((prev) => ({
      ...prev,
      calibration: {
        ...prev.calibration,
        ...(isScentMissionDestination(patch.destination) ? { destination: patch.destination } : {}),
        ...(isScentMissionEnergy(patch.energy) ? { energy: patch.energy } : {}),
      },
    }));
  }, []);

  const handleReveal = useCallback(() => {
    if (!resolved?.item) return;
    onRevealMatch(resolved.item, resolved.recommendation.engine, resolved.recommendation.reason);
  }, [onRevealMatch, resolved]);

  const onboardingActive = mission.nodes.onboarding === 'active' || mission.nodes.onboarding === 'running';
  const calibrationReady = Boolean(mission.calibration.destination && mission.calibration.energy);
  const executeDisabled =
    busy || (activeNode === 'onboarding' && !calibrationReady);

  /* ---------------------------------------------------------------- */

  const tree = (
    <div className="relative flex shrink-0 sm:w-[15.5rem]">
      <svg
        viewBox="0 0 100 420"
        className="absolute left-0 top-0 h-full w-[3.75rem]"
        aria-hidden
        preserveAspectRatio="none"
      >
        <path
          d={`M ${TRUNK_X} ${NODE_Y[0]} V ${NODE_Y[4]}`}
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="2"
        />
        {calmMode ? (
          <path
            d={`M ${TRUNK_X} ${NODE_Y[0]} V ${NODE_Y[0] + (NODE_Y[4] - NODE_Y[0]) * progress}`}
            fill="none"
            stroke="rgba(212,175,55,0.85)"
            strokeWidth="2"
          />
        ) : (
          <motion.path
            d={`M ${TRUNK_X} ${NODE_Y[0]} V ${NODE_Y[4]}`}
            fill="none"
            stroke="rgba(212,175,55,0.85)"
            strokeWidth="2"
            strokeLinecap="round"
            initial={false}
            animate={{ pathLength: progress }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
      </svg>

      <ol className="relative z-[1] flex w-full flex-col gap-4" aria-label="Mission progress">
        {SCENT_MISSION_NODE_ORDER.map((nodeId) => {
          const status = mission.nodes[nodeId];
          const meta = NODE_META[nodeId];
          const Icon = status === 'complete' ? Check : status === 'running' ? Loader2 : meta.icon;
          const isCurrent = nodeId === activeNode;
          return (
            <li key={nodeId} className="flex min-w-0 items-center gap-3">
              <span
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors ${nodeStatusRing(status)}`}
                aria-hidden
              >
                <Icon
                  size={17}
                  strokeWidth={1.75}
                  className={status === 'running' ? 'animate-spin' : undefined}
                />
              </span>
              <div className="min-w-0 text-left">
                <p
                  className={`scent-type-label truncate ${
                    isCurrent
                      ? 'text-scent-accent'
                      : status === 'complete'
                        ? 'text-[#fff7ec]/85'
                        : 'text-white/45'
                  }`}
                >
                  {meta.label}
                </p>
                <p className="truncate text-[11px] leading-snug text-scent-text-muted">
                  {nodeId === 'resolution-premium' ? 'Premium · locked' : meta.sublabel}
                </p>
              </div>
              <span className="sr-only">{`${meta.label}: ${status}`}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );

  const calibrationChips = onboardingActive ? (
    <div className="space-y-3 rounded-[calc(var(--radius-scent)-10px)] border border-white/10 bg-black/30 p-3 text-left">
      <div>
        <p className="scent-type-label mb-1.5 text-scent-accent/85">Destination</p>
        <div className="flex flex-wrap gap-1.5">
          {DESTINATION_OPTIONS.map((destination) => {
            const selected = mission.calibration.destination === destination;
            return (
              <button
                key={destination}
                type="button"
                onClick={() => setCalibration({ destination })}
                aria-pressed={selected}
                className={`rounded-full border px-3 py-1.5 scent-type-chip transition-colors ${
                  selected
                    ? 'border-scent-accent/80 bg-scent-accent/15 text-[#fff7ec]'
                    : 'border-white/25 text-scent-text-muted hover:border-scent-accent/45 hover:text-[#fff7ec]'
                }`}
              >
                {destination}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <p className="scent-type-label mb-1.5 text-scent-accent/85">Energy</p>
        <div className="flex flex-wrap gap-1.5">
          {ENERGY_OPTIONS.map((energy) => {
            const selected = mission.calibration.energy === energy;
            return (
              <button
                key={energy}
                type="button"
                onClick={() => setCalibration({ energy })}
                aria-pressed={selected}
                className={`rounded-full border px-3 py-1.5 scent-type-chip transition-colors ${
                  selected
                    ? 'border-scent-accent/80 bg-scent-accent/15 text-[#fff7ec]'
                    : 'border-white/25 text-scent-text-muted hover:border-scent-accent/45 hover:text-[#fff7ec]'
                }`}
              >
                {energy}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  ) : null;

  const resultCard = resolved ? (
    <div className="rounded-[calc(var(--radius-scent)-10px)] border border-scent-accent/35 bg-[linear-gradient(180deg,rgba(212,175,55,0.08),rgba(0,0,0,0.4))] p-4 text-left">
      <p className="scent-type-label mb-1 text-scent-accent">Mission resolution</p>
      {resolved.recommendation.brand ? (
        <p className="font-serif text-xs uppercase tracking-[0.2em] text-scent-text-muted">
          {resolved.recommendation.brand}
        </p>
      ) : null}
      <p className="font-serif italic text-2xl leading-tight text-[#fff7ec]">
        {resolved.recommendation.name}
      </p>
      <p className="mt-2 text-[13px] italic leading-relaxed text-scent-text-muted">
        {resolved.recommendation.reason}
      </p>
      {resolved.item ? (
        <button
          type="button"
          onClick={handleReveal}
          className="scent-primary-button mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-[calc(var(--radius-scent)-12px)] px-4"
        >
          <Sparkles size={15} aria-hidden />
          <span className="font-serif italic text-base">Reveal Match</span>
        </button>
      ) : (
        <p className="mt-3 text-[12px] text-scent-text-subtle">
          This pick is no longer in your local vault, so the full overlay is unavailable.
        </p>
      )}
    </div>
  ) : null;

  const premiumBlocked = mission.nodes['resolution-premium'] === 'blocked';
  const premiumCard = premiumBlocked ? (
    <div className="relative overflow-hidden rounded-[calc(var(--radius-scent)-10px)] border border-scent-accent/30 bg-black/45 p-4 text-left">
      <div
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-scent-accent/55 to-transparent"
        aria-hidden
      />
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-scent-accent/55 bg-black/60 text-scent-accent">
          <Lock size={15} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="scent-type-label text-scent-accent">Molecular Intelligence · Premium</p>
          <p className="mt-1 text-[12px] leading-relaxed text-scent-text-muted">
            Note volatility curves, projection modelling, and a layering protocol tuned to today's
            air.
          </p>
          <button
            type="button"
            onClick={() => void handleExecuteNode('resolution-premium')}
            disabled={busy}
            className="mt-2.5 inline-flex min-h-10 items-center gap-2 rounded-full border border-scent-accent/55 px-4 scent-type-chip text-scent-accent transition-colors hover:bg-scent-accent/10 disabled:opacity-50"
          >
            <Lock size={12} aria-hidden />
            Preview Premium
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="scent-vault-panel relative w-full min-w-0 overflow-hidden" data-testid="scent-mission-panel">
      <div className="scent-vault-panel-inner min-w-0">
        <header className="mb-5 flex items-start justify-between gap-3">
          <div className="text-left">
            <p className="scent-type-label text-scent-accent">Scent Mission</p>
            <h2 className="mt-1 font-serif italic text-[clamp(1.6rem,4vw,2.4rem)] leading-tight text-[#fff7ec]">
              Discover your signature scent.
            </h2>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="-m-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-scent-text-subtle transition-all hover:bg-white/10 hover:text-white active:scale-95"
            aria-label="Exit mission and return to search"
          >
            <X size={20} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex flex-col gap-6 sm:flex-row">
          {tree}

          <div className="flex min-w-0 flex-1 flex-col rounded-[calc(var(--radius-scent)-8px)] border border-white/10 bg-black/30">
            <div
              ref={scrollRef}
              className="flex max-h-[22rem] min-h-[14rem] flex-col gap-3 overflow-y-auto p-4"
              role="log"
              aria-label="Mission conversation"
              aria-live="polite"
            >
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[88%] rounded-[14px] border px-3.5 py-2.5 text-left text-[13px] leading-relaxed ${
                    message.role === 'user'
                      ? 'self-end border-white/15 bg-white/[0.07] text-[#fff7ec]'
                      : message.role === 'system'
                        ? 'self-start border-red-500/25 bg-red-500/10 text-red-200'
                        : 'self-start border-scent-accent/25 bg-[linear-gradient(180deg,rgba(212,175,55,0.06),rgba(0,0,0,0.25))] text-scent-text-muted'
                  }`}
                >
                  {message.role === 'system' ? (
                    <span className="mr-1.5 inline-flex align-[-2px]" aria-hidden>
                      <AlertTriangle size={13} />
                    </span>
                  ) : null}
                  {message.text}
                </div>
              ))}
              {calibrationChips}
              {resultCard}
              {premiumCard}
            </div>

            <div className="border-t border-white/10 p-3">
              {activeNode ? (
                <button
                  type="button"
                  onClick={() => void handleExecuteNode(activeNode)}
                  disabled={executeDisabled}
                  className="scent-primary-button mb-2.5 flex min-h-12 w-full items-center justify-center gap-2.5 rounded-[calc(var(--radius-scent)-12px)] px-4 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {busy ? (
                    <Loader2 size={16} className="animate-spin" aria-hidden />
                  ) : (
                    <Sparkles size={16} aria-hidden />
                  )}
                  <span className="font-serif italic text-lg leading-tight">
                    {NODE_META[activeNode].execute}
                  </span>
                </button>
              ) : null}

              {chips.length > 0 ? (
                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  {chips.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => void handleSendChat(chip)}
                      disabled={busy}
                      className="rounded-full border border-white/20 px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-[#fff7ec] disabled:opacity-45"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              ) : null}

              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSendChat(composer);
                }}
              >
                <input
                  type="text"
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  placeholder="Ask the mission agent…"
                  aria-label="Message the mission agent"
                  autoComplete="off"
                  className="scent-lux-input h-12 min-w-0 flex-1 px-4 text-[13px] text-[#fff7ec] outline-none placeholder:text-scent-text-subtle"
                />
                <button
                  type="submit"
                  disabled={busy || !composer.trim()}
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-scent-accent/45 text-scent-accent transition-colors hover:bg-scent-accent/10 disabled:opacity-40"
                  aria-label="Send message"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
