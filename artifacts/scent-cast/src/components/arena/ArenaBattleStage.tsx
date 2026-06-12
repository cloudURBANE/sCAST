import React, { useEffect, useMemo, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { ArenaBattleSide } from '@/components/arena/ArenaBattleSide';
import { ArenaResultReveal } from '@/components/arena/ArenaResultReveal';
import { ArenaVoteBar } from '@/components/arena/ArenaVoteBar';
import type { ArenaBattle } from '@/components/arena/arenaBattleMapper';
import type { ArenaReasonKey } from '@/components/arena/arenaTwists';
import { useCommunityBattleVote } from '@/components/community/communityPosts';

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
  const sides = useMemo(() => [battle.left, battle.right], [battle.left, battle.right]);

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
          setErrorMessage(err instanceof Error ? err.message : 'Vote could not be saved.');
        },
      },
    );
  };

  return (
    <section aria-labelledby="arena-battle-title" className="relative min-h-[62svh] animate-in fade-in duration-300">
      <header className="mx-auto max-w-4xl px-2 text-center">
        <p className="scent-type-label text-scent-accent">ScentBeam Arena</p>
        <h1 id="arena-battle-title" className="mt-3 text-pretty text-balance font-serif text-3xl italic leading-[0.98] text-foreground sm:text-4xl md:text-5xl lg:text-6xl">
          {battle.title}
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-scent-text-muted sm:text-lg">
          {battle.scenario}
        </p>
      </header>

      {revealed ? (
        <ArenaVoteBar battle={battle} guestLocalOnly={guestLocalOnly} votePending={votePending} />
      ) : null}

      <div className="relative mx-auto mt-8 grid w-full max-w-[1320px] gap-5 lg:grid-cols-[minmax(0,1fr)_4rem_minmax(0,1fr)] lg:items-stretch lg:gap-6">
        <ArenaBattleSide
          side={battle.left}
          align="left"
          selected={selectedKey === battle.left.key}
          revealed={revealed}
          disabled={votePending}
          onVote={() => submitVote(battle.left.key)}
        />

        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 hidden -translate-x-1/2 -translate-y-1/2 lg:block" aria-hidden="true">
          <div className="grid h-16 w-16 place-items-center rounded-full border border-scent-accent/48 bg-black/88 font-serif text-2xl italic text-scent-accent shadow-[0_0_0_1px_rgba(0,0,0,0.6),0_0_28px_rgba(212,175,55,0.22),inset_0_1px_0_rgba(255,255,255,0.08)]">
            VS
          </div>
        </div>
        <div className="grid h-14 place-items-center lg:relative lg:h-auto">
          <div className="grid h-14 w-14 place-items-center rounded-full border border-scent-accent/48 bg-black/88 font-serif text-xl italic text-scent-accent shadow-[0_0_0_1px_rgba(0,0,0,0.6),0_0_28px_rgba(212,175,55,0.22),inset_0_1px_0_rgba(255,255,255,0.08)] lg:hidden" aria-hidden="true">
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

      {votePending ? (
        <p className="mt-4 flex items-center justify-center gap-2 text-sm text-scent-text-muted" aria-live="polite">
          <LoaderCircle size={14} className="animate-spin text-scent-accent" aria-hidden="true" />
          Saving vote
        </p>
      ) : null}

      {guestLocalOnly ? (
        <div className="mx-auto mt-5 flex max-w-2xl flex-col items-center gap-3 rounded-[calc(var(--radius-scent)+4px)] border border-scent-accent/18 bg-black/68 px-4 py-4 text-center sm:flex-row sm:justify-between sm:text-left">
          <p className="text-sm font-medium leading-6 text-scent-text-muted">
            Guests can reveal instantly. This pick is not added to global totals unless you sign in.
          </p>
          <button
            type="button"
            onClick={onSignIn}
            className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-full border border-scent-accent/28 px-4 py-2 scent-type-chip text-scent-accent transition-colors hover:border-scent-accent/52 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
          >
            Save vote
          </button>
        </div>
      ) : null}

      {displayedErrorMessage ? (
        <p role="alert" className="mx-auto mt-4 max-w-2xl text-center text-sm text-red-100">
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
