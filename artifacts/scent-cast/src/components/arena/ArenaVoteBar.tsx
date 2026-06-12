import React from 'react';
import type { ArenaBattle } from '@/components/arena/arenaBattleMapper';
import { arenaPercentFor, arenaVoteTotal } from '@/components/arena/arenaTwists';

interface ArenaVoteBarProps {
  battle: ArenaBattle;
  guestLocalOnly: boolean;
  votePending: boolean;
}

export const ArenaVoteBar: React.FC<ArenaVoteBarProps> = ({
  battle,
  guestLocalOnly,
  votePending,
}) => {
  const leftCount = battle.votes[battle.left.key] ?? 0;
  const rightCount = battle.votes[battle.right.key] ?? 0;
  const total = arenaVoteTotal(battle);
  const leftPercent = arenaPercentFor(battle, battle.left.key);
  const rightPercent = arenaPercentFor(battle, battle.right.key);
  const leftShare = total > 0 ? (leftCount / total) * 100 : 50;
  const voteStatus = guestLocalOnly
    ? 'Local reveal only.'
    : votePending
      ? 'Saving to the room tally.'
      : 'Saved to the room tally.';

  return (
    <div
      className="arena-fade-in mx-auto mt-7 w-full max-w-[1320px] rounded-[calc(var(--radius-scent)+4px)] border border-scent-accent/18 bg-black/68 p-4 shadow-[inset_0_1px_0_rgba(255,236,183,0.06),0_18px_42px_-32px_rgba(0,0,0,0.88)] sm:p-5"
      aria-label={`${battle.left.name} has ${leftPercent}% from ${leftCount} saved votes; ${battle.right.name} has ${rightPercent}% from ${rightCount} saved votes. ${voteStatus}`}
    >
      <div className="grid gap-3 text-center sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end sm:text-left">
        <div className="min-w-0">
          <p className="truncate font-serif text-2xl italic text-foreground sm:text-3xl">{leftPercent}%</p>
          <p className="mt-1 scent-type-meta uppercase text-scent-text-muted">
            {leftCount} {leftCount === 1 ? 'vote' : 'votes'} for {battle.left.name}
          </p>
        </div>
        <p className="scent-type-label text-scent-accent/82 sm:px-4">{voteStatus}</p>
        <div className="min-w-0 sm:text-right">
          <p className="truncate font-serif text-2xl italic text-foreground sm:text-3xl">{rightPercent}%</p>
          <p className="mt-1 scent-type-meta uppercase text-scent-text-muted">
            {rightCount} {rightCount === 1 ? 'vote' : 'votes'} for {battle.right.name}
          </p>
        </div>
      </div>
      <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-scent-accent/10" aria-hidden="true">
        <span
          className="arena-bar-segment block h-full rounded-l-full bg-scent-accent/85"
          style={{ width: `${leftShare}%` }}
        />
        <span
          className="arena-bar-segment block h-full rounded-r-full bg-scent-accent/32"
          style={{ width: `${100 - leftShare}%` }}
        />
      </div>
    </div>
  );
};
