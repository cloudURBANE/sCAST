import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Flame,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import { CrowdReadBattleSide } from "@/components/arena/CrowdReadBattleSide";
import type { ArenaBattle } from "@/components/arena/arenaBattleMapper";
import { arenaPercentFor, arenaVoteTotal } from "@/components/arena/arenaTwists";
import {
  fetchCrowdStats,
  fetchPlayableCrowdBattles,
  submitCrowdRead,
  type CrowdReadReveal,
  type CrowdStats,
} from "@/lib/arenaCrowdReadClient";

interface CrowdVsYouProps {
  authToken: string | null;
  onSignIn: () => void;
}

// Per-battle phase machine. `idle` is only the entry card (before the queue is
// opened); each subsequent battle starts in `predict`.
type Phase = "idle" | "predict" | "ownpick" | "revealing" | "revealed";

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; battles: ArenaBattle[] };

const DAILY_TARGET = 3;

export const CrowdVsYou: React.FC<CrowdVsYouProps> = ({ authToken, onSignIn }) => {
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });
  // `started` gates the entry card vs. the active read flow.
  const [started, setStarted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const [phase, setPhase] = useState<Phase>("idle");
  const [predictedChoice, setPredictedChoice] = useState<string | null>(null);
  const [ownPick, setOwnPick] = useState<string | null>(null);
  const [reveal, setReveal] = useState<CrowdReadReveal | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Persisted Beam Streak (so a returning user sees their real streak on the
  // entry card / predict header, not 0). The freshest reveal wins once a read
  // is scored this session.
  const [stats, setStats] = useState<CrowdStats | null>(null);

  const battles = fetchState.status === "ready" ? fetchState.battles : [];
  const activeBattle = battles[activeIndex] ?? null;
  const isLastBattle = activeIndex >= battles.length - 1;
  const remaining = Math.max(0, battles.length - activeIndex);

  const loadBattles = useCallback(async () => {
    if (!authToken) {
      setFetchState({ status: "ready", battles: [] });
      return;
    }
    setFetchState({ status: "loading" });
    try {
      const result = await fetchPlayableCrowdBattles(authToken);
      setFetchState({ status: "ready", battles: result });
    } catch (err) {
      setFetchState({
        status: "error",
        message: err instanceof Error ? err.message : "Crowd vs You could not load.",
      });
    }
  }, [authToken]);

  // Reset the whole mode whenever the viewer identity changes.
  useEffect(() => {
    setStarted(false);
    setActiveIndex(0);
    setPhase("idle");
    setPredictedChoice(null);
    setOwnPick(null);
    setReveal(null);
    setSubmitError(null);
    setFetchState({ status: "idle" });
    setStats(null);
    let cancelled = false;
    void fetchCrowdStats(authToken).then((next) => {
      if (!cancelled) setStats(next);
    });
    return () => {
      cancelled = true;
    };
  }, [authToken]);

  const resetBattlePhase = () => {
    setPhase("predict");
    setPredictedChoice(null);
    setOwnPick(null);
    setReveal(null);
    setSubmitError(null);
  };

  const handleStart = () => {
    if (!authToken) {
      onSignIn();
      return;
    }
    setStarted(true);
    setActiveIndex(0);
    resetBattlePhase();
    void loadBattles();
  };

  const handleSelectBet = (choice: string) => {
    if (phase !== "predict") return;
    setPredictedChoice(choice);
    setPhase("ownpick");
  };

  const handleSelectOwnPick = useCallback(
    async (choice: string) => {
      if (phase !== "ownpick" || !activeBattle || !predictedChoice || !authToken) return;
      setOwnPick(choice);
      setPhase("revealing");
      setSubmitError(null);
      try {
        const result = await submitCrowdRead({
          postId: activeBattle.id,
          predictedChoice,
          ownPick: choice,
          authToken,
        });
        setReveal(result);
        setPhase("revealed");
      } catch (err) {
        setSubmitError(
          err instanceof Error ? err.message : "Your read could not be saved.",
        );
        // Roll back to the own-pick step so the user can retry the tap.
        setOwnPick(null);
        setPhase("ownpick");
      }
    },
    [activeBattle, authToken, phase, predictedChoice],
  );

  const handleNext = () => {
    if (isLastBattle) return;
    setActiveIndex((index) => index + 1);
    resetBattlePhase();
  };

  // Build an ArenaBattle-shaped object whose votes = the reveal tally, so the
  // shared arenaPercentFor / arenaVoteTotal helpers light up the bar.
  const revealBattle = useMemo<ArenaBattle | null>(() => {
    if (!activeBattle || !reveal) return null;
    return { ...activeBattle, votes: reveal.tally };
  }, [activeBattle, reveal]);

  // -- Render helpers --------------------------------------------------------

  const sectionClass = "relative mx-auto w-full max-w-4xl";

  // Entry card (and signed-out state).
  if (!started) {
    return (
      <section className={sectionClass} aria-labelledby="crowd-vs-you-title">
        <div className="rounded-lg border border-scent-accent/24 bg-black/72 p-5 shadow-[inset_0_1px_0_rgba(255,236,183,0.06),0_18px_44px_-34px_rgba(0,0,0,0.9)] sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="scent-type-label text-scent-accent">Daily ritual</p>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 scent-type-chip text-scent-accent shadow-[inset_0_0_0_1px_rgba(212,175,55,0.18)]">
              <Flame size={13} strokeWidth={2} aria-hidden="true" />
              {authToken ? `Beam Streak ${stats?.current_streak ?? 0}` : "Beam Streak"}
            </span>
          </div>
          <h2
            id="crowd-vs-you-title"
            className="mt-3 font-serif text-3xl leading-[1.05] text-foreground sm:text-4xl"
          >
            Crowd vs You
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-scent-text-muted sm:text-base sm:leading-7">
            Two blind taps on each matchup: read who the crowd backs, then pick
            the one you would actually wear. Reveal the tally and grow your Beam
            Streak.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleStart}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-scent-accent px-5 py-3 text-xs font-bold uppercase tracking-[0.12em] text-black shadow-[0_14px_30px_-24px_rgba(0,0,0,0.7)] transition-colors hover:bg-[#f0cf70] active:bg-[#d7ad32] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 sm:text-sm sm:tracking-[0.16em]"
            >
              <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>{authToken ? "Start today's read" : "Sign in to play"}</span>
            </button>
            {authToken ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1 scent-type-chip text-scent-text-muted shadow-[inset_0_0_0_1px_rgba(212,175,55,0.14)]">
                <Users size={13} strokeWidth={2} aria-hidden="true" />
                {stats && stats.total_reads > 0
                  ? `Best ${stats.best_streak} · ${stats.accuracy}% read`
                  : `${DAILY_TARGET} reads a day`}
              </span>
            ) : (
              <p className="text-xs font-medium leading-5 text-scent-text-subtle">
                Sign in to read the crowd and keep a streak.
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  // Loading.
  if (fetchState.status === "loading" || fetchState.status === "idle") {
    return (
      <section className={sectionClass}>
        <div className="grid min-h-[40svh] place-items-center rounded-lg border border-scent-accent/18 bg-black/68 p-6 text-center">
          <div>
            <LoaderCircle
              className="mx-auto h-8 w-8 animate-spin text-scent-accent"
              aria-hidden="true"
            />
            <p className="mt-4 scent-type-label text-scent-accent/82">
              Loading today's reads
            </p>
          </div>
        </div>
      </section>
    );
  }

  // Error.
  if (fetchState.status === "error") {
    return (
      <section className={sectionClass} role="alert">
        <div className="rounded-lg border border-red-500/24 bg-red-500/[0.055] p-6 text-center">
          <p className="font-serif text-2xl text-red-100">
            Crowd vs You could not load.
          </p>
          <p className="mt-3 text-sm leading-6 text-red-100/82">
            {fetchState.message}
          </p>
          <button
            type="button"
            onClick={() => void loadBattles()}
            className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-red-200/38 px-5 py-2 scent-type-chip text-red-100 transition-colors hover:border-red-200/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200/70"
          >
            <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
            Try again
          </button>
        </div>
      </section>
    );
  }

  // Empty / nothing qualifies.
  if (!activeBattle) {
    return (
      <section className={sectionClass}>
        <div className="rounded-lg border border-scent-accent/24 bg-black/68 p-6 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.06),0_18px_44px_-34px_rgba(0,0,0,0.9)] sm:p-8">
          <Users className="mx-auto h-9 w-9 text-scent-accent" aria-hidden="true" />
          <p className="mt-4 font-serif text-2xl text-foreground">
            That's all the crowd's settled on today.
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-scent-text-muted">
            Check back as votes come in — more reads open up as battles reach a
            clear lead.
          </p>
        </div>
      </section>
    );
  }

  const total = revealBattle ? arenaVoteTotal(revealBattle) : 0;
  const leftKey = activeBattle.left.key;
  const rightKey = activeBattle.right.key;
  const leftCount = revealBattle ? revealBattle.votes[leftKey] ?? 0 : 0;
  const rightCount = revealBattle ? revealBattle.votes[rightKey] ?? 0 : 0;
  const leftPercent = revealBattle ? arenaPercentFor(revealBattle, leftKey) : 0;
  const rightPercent = revealBattle ? arenaPercentFor(revealBattle, rightKey) : 0;
  const leftShare = total > 0 ? (leftCount / total) * 100 : 50;

  const isPush = reveal !== null && reveal.leader_at_reveal === null;

  // Phase-driven header copy + Beam Streak meta (spec B.4).
  const streakValue =
    reveal?.current_streak ?? stats?.current_streak ?? 0;
  const headerKicker =
    phase === "predict"
      ? `CROWD FAVORS? · Beam Streak ${streakValue}`
      : phase === "ownpick"
        ? "AND YOU — WHICH WOULD YOU WEAR?"
        : phase === "revealing"
          ? "REVEALING…"
          : "THE READ";

  const submitting = phase === "revealing";

  // Which marker each card currently offers, and which is locked.
  const cardMarker = phase === "predict" ? "bet" : "pick";
  const betKey = predictedChoice;
  const pickKey = ownPick;

  return (
    <section className={sectionClass} aria-labelledby="crowd-vs-you-active-title">
      <header className="px-2 text-center">
        <p className="scent-type-label text-scent-accent">Crowd vs You</p>
        <h2
          id="crowd-vs-you-active-title"
          className="mt-2 text-pretty text-balance font-serif text-xl leading-tight text-foreground sm:text-3xl"
        >
          {activeBattle.title}
        </h2>
        <div
          className="mt-3 flex flex-wrap items-center justify-center gap-2"
          aria-live="polite"
        >
          <span className="scent-type-label uppercase text-scent-accent/85">
            {headerKicker}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 scent-type-chip text-scent-accent shadow-[inset_0_0_0_1px_rgba(212,175,55,0.18)]">
            <Flame size={12} strokeWidth={2} aria-hidden="true" />
            {`Beam Streak ${streakValue}`}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1 scent-type-chip text-scent-text-muted shadow-[inset_0_0_0_1px_rgba(212,175,55,0.14)]">
            <Users size={12} strokeWidth={2} aria-hidden="true" />
            {`${remaining}/${battles.length}`}
          </span>
        </div>
      </header>

      <div className="relative mx-auto mt-5 grid w-full max-w-4xl grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)] items-stretch gap-1.5 sm:mt-8 sm:grid-cols-[minmax(0,1fr)_2.75rem_minmax(0,1fr)] sm:gap-4 md:gap-5">
        <CrowdReadBattleSide
          side={activeBattle.left}
          align="left"
          isBet={betKey === leftKey}
          isPick={pickKey === leftKey}
          marker={cardMarker}
          disabled={submitting || phase === "revealed"}
          onSelect={() =>
            phase === "predict"
              ? handleSelectBet(leftKey)
              : phase === "ownpick"
                ? void handleSelectOwnPick(leftKey)
                : undefined
          }
        />

        <div className="grid place-items-center">
          <div
            className="grid h-6 w-6 place-items-center rounded-full bg-black/88 text-[9px] font-bold tracking-[0.08em] text-scent-accent shadow-[0_0_0_1px_rgba(212,175,55,0.18),0_0_18px_rgba(212,175,55,0.14),inset_0_1px_0_rgba(255,255,255,0.08)] sm:sticky sm:top-[calc(var(--topbar-h)+1rem)] sm:h-11 sm:w-11 sm:text-sm sm:tracking-[0.12em]"
            aria-hidden="true"
          >
            VS
          </div>
        </div>

        <CrowdReadBattleSide
          side={activeBattle.right}
          align="right"
          isBet={betKey === rightKey}
          isPick={pickKey === rightKey}
          marker={cardMarker}
          disabled={submitting || phase === "revealed"}
          onSelect={() =>
            phase === "predict"
              ? handleSelectBet(rightKey)
              : phase === "ownpick"
                ? void handleSelectOwnPick(rightKey)
                : undefined
          }
        />
      </div>

      {submitError ? (
        <p role="alert" className="mx-auto mt-4 max-w-2xl text-center text-sm text-red-100">
          {submitError}
        </p>
      ) : null}

      {phase === "revealing" ? (
        <p className="mx-auto mt-6 flex max-w-xl items-center justify-center gap-2 text-center text-sm text-scent-text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin text-scent-accent" aria-hidden="true" />
          Reading the crowd…
        </p>
      ) : null}

      {phase === "revealed" && reveal && revealBattle ? (
        <section
          className="arena-reveal-stagger mx-auto mt-4 w-full max-w-4xl animate-in fade-in slide-in-from-bottom-4 space-y-3 duration-500 sm:mt-8 sm:space-y-4"
          aria-live="polite"
        >
          {/* Tally bar — same markup + tokens as ArenaResultReveal. */}
          <div className="relative rounded-lg border border-scent-accent/18 bg-[rgba(5,4,3,0.86)] p-3 text-center shadow-[0_28px_80px_-56px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,236,183,0.08)] sm:p-6">
            <div className="mx-auto max-w-2xl">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 text-center text-[11px] font-bold uppercase leading-4 tracking-[0.1em] text-scent-text-muted sm:gap-3 sm:text-xs sm:tracking-[0.12em]">
                <span className="min-w-0 whitespace-normal">{activeBattle.left.name}</span>
                <span className="shrink-0 text-scent-accent">
                  {total} {total === 1 ? "vote" : "votes"}
                </span>
                <span className="min-w-0 whitespace-normal">{activeBattle.right.name}</span>
              </div>
              <div
                className="mt-3 flex h-4 overflow-hidden rounded-full bg-scent-accent/8 shadow-[inset_0_0_0_1px_rgba(212,175,55,0.12)]"
                aria-hidden="true"
              >
                <span
                  className="arena-bar-segment block h-full rounded-l-full bg-gradient-to-r from-scent-accent/95 to-scent-accent/72"
                  style={{ width: `${leftShare}%` }}
                />
                <span
                  className="arena-bar-segment block h-full rounded-r-full bg-gradient-to-r from-scent-accent/30 to-scent-accent/48"
                  style={{ width: `${100 - leftShare}%` }}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-center text-xs font-semibold leading-5 text-scent-text-muted">
                <span>
                  {leftPercent}% - {leftCount} {leftCount === 1 ? "vote" : "votes"}
                </span>
                <span>
                  {rightPercent}% - {rightCount} {rightCount === 1 ? "vote" : "votes"}
                </span>
              </div>
            </div>

            {/* Two payoffs side by side: crowd read ✓/✗ → Beam Streak, and the
                taste-mirror "with / against the crowd" badge. */}
            <div className="mt-5 grid gap-3 border-t border-scent-accent/10 pt-5 sm:grid-cols-2">
              <div
                className={[
                  "rounded-md border p-3 text-left",
                  isPush
                    ? "border-scent-accent/24 bg-white/[0.02]"
                    : reveal.was_correct
                      ? "border-scent-accent/40 bg-scent-accent/[0.06]"
                      : "border-white/12 bg-white/[0.02]",
                ].join(" ")}
              >
                <p className="scent-type-label text-scent-accent/85">
                  {isPush
                    ? "No clear leader"
                    : reveal.was_correct
                      ? "You read the crowd"
                      : "Missed the crowd"}
                </p>
                <p className="mt-1.5 inline-flex items-center gap-1.5 font-serif text-xl text-foreground">
                  <Flame size={16} strokeWidth={2} className="text-scent-accent" aria-hidden="true" />
                  {isPush
                    ? "Streak held"
                    : `Beam Streak ${reveal.current_streak}`}
                </p>
                <p className="mt-1 text-xs leading-5 text-scent-text-muted">
                  {isPush
                    ? "No clear leader — your streak is unchanged."
                    : `Best ${reveal.best_streak} · ${reveal.accuracy}% accuracy`}
                </p>
              </div>

              <div className="rounded-md border border-scent-accent/18 bg-white/[0.02] p-3 text-left">
                <p className="scent-type-label text-scent-accent/85">Your taste</p>
                <p className="mt-1.5 inline-flex items-center gap-1.5 font-serif text-xl text-foreground">
                  <Target size={16} strokeWidth={2} className="text-scent-accent" aria-hidden="true" />
                  {reveal.went_with_crowd ? "With the crowd" : "Against the crowd"}
                </p>
                <p className="mt-1 text-xs leading-5 text-scent-text-muted">
                  {reveal.went_with_crowd
                    ? "Your pick matched where the room landed."
                    : "Your pick went its own way."}
                </p>
              </div>
            </div>
          </div>

          {/* Next / completion. */}
          <div className="flex justify-center rounded-lg border border-scent-accent/14 bg-black/70 p-3 shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] sm:p-4">
            {isLastBattle ? (
              <p className="px-2 py-2 text-center text-sm font-medium leading-6 text-scent-text-muted">
                That's your daily set. Check back tomorrow to keep your streak alive.
              </p>
            ) : (
              <button
                type="button"
                onClick={handleNext}
                className="scent-no-mobile-focus-ring inline-flex min-h-12 w-full max-w-md items-center justify-center gap-2 rounded-lg bg-scent-accent px-4 py-3 text-xs font-bold uppercase tracking-[0.12em] text-black transition-colors hover:bg-[#f0cf70] active:bg-[#d7ad32] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-scent-accent/70 sm:text-sm sm:tracking-[0.16em]"
              >
                <span>Next read</span>
                <ArrowRight size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
          </div>
        </section>
      ) : phase !== "revealing" ? (
        <p className="mx-auto mt-6 max-w-xl text-center text-sm leading-6 text-scent-text-subtle">
          {phase === "predict"
            ? "Tap the side you think the crowd is backing. The tally stays hidden."
            : "Now tap the one you would actually wear — then the tally reveals."}
        </p>
      ) : null}
    </section>
  );
};

export default CrowdVsYou;
