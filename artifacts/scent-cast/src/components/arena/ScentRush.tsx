import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, AudioLines, CirclePause, Play, RotateCcw, Shield, Sparkles, VolumeX, X } from 'lucide-react';
import {
  completeRushRun, emitRushEvent, getRushProgress, startRushRun,
  type RushAction, type RushEventOutcome, type RushPlanEvent, type RushProgressSummary, type RushResult, type RushRun,
} from '@/lib/scentRushClient';
import { calculateClientRushScore, digestRushEvents } from '@/lib/scentRushGame';

export type RushFragrance = { fragranceId: string; name: string; brand?: string; family?: string; notes?: string[] };

interface ScentRushProps {
  fragrances: RushFragrance[];
  authToken: string | null;
  onSignIn: () => void;
}

const EMPTY_PROGRESS: RushProgressSummary = {
  beamSupporters: 0, totalBeamPower: 0,
  user: { freshStartBeamPower: 0, freshStartBestScore: 0, freshStartBestPerformance: 0, totalBeamPower: 0, maximumBeamPower: 10 },
};

function beep(enabled: boolean, frequency = 520): void {
  if (!enabled) return;
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.035, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.08);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(); oscillator.stop(context.currentTime + 0.08);
  oscillator.addEventListener('ended', () => void context.close());
}

function eventLabel(event: RushPlanEvent, run: RushRun): string {
  if (event.kind === 'orb') return run.manifest.collectibleNotes.find((note) => note.id === event.noteId)?.label || 'Note';
  if (event.kind === 'npc') return 'Crowd';
  if (event.kind === 'pickup') return event.pickupType === 'sample-vial' ? 'Shield' : 'Boost';
  return event.hazardType === 'overspray-cloud' ? 'Overspray' : event.hazardType === 'heat-wave' ? 'Heat wave' : 'Rain splash';
}

