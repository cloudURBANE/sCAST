import React, { useEffect, useMemo, useState } from "react";
import { ArenaBattleSide } from "@/components/arena/ArenaBattleSide";
import { ArenaResultReveal } from "@/components/arena/ArenaResultReveal";
import type { ArenaBattle } from "@/components/arena/arenaBattleMapper";
import type { ArenaReasonKey } from "@/components/arena/arenaTwists";
import { useCommunityBattleVote } from "@/components/community/communityPosts";

interface ArenaBattleStageProps {
  battle: ArenaBattle;
  authToken: string | null;
  onSignIn: () => void;
  onNext: () => void;
  onGuestVoteQueued: (vote: { postId: string; choice: string }) => void;
  externalVotePending?: boolean;
  externalErrorMessage?: string | null;
}

export const ArenaBattleStage: React.FC<ArenaBattleStageProps> = ({
  battle,
  authToken,
  onSignIn,
  onNext,
  onGuestVoteQueued,
  externalVotePending = false,
  externalErrorMessage = null,
}) => {
  const voteMutation = useCommunityBattleVote(authToken);
  const [localVote, setLocalVote] = useState<string | null>(battle.viewerVote);
  const [reason, setReason] = useState<ArenaReasonKey | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setLocalVote(battle.viewerVote);
    setReason(null);
    setErrorMessage(null);
  }, [battle.id, battle.viewerVote]);

  const revealed = Boolean(localVote);
  const guestLocalOnly = Boolean(localVote && !authToken);
  const selectedKey = localVote;
  const votePending = voteMutation.isPending || externalVotePending;
  const displayedErrorMessage = errorMessage ?? externalErrorMessage;
  const sides = useMemo(
    () => [battle.left, battle.right],
    [battle.left, battle.right],
  );

  const submitVote = (choice: string) => {
    setLocalVote(choice);
    setErrorMessage(null);

    if (!authToken) {
      onGuestVoteQueued({ postId: battle.id, choice });
      return;
    }

    voteMutation.mutate(
      { postId: battle.id, choice },
      {
        onError: (err) => {
          setErrorMessage(
            err instanceof Error ? err.message : "Vote could not be saved.",
          );
        },
      },
    );
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

      <div className="relative mx-auto mt-6 grid w-full max-w-4xl grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] items-start gap-2 sm:mt-8 sm:grid-cols-[minmax(0,1fr)_2.75rem_minmax(0,1fr)] sm:gap-4 md:gap-5">
        <ArenaBattleSide
          side={battle.left}
          align="left"
          selected={selectedKey === battle.left.key}
          revealed={revealed}
          disabled={votePending}
          onVote={() => submitVote(battle.left.key)}
        />

        <div className="grid place-items-center">
          <div
            className="sticky top-[calc(var(--topbar-h)+1rem)] grid h-8 w-8 place-items-center rounded-full border border-scent-accent/42 bg-black/88 text-[11px] font-bold tracking-[0.12em] text-scent-accent shadow-[0_0_0_1px_rgba(0,0,0,0.6),0_0_22px_rgba(212,175,55,0.18),inset_0_1px_0_rgba(255,255,255,0.08)] sm:h-11 sm:w-11 sm:text-sm"
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
          onVote={() => submitVote(battle.right.key)}
        />
      </div>

      {displayedErrorMessage ? (
        <p
          role="alert"
          className="mx-auto mt-4 max-w-2xl text-center text-sm text-red-100"
        >
          {displayedErrorMessage}
        </p>
      ) : null}

      {revealed && localVote ? (
        <ArenaResultReveal
          battle={battle}
          viewerChoice={localVote}
          reason={reason}
          guestLocalOnly={guestLocalOnly}
          votePending={votePending}
          onReasonChange={setReason}
          onSignIn={onSignIn}
          onNext={onNext}
        />
      ) : (
        <p className="mx-auto mt-8 max-w-xl text-center text-sm leading-6 text-scent-text-subtle">
          Pick one side to reveal the current saved tally.
        </p>
      )}
    </section>
  );
};
