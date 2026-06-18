import React, { useEffect, useRef, useState } from "react";
import { ArenaBattleSide } from "@/components/arena/ArenaBattleSide";
import { ArenaCompareDialog } from "@/components/arena/ArenaCompareDialog";
import { ArenaResultReveal } from "@/components/arena/ArenaResultReveal";
import type { ArenaBattle } from "@/components/arena/arenaBattleMapper";
import type { ArenaReasonKey } from "@/components/arena/arenaTwists";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  readArenaReason,
  writeArenaReason,
} from "@/components/arena/arenaReasonStore";
import { useCommunityBattleVote } from "@/components/community/communityPosts";

interface ArenaBattleStageProps {
  battle: ArenaBattle;
  authToken: string | null;
  /** False when this is the only loaded battle, so the reveal can disable "Next battle". */
  hasMoreBattles?: boolean;
  onSignIn: () => void;
  onNext: () => void;
  onGuestVoteQueued: (vote: { postId: string; choice: string }) => void;
  externalVotePending?: boolean;
  externalErrorMessage?: string | null;
}

export const ArenaBattleStage: React.FC<ArenaBattleStageProps> = ({
  battle,
  authToken,
  hasMoreBattles = true,
  onSignIn,
  onNext,
  onGuestVoteQueued,
  externalVotePending = false,
  externalErrorMessage = null,
}) => {
  const voteMutation = useCommunityBattleVote(authToken);
  const [localVote, setLocalVote] = useState<string | null>(battle.viewerVote);
  // Server-synced reason wins; localStorage is the offline / guest fallback so a
  // revisited battle restores the resolved "why it won" state without re-prompting.
  const [reason, setReasonState] = useState<ArenaReasonKey | null>(
    () => battle.viewerReason ?? readArenaReason(battle.id).reason,
  );
  // Whether the viewer explicitly skipped the reason for this battle. Client-only
  // (localStorage) — a skip just suppresses the prompt and carries no server state.
  const [reasonDeclined, setReasonDeclinedState] = useState<boolean>(
    () => readArenaReason(battle.id).declined,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The choice the viewer just picked *this mount*. Drives the one-shot save
  // animation + reveal entrance; stays null when the resolved state is merely
  // restored from the server, so revisiting never replays the animation.
  const [justVotedChoice, setJustVotedChoice] = useState<string | null>(null);
  const [pendingSwitchChoice, setPendingSwitchChoice] = useState<string | null>(
    null,
  );
  // Pre-vote head-to-head compare overlay. Opens from tapping a contender card
  // before a pick is made; closing it leaves the vote flow untouched.
  const [compareOpen, setCompareOpen] = useState(false);
  const revealRef = useRef<HTMLDivElement>(null);

  // Battle identity changed → adopt that battle's resolved state from scratch.
  useEffect(() => {
    const stored = readArenaReason(battle.id);
    setLocalVote(battle.viewerVote);
    setReasonState(battle.viewerReason ?? stored.reason);
    setReasonDeclinedState(stored.declined);
    setErrorMessage(null);
    setJustVotedChoice(null);
    setPendingSwitchChoice(null);
    setCompareOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle.id]);

  // The viewer's saved pick can arrive after mount (async feed load / refetch).
  // Adopt it without a fresh-vote animation when we don't already have one.
  useEffect(() => {
    if (battle.viewerVote && !localVote) setLocalVote(battle.viewerVote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle.viewerVote]);

  // Likewise adopt a server-synced reason (cross-device) until the viewer edits
  // it locally this session.
  useEffect(() => {
    if (battle.viewerReason && !reason) setReasonState(battle.viewerReason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle.viewerReason]);

  const persistReason = (next: ArenaReasonKey | null) => {
    // Push the reason to the server (cross-device) alongside the current pick.
    // Guests have no server row yet — localStorage already holds their choice.
    if (authToken && localVote) {
      voteMutation.mutate({ postId: battle.id, choice: localVote, reason: next });
    }
  };

  const handleReasonChange = (next: ArenaReasonKey) => {
    setReasonState(next);
    setReasonDeclinedState(false);
    writeArenaReason(battle.id, { reason: next, declined: false });
    persistReason(next);
  };

  const handleReasonDeclinedChange = (declined: boolean) => {
    setReasonDeclinedState(declined);
    writeArenaReason(battle.id, { reason, declined });
  };

  const revealed = Boolean(localVote);
  const freshVote = justVotedChoice !== null;

  // Bring the result + reason picker into view once a fresh vote reveals it,
  // so mobile users aren't left staring at the cards with results below the fold.
  useEffect(() => {
    if (revealed && freshVote && revealRef.current) {
      revealRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, freshVote]);
  const guestLocalOnly = Boolean(localVote && !authToken);
  const selectedKey = localVote;
  const votePending = voteMutation.isPending || externalVotePending;
  const displayedErrorMessage = errorMessage ?? externalErrorMessage;

  const submitVote = (choice: string) => {
    setJustVotedChoice(choice);
    setLocalVote(choice);
    setPendingSwitchChoice(null);
    setErrorMessage(null);

    if (!authToken) {
      onGuestVoteQueued({ postId: battle.id, choice });
      return;
    }

    // Carry the current reason so switching picks keeps a chosen reason in sync.
    voteMutation.mutate(
      { postId: battle.id, choice, reason },
      {
        onError: (err) => {
          setErrorMessage(
            err instanceof Error ? err.message : "Vote could not be saved.",
          );
        },
      },
    );
  };

  const requestVote = (choice: string) => {
    if (choice === localVote) return;
    if (localVote) {
      setPendingSwitchChoice(choice);
      return;
    }
    submitVote(choice);
  };

  const pendingSwitchSide =
    pendingSwitchChoice === battle.left.key
      ? battle.left
      : pendingSwitchChoice === battle.right.key
        ? battle.right
        : null;
  const currentPickSide =
    localVote === battle.left.key
      ? battle.left
      : localVote === battle.right.key
        ? battle.right
        : null;

  const confirmPendingSwitch = () => {
    if (!pendingSwitchChoice) return;
    submitVote(pendingSwitchChoice);
  };

  return (
    <section
      aria-labelledby="arena-battle-title"
      className="relative animate-in fade-in duration-300"
    >
      <header className="mx-auto max-w-4xl px-2 text-center">
        <p className="scent-type-label text-scent-accent">ScentBeam Arena</p>
        <h1
          id="arena-battle-title"
          className="mt-3 text-pretty text-balance font-serif text-2xl leading-[1.05] text-foreground sm:text-4xl md:text-5xl"
        >
          {battle.title}
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-scent-text-muted sm:mt-4 sm:text-lg sm:leading-7">
          {battle.scenario}
        </p>
      </header>

      <div className="relative mx-auto mt-5 grid w-full max-w-4xl grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)] items-stretch gap-1.5 sm:mt-8 sm:grid-cols-[minmax(0,1fr)_2.75rem_minmax(0,1fr)] sm:gap-4 md:gap-5">
        <ArenaBattleSide
          side={battle.left}
          align="left"
          selected={selectedKey === battle.left.key}
          revealed={revealed}
          disabled={votePending}
          isSaving={votePending && selectedKey === battle.left.key}
          onVote={() => requestVote(battle.left.key)}
          onCompare={() => setCompareOpen(true)}
        />

        <div className="grid place-items-center">
          <div
            className="grid h-6 w-6 place-items-center rounded-full bg-black/88 text-[9px] font-bold tracking-[0.08em] text-scent-accent shadow-[0_0_0_1px_rgba(212,175,55,0.18),0_0_18px_rgba(212,175,55,0.14),inset_0_1px_0_rgba(255,255,255,0.08)] sm:sticky sm:top-[calc(var(--topbar-h)+1rem)] sm:h-11 sm:w-11 sm:text-sm sm:tracking-[0.12em]"
            aria-hidden="true"
          >
            VS
          </div>
        </div>

        <ArenaBattleSide
          side={battle.right}
          align="right"
          selected={selectedKey === battle.right.key}
          revealed={revealed}
          disabled={votePending}
          isSaving={votePending && selectedKey === battle.right.key}
          onVote={() => requestVote(battle.right.key)}
          onCompare={() => setCompareOpen(true)}
        />
      </div>

      <ArenaCompareDialog
        battle={battle}
        open={compareOpen}
        onOpenChange={setCompareOpen}
        onVote={(choice) => {
          setCompareOpen(false);
          requestVote(choice);
        }}
      />

      <AlertDialog
        open={Boolean(pendingSwitchSide)}
        onOpenChange={(open) => {
          if (!open) setPendingSwitchChoice(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100vw-2rem)] max-w-md rounded-lg border border-scent-accent/18 bg-[rgba(5,4,3,0.96)] p-0 text-foreground shadow-[0_28px_90px_-48px_rgba(212,175,55,0.34),inset_0_1px_0_rgba(255,236,183,0.08)]">
          <div className="p-5 sm:p-6">
            <AlertDialogHeader className="space-y-3 text-center">
              <p className="scent-type-label text-scent-accent">
                Switch your pick?
              </p>
              <AlertDialogTitle className="text-pretty text-xl font-bold leading-tight text-foreground sm:text-2xl">
                Confirm Contender{" "}
                {pendingSwitchChoice === battle.left.key ? "A" : "B"}
              </AlertDialogTitle>
              <AlertDialogDescription className="mx-auto max-w-sm text-sm font-medium leading-6 text-scent-text-muted">
                {currentPickSide && pendingSwitchSide
                  ? `Your current pick is ${currentPickSide.name}. Switch your saved vote to ${pendingSwitchSide.name}?`
                  : "Switch your saved vote to the other contender?"}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <AlertDialogFooter className="mt-6 grid grid-cols-2 gap-2 space-x-0 sm:grid-cols-2 sm:space-x-0">
              <AlertDialogCancel className="mt-0 min-h-11 rounded-md border border-scent-accent/16 bg-white/[0.035] px-3 py-2 text-xs font-bold uppercase tracking-[0.1em] text-scent-text-muted shadow-none transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:ring-scent-accent/55">
                Keep pick
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmPendingSwitch}
                className="min-h-11 rounded-md bg-scent-accent px-3 py-2 text-xs font-bold uppercase tracking-[0.1em] text-black shadow-[0_14px_30px_-24px_rgba(212,175,55,0.9)] transition-colors hover:bg-[#f0cf70] active:bg-[#d7ad32] focus-visible:ring-scent-accent/70"
              >
                Confirm switch
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {displayedErrorMessage ? (
        <p
          role="alert"
          className="mx-auto mt-4 max-w-2xl text-center text-sm text-red-100"
        >
          {displayedErrorMessage}
        </p>
      ) : null}

      <div ref={revealRef}>
        {revealed && localVote ? (
          <ArenaResultReveal
            battle={battle}
            viewerChoice={localVote}
            reason={reason}
            reasonDeclined={reasonDeclined}
            guestLocalOnly={guestLocalOnly}
            votePending={votePending}
            hasMoreBattles={hasMoreBattles}
            animateReveal={freshVote}
            onReasonChange={handleReasonChange}
            onReasonDeclinedChange={handleReasonDeclinedChange}
            onSignIn={onSignIn}
            onNext={onNext}
          />
        ) : (
          <p className="mx-auto mt-8 max-w-xl text-center text-sm leading-6 text-scent-text-subtle">
            Pick one side to reveal the current saved tally.
          </p>
        )}
      </div>
    </section>
  );
};