function RunScreen({ run, authToken, onComplete, onExit }: {
  run: RushRun; authToken: string; onComplete: (result: RushResult) => void; onExit: () => void;
}) {
  const [lane, setLaneState] = useState<0 | 1 | 2>(1);
  const [elapsed, setElapsed] = useState(0);
  const [score, setScore] = useState(0);
  const [beam, setBeamState] = useState(0);
  const [shielded, setShieldedState] = useState(false);
  const [jumping, setJumping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [status, setStatus] = useState('Swipe to change lanes. Tap to jump.');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const laneRef = useRef<0 | 1 | 2>(1);
  const beamRef = useRef(0);
  const shieldRef = useRef(false);
  const boostUntilRef = useRef(0);
  const jumpUntilRef = useRef(0);
  const elapsedRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const processedRef = useRef(new Set<string>());
  const outcomesRef = useRef<RushEventOutcome[]>([]);
  const actionsRef = useRef<RushAction[]>([]);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const completedRef = useRef(false);
  const completionFailedRef = useRef(false);

  const setLane = useCallback((next: number) => {
    if (paused || submitting || completedRef.current) return;
    const safe = Math.max(0, Math.min(2, next)) as 0 | 1 | 2;
    if (safe === laneRef.current) return;
    actionsRef.current.push({ type: 'lane', atMs: elapsedRef.current, lane: safe });
    laneRef.current = safe; setLaneState(safe);
  }, [paused, submitting]);
  const setBeam = (next: number) => { beamRef.current = Math.max(0, Math.min(100, next)); setBeamState(beamRef.current); };
  const setShield = (next: boolean) => { shieldRef.current = next; setShieldedState(next); };
  const jump = useCallback(() => {
    if (paused || submitting || completedRef.current) return;
    actionsRef.current.push({ type: 'jump', atMs: elapsedRef.current });
    jumpUntilRef.current = elapsedRef.current + 650; setJumping(true); setStatus('Dash active'); beep(!muted, 660);
  }, [muted, paused, submitting]);

  const resolveEvent = useCallback((event: RushPlanEvent) => {
    const sameLane = event.lane === laneRef.current;
    let outcome: RushEventOutcome['outcome'] = 'missed';
    if (event.kind === 'orb') {
      if (sameLane) {
        outcome = 'collected';
        if (event.correct) {
          setBeam(beamRef.current + (elapsedRef.current < boostUntilRef.current ? 45 : 30));
          setStatus(event.scenarioCompatible ? 'Scenario match · charged note' : 'Signature note collected');
          beep(!muted, 760);
        } else setStatus('Decoy note · combo reset');
      }
    } else if (event.kind === 'hazard') {
      const occupiesLane = event.hazardType === 'heat-wave'
        ? true
        : event.hazardType === 'overspray-cloud'
          ? Math.abs(event.lane - laneRef.current) <= 1
          : sameLane;
      if (!occupiesLane) outcome = 'avoided';
      else if (beamRef.current >= 100) {
        outcome = 'cleared'; setBeam(0); setStatus('Scent Beam fired automatically'); beep(!muted, 940);
      } else if (jumpUntilRef.current >= event.atMs && event.hazardType !== 'overspray-cloud') {
        outcome = 'avoided'; setStatus('Hazard dashed');
      } else if (shieldRef.current) {
        outcome = 'avoided'; setShield(false); setStatus('Sample Vial shield absorbed it');
      } else {
        outcome = 'hit';
        if (event.hazardType === 'rain-splash') setBeam(beamRef.current - 40);
        setStatus(event.hazardType === 'heat-wave' ? 'Heat challenge activated.' : event.hazardType === 'overspray-cloud' ? 'Projection overload.' : 'Weather mismatch.');
        beep(!muted, 180);
      }
    } else if (event.kind === 'pickup') {
      if (sameLane) {
        outcome = 'collected';
        if (event.pickupType === 'sample-vial') setShield(true);
        else boostUntilRef.current = event.atMs + 5_000;
        setStatus(event.pickupType === 'sample-vial' ? 'Sample Vial shield ready' : 'Atomizer Boost active');
      }
    } else if (sameLane) {
      outcome = 'positive'; setStatus('Date-night crowd approves.');
    }
    outcomesRef.current.push({ eventId: event.id, outcome, atMs: event.atMs });
    const preview = calculateClientRushScore(run.eventPlan, outcomesRef.current);
    setScore(preview.score);
  }, [muted, run.eventPlan]);

  const finish = useCallback(async () => {
    if (completedRef.current) return;
    completedRef.current = true; completionFailedRef.current = false; setSubmitting(true); setError(null);
    const events = run.eventPlan.map((event) => outcomesRef.current.find((item) => item.eventId === event.id) || ({ eventId: event.id, outcome: 'missed', atMs: event.atMs } as RushEventOutcome));
    const preview = calculateClientRushScore(run.eventPlan, events);
    try {
      const result = await completeRushRun(run, authToken, {
        durationMs: run.durationMs, score: preview.score, collectedOrbIds: preview.collectedOrbIds,
        hazardsHit: preview.hazardsHit, events, actions: actionsRef.current, eventDigest: await digestRushEvents(events),
      });
      emitRushEvent('rush_run_completed', { fragranceId: run.manifest.fragranceId, score: result.score });
      if (result.bestUpgraded) emitRushEvent('rush_best_upgraded', { fragranceId: run.manifest.fragranceId });
      onComplete(result);
    } catch (err) {
      completedRef.current = false; completionFailedRef.current = true; setSubmitting(false);
      setError(err instanceof Error ? err.message : 'Run could not be saved.');
      emitRushEvent('rush_run_failed', { fragranceId: run.manifest.fragranceId });
    }
  }, [authToken, onComplete, run]);

  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      if (lastFrameRef.current === null) lastFrameRef.current = now;
      const delta = Math.min(100, now - lastFrameRef.current);
      lastFrameRef.current = now;
      if (!paused && !completedRef.current) {
        elapsedRef.current = Math.min(run.durationMs, elapsedRef.current + delta);
        setElapsed(elapsedRef.current);
        if (jumpUntilRef.current < elapsedRef.current) setJumping(false);
        for (const event of run.eventPlan) {
          if (event.atMs <= elapsedRef.current && !processedRef.current.has(event.id)) {
            processedRef.current.add(event.id); resolveEvent(event);
          }
        }
        if (elapsedRef.current >= run.durationMs && !completionFailedRef.current) void finish();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [finish, paused, resolveEvent, run.durationMs, run.eventPlan]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') { event.preventDefault(); setLane(laneRef.current - 1); }
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') { event.preventDefault(); setLane(laneRef.current + 1); }
      if (event.key === 'ArrowUp' || event.key === ' ') { event.preventDefault(); jump(); }
      if (event.key === 'Escape' && !submitting) setPaused((value) => !value);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [jump, setLane, submitting]);

  const activeEvents = run.eventPlan.filter((event) => event.atMs - elapsed > -250 && event.atMs - elapsed < 1_350);
  const progress = Math.min(100, (elapsed / run.durationMs) * 100);
  return (
    <div className="fixed inset-0 z-[140] overflow-y-auto bg-[#030303]/98 text-foreground" role="dialog" aria-modal="true" aria-label="ScentBeam Rush Fresh Start">
      <div className="mx-auto flex min-h-[100svh] w-full max-w-3xl flex-col px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
        <header className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => setPaused((value) => !value)} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-scent-accent/28 px-4 scent-type-chip text-foreground" aria-label={paused ? 'Resume run' : 'Pause run'}><CirclePause className="h-4 w-4" />{paused ? 'Resume' : 'Pause'}</button>
          <div className="min-w-0 text-center"><p className="scent-type-label text-scent-accent">Fresh Start</p><p className="truncate text-sm text-scent-text-muted">{run.manifest.displayName}</p></div>
          <button type="button" onClick={onExit} className="grid min-h-11 min-w-11 place-items-center rounded-full border border-white/14" aria-label="Exit Rush"><X className="h-5 w-5" /></button>
        </header>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-2"><span className="scent-type-label">Score</span><strong className="mt-1 block text-lg">{score}</strong></div>
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-2"><span className="scent-type-label">Beam</span><strong className="mt-1 block text-lg text-scent-accent">{Math.round(beam)}%</strong></div>
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-2"><span className="scent-type-label">Time</span><strong className="mt-1 block text-lg">{Math.max(0, Math.ceil((run.durationMs - elapsed) / 1000))}s</strong></div>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full bg-scent-accent transition-[width] duration-100" style={{ width: `${progress}%` }} /></div>

        <div
          className="relative mt-3 min-h-[52svh] flex-1 overflow-hidden rounded-[var(--radius-scent)] border border-scent-accent/24 bg-[radial-gradient(circle_at_50%_10%,rgba(62,56,92,0.58),transparent_35%),linear-gradient(180deg,#100f20_0%,#08070d_45%,#17110d_100%)] shadow-[inset_0_1px_0_rgba(255,236,183,0.08)] touch-none"
          onPointerDown={(event) => { pointerStartRef.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerUp={(event) => {
            const start = pointerStartRef.current; pointerStartRef.current = null; if (!start) return;
            const dx = event.clientX - start.x; const dy = event.clientY - start.y;
            if (Math.abs(dx) > 34 && Math.abs(dx) > Math.abs(dy)) setLane(laneRef.current + (dx > 0 ? 1 : -1)); else jump();
          }}
          style={{ touchAction: 'none' }}
        >
          <div className="absolute inset-x-0 top-0 h-2/5 opacity-80" aria-hidden="true"><div className="absolute inset-x-0 bottom-0 h-px bg-scent-accent/22" /><div className="absolute bottom-4 left-[12%] h-20 w-12 bg-black/55 shadow-[70px_8px_0_6px_rgba(0,0,0,.48),150px_-12px_0_10px_rgba(0,0,0,.55),240px_5px_0_4px_rgba(0,0,0,.5),330px_-18px_0_12px_rgba(0,0,0,.55)]" /></div>
          <div className="absolute inset-x-[8%] bottom-0 top-[28%] grid grid-cols-3 [perspective:500px]">
            {[0, 1, 2].map((track) => <div key={track} className="border-x border-scent-accent/12 bg-gradient-to-b from-white/[0.01] to-scent-accent/[0.035]" />)}
          </div>
          {activeEvents.map((event) => {
            const travel = Math.max(0, Math.min(1, 1 - (event.atMs - elapsed) / 1_350));
            return <div key={event.id} className="absolute z-20 -translate-x-1/2 text-center" style={{ left: `${16.7 + event.lane * 33.3}%`, top: reducedMotion ? '45%' : `${22 + travel * 55}%`, transform: `translateX(-50%) scale(${0.7 + travel * 0.3})` }} aria-hidden="true">
              <div className={event.kind === 'orb' ? 'grid h-12 w-12 place-items-center rounded-full border border-scent-accent/60 bg-scent-accent/18 text-lg text-scent-accent shadow-[0_0_22px_rgba(212,175,55,.24)]' : event.kind === 'hazard' ? 'grid h-14 min-w-16 place-items-center rounded-2xl border border-red-300/30 bg-red-950/70 px-2 text-xs text-red-100' : 'grid h-12 min-w-14 place-items-center rounded-full border border-cyan-200/30 bg-cyan-950/65 px-2 text-xs text-cyan-50'}>{event.kind === 'orb' ? '✦' : event.kind === 'hazard' ? '!' : event.kind === 'pickup' ? '◇' : '☺'}</div>
              <span className="mt-1 block text-[10px] font-semibold text-white/90">{eventLabel(event, run)}</span>
            </div>;
          })}
          <div className="absolute bottom-8 z-30 -translate-x-1/2 transition-[left,transform] duration-150" style={{ left: `${16.7 + lane * 33.3}%`, transform: `translateX(-50%) translateY(${jumping ? '-42px' : '0'})` }} aria-label={`Player in lane ${lane + 1}`}>
            <div className="relative grid h-16 w-12 place-items-center rounded-t-full rounded-b-xl border border-scent-accent/50 bg-[linear-gradient(180deg,#f3d98a,#6f5120)] text-black shadow-[0_0_24px_rgba(212,175,55,.25)]"><Sparkles className="h-5 w-5" />{shielded && <Shield className="absolute -right-3 -top-2 h-5 w-5 text-cyan-200" />}</div>
          </div>
          {paused && <div className="absolute inset-0 z-40 grid place-items-center bg-black/72 backdrop-blur-sm"><div className="text-center"><p className="font-serif text-3xl">Run paused</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => setPaused(false)} className="scent-primary-button inline-flex min-h-12 items-center gap-2 rounded-full px-6"><Play className="h-4 w-4" /><span>Resume</span></button><button type="button" onClick={onExit} className="min-h-12 rounded-full border border-white/16 px-6">Exit run</button></div></div></div>}
          {submitting && <div className="absolute inset-0 z-40 grid place-items-center bg-black/78"><p className="scent-type-label text-scent-accent">Securing result…</p></div>}
        </div>

        <div className="mt-3 min-h-6 text-center text-sm text-scent-text-muted" aria-live="polite">{error || status}{error && <button type="button" onClick={() => void finish()} className="ml-2 min-h-10 rounded-full border border-red-200/30 px-3 text-red-100">Retry save</button>}</div>
        <div className="mt-2 grid grid-cols-[1fr_auto_1fr] gap-2">
          <button type="button" onClick={() => setLane(lane - 1)} disabled={paused || submitting || lane === 0} className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/12 disabled:opacity-35" aria-label="Move left"><ArrowLeft /></button>
          <button type="button" onClick={jump} disabled={paused || submitting} className="min-h-12 rounded-xl border border-scent-accent/34 px-6 font-semibold text-scent-accent disabled:opacity-35" aria-label="Jump or dash">Jump</button>
          <button type="button" onClick={() => setLane(lane + 1)} disabled={paused || submitting || lane === 2} className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/12 disabled:opacity-35" aria-label="Move right"><ArrowRight /></button>
        </div>
        <div className="mt-2 flex items-center justify-center gap-2">
          <button type="button" onClick={() => { setMuted((value) => !value); emitRushEvent('rush_audio_toggled', { muted: !muted }); }} className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-xs text-scent-text-muted" aria-label={muted ? 'Enable game audio' : 'Mute game audio'}>{muted ? <VolumeX className="h-4 w-4" /> : <AudioLines className="h-4 w-4" />}{muted ? 'Muted' : 'Audio on'}</button>
          <button type="button" onClick={() => { setReducedMotion((value) => !value); emitRushEvent('rush_reduced_motion_used'); }} className="min-h-10 rounded-full px-3 text-xs text-scent-text-muted" aria-pressed={reducedMotion}>Reduced motion {reducedMotion ? 'on' : 'off'}</button>
        </div>
      </div>
    </div>
  );
}

export const ScentRush: React.FC<ScentRushProps> = ({ fragrances, authToken, onSignIn }) => {
  const [selectedId, setSelectedId] = useState(fragrances[0]?.fragranceId || '');
  const [progress, setProgress] = useState<RushProgressSummary>(EMPTY_PROGRESS);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [starting, setStarting] = useState(false);
  const [run, setRun] = useState<RushRun | null>(null);
  const [result, setResult] = useState<RushResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const selected = useMemo(() => fragrances.find((item) => item.fragranceId === selectedId) || fragrances[0], [fragrances, selectedId]);

  useEffect(() => { if (fragrances.length && !fragrances.some((item) => item.fragranceId === selectedId)) setSelectedId(fragrances[0]!.fragranceId); }, [fragrances, selectedId]);
  const loadProgress = useCallback(async () => {
    if (!selected) { setProgress(EMPTY_PROGRESS); setProgressError(null); return; }
    setLoadingProgress(true); setProgressError(null);
    try { setProgress(await getRushProgress(selected.fragranceId, authToken)); }
    catch (err) { setProgress(EMPTY_PROGRESS); setProgressError(err instanceof Error ? err.message : 'Support progress is unavailable.'); }
    finally { setLoadingProgress(false); }
  }, [authToken, selected]);
  useEffect(() => { void loadProgress(); }, [loadProgress]);

  const start = async (replay = false) => {
    if (!selected) return;
    if (!authToken) { onSignIn(); return; }
    setStarting(true); setError(null); setResult(null);
    try {
      const next = await startRushRun(selected, authToken); setRun(next); setProgress(next.progress);
      emitRushEvent(replay ? 'rush_replay_started' : 'rush_run_started', { fragranceId: selected.fragranceId });
    } catch (err) { setError(err instanceof Error ? err.message : 'Rush could not start.'); }
    finally { setStarting(false); }
  };

  return <section className="mx-auto mb-8 w-full max-w-4xl overflow-hidden rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/24 bg-[radial-gradient(circle_at_82%_0%,rgba(103,85,180,.2),transparent_34%),linear-gradient(145deg,rgba(14,12,24,.96),rgba(5,4,3,.96))] shadow-[inset_0_1px_0_rgba(255,236,183,.08),0_24px_58px_-48px_rgba(0,0,0,.95)]">
    <div className="grid gap-6 p-5 sm:p-7 md:grid-cols-[1.25fr_.75fr]">
      <div><p className="scent-type-label text-scent-accent">New in Arena · ScentBeam Rush</p><h2 className="mt-3 font-serif text-3xl text-foreground sm:text-4xl">Turn a scent trial into support.</h2><p className="mt-3 max-w-xl text-sm leading-6 text-scent-text-muted sm:text-base">Collect signature notes, survive culture hazards, and charge an automatic Scent Beam. Your highest Fresh Start result becomes permanent Beam Power—replays only improve your best.</p>
        {fragrances.length > 0 ? <div className="mt-5 flex max-h-28 flex-wrap gap-2 overflow-y-auto" aria-label="Choose an owned fragrance for Rush">{fragrances.map((fragrance) => <button key={fragrance.fragranceId} type="button" onClick={() => setSelectedId(fragrance.fragranceId)} aria-pressed={selected?.fragranceId === fragrance.fragranceId} className={`min-h-11 max-w-full truncate rounded-full border px-4 text-sm transition-colors ${selected?.fragranceId === fragrance.fragranceId ? 'border-scent-accent/60 bg-scent-accent/12 text-foreground' : 'border-white/12 text-scent-text-muted'}`}>{fragrance.name}</button>)}</div> : <p className="mt-5 rounded-xl border border-white/10 bg-white/[.025] p-4 text-sm text-scent-text-muted">{authToken ? 'Add a fragrance to your wardrobe to unlock Fresh Start.' : 'Sign in and add a fragrance to your wardrobe to unlock Fresh Start.'}</p>}
        {error && <p className="mt-4 text-sm text-red-200" role="alert">{error}</p>}
        <button type="button" onClick={() => void start(false)} disabled={!selected || starting} className="scent-primary-button mt-5 inline-flex min-h-12 items-center gap-2 rounded-[var(--radius-scent)] px-6 disabled:opacity-50"><Play className="h-4 w-4" /><span>{starting ? 'Issuing run…' : authToken ? 'Play Fresh Start' : 'Sign in to play'}</span></button>
        <p className="mt-3 text-xs text-scent-text-subtle">About 30 seconds · Fresh Start max 2 Beam Power · Audio muted by default</p>
      </div>
      <div className="space-y-3"><div className="rounded-[var(--radius-scent)] border border-scent-accent/18 bg-black/32 p-4"><p className="scent-type-label">Your support</p><div className="mt-3 flex items-end justify-between"><strong className="font-serif text-4xl text-scent-accent">{loadingProgress ? '—' : progress.user.freshStartBeamPower}<span className="text-lg text-scent-text-muted"> / 2</span></strong><span className="text-xs text-scent-text-muted">Best {progress.user.freshStartBestScore.toLocaleString()}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full bg-scent-accent" style={{ width: `${progress.user.freshStartBeamPower * 50}%` }} /></div></div>
        {progressError && <div className="rounded-xl border border-red-300/20 bg-red-950/20 p-3 text-sm text-red-100" role="alert">Support progress could not load.<button type="button" onClick={() => void loadProgress()} className="ml-2 min-h-11 rounded-full border border-red-200/30 px-3">Retry</button></div>}
        <div className="grid grid-cols-2 gap-3"><div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><span className="scent-type-label">Beam Supporters</span><strong className="mt-2 block text-2xl">{progress.beamSupporters}</strong></div><div className="rounded-xl border border-white/8 bg-white/[.025] p-3"><span className="scent-type-label">Total Beam Power</span><strong className="mt-2 block text-2xl">{progress.totalBeamPower}</strong></div></div>
        <div className="rounded-xl border border-white/8 p-3 text-sm text-scent-text-muted"><span className="text-foreground">Fresh Start</span> · Available<div className="mt-2 border-t border-white/8 pt-2 text-scent-text-subtle">Situation Test + Signature Trial · Coming next</div></div>
      </div>
    </div>
    {run && authToken && <RunScreen run={run} authToken={authToken} onExit={() => setRun(null)} onComplete={(value) => { setRun(null); setResult(value); setProgress(value.progress); }} />}
    {result && <div className="fixed inset-0 z-[140] grid place-items-center overflow-y-auto bg-black/94 p-4" role="dialog" aria-modal="true" aria-labelledby="rush-result-title"><div className="my-auto w-full max-w-lg rounded-[var(--radius-scent)] border border-scent-accent/28 bg-[#0a0808] p-5 text-center shadow-[inset_0_1px_0_rgba(255,236,183,.08)] sm:p-8"><p className="scent-type-label text-scent-accent">Fresh Start complete</p><h2 id="rush-result-title" className="mt-3 font-serif text-4xl">{Math.round(result.performance * 100)}%</h2><p className="mt-2 text-scent-text-muted">Run score {result.score.toLocaleString()} of {result.maximumPossibleScore.toLocaleString()}</p><div className="mt-5 grid grid-cols-2 gap-3 text-left"><div className="rounded-xl border border-white/8 p-3"><span className="scent-type-label">Beam Power earned</span><strong className="mt-2 block text-2xl text-scent-accent">{result.beamPowerEarned}</strong><small className="text-scent-text-muted">Stored {result.storedBeamPower} / 2</small></div><div className="rounded-xl border border-white/8 p-3"><span className="scent-type-label">Best score</span><strong className="mt-2 block text-2xl">{result.newBest.toLocaleString()}</strong><small className="text-scent-text-muted">Previous {result.previousBest.toLocaleString()}</small></div><div className="rounded-xl border border-white/8 p-3"><span className="scent-type-label">Notes collected</span><strong className="mt-2 block text-2xl">{result.collectedOrbIds.length}</strong></div><div className="rounded-xl border border-white/8 p-3"><span className="scent-type-label">Hazards hit</span><strong className="mt-2 block text-2xl">{result.hazardsHit}</strong></div><div className="rounded-xl border border-white/8 p-3"><span className="scent-type-label">Beam Supporters</span><strong className="mt-2 block text-2xl">{result.progress.beamSupporters}</strong><small className="text-scent-text-muted">Distinct supporters</small></div><div className="rounded-xl border border-white/8 p-3"><span className="scent-type-label">Total Beam Power</span><strong className="mt-2 block text-2xl">{result.progress.totalBeamPower}</strong><small className="text-scent-text-muted">Best power combined</small></div></div><p className="mt-5 text-sm text-scent-text-muted">{result.bestUpgraded ? 'New personal best secured. Replay to improve it again.' : result.beamPowerEarned ? 'Your stored best still stands—Beam Power did not stack.' : 'Reach 45% to earn your first Beam Power.'}</p><div className="mt-5 grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => void start(true)} className="scent-primary-button inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-scent)]"><RotateCcw className="h-4 w-4" /><span>Replay</span></button><button type="button" onClick={() => setResult(null)} className="min-h-12 rounded-[var(--radius-scent)] border border-white/14">Continue Arena</button></div></div></div>}
  </section>;
};
