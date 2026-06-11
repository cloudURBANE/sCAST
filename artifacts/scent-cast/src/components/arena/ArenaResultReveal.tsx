import React from 'react';
import { ArrowRight, Share2 } from 'lucide-react';
import type { ArenaBattle } from '@/components/arena/arenaBattleMapper';
import type { ArenaReasonKey } from '@/components/arena/arenaTwists';
import { arenaPercentFor, arenaVoteTotal, buildArenaTwist } from '@/components/arena/arenaTwists';
import { ArenaReasonPicker } from '@/components/arena/ArenaReasonPicker';

interface ArenaResultRevealProps {
  battle: ArenaBattle;
  viewerChoice: string;
  reason: ArenaReasonKey | null;
  guestLocalOnly: boolean;
  votePending: boolean;
  onReasonChange: (reason: ArenaReasonKey) => void;
  onNext: () => void;
}

export const ArenaResultReveal: React.FC<ArenaResultRevealProps> = ({
  battle,
  viewerChoice,
  reason,
  guestLocalOnly,
  votePending,
  onReasonChange,
  onNext,
}) => {
  const twist = buildArenaTwist(battle, viewerChoice, reason);
  const total = arenaVoteTotal(battle);
  const pickedSide = viewerChoice === battle.left.key ? battle.left : battle.right;

  return (
    <section className="mx-auto mt-8 w-full max-w-5xl space-y-6" aria-live="polite">
      <div className="grid gap-3 rounded-[var(--radius-scent)] border border-scent-accent/22 bg-black/54 p-4 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] sm:grid-cols-3 sm:items-center sm:text-left">
        <div>
          <p className="scent-type-label text-scent-accent/82">Your pick</p>
          <p className="mt-1 truncate font-serif text-xl italic text-[#fff7ec]">{pickedSide.name}</p>
        </div>
        <div className="text-center">
          <p className="font-mono text-2xl text-scent-accent">
            {arenaPercentFor(battle, viewerChoice)}%
          </p>
          <p className="mt-1 scent-type-meta uppercase">{total} saved {total === 1 ? 'vote' : 'votes'}</p>
        </div>
        <div className="sm:text-right">
          <p className="scent-type-label text-scent-accent/82">Vote status</p>
          <p className="mt-1 text-sm font-medium leading-6 text-scent-text-muted">
            {guestLocalOnly
              ? 'Local reveal only. Sign in to save it.'
              : votePending
                ? 'Saving to the room tally.'
                : 'Saved to the room tally.'}
          </p>
        </div>
      </div>

      <ArenaReasonPicker value={reason} onChange={onReasonChange} />

      <div className="mx-auto max-w-3xl rounded-[var(--radius-scent)] border border-scent-accent/24 bg-[linear-gradient(180deg,rgba(255,247,236,0.045),rgba(0,0,0,0.52))] px-5 py-6 text-center">
        <p className="scent-type-label text-scent-accent">Twist</p>
        <h3 className="mt-2 font-serif text-2xl italic text-[#fff7ec]">{twist.title}</h3>
        <p className="mx-auto mt-3 max-w-2xl text-base leading-7 text-scent-text-muted">{twist.body}</p>
      </div>

      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        <button
          type="button"
          onClick={onNext}
          className="scent-primary-button inline-flex min-h-12 w-full max-w-xs items-center justify-center gap-2 rounded-[var(--radius-scent)] px-6 py-3 text-sm font-bold uppercase tracking-[0.16em] sm:w-auto"
        >
          <span>Next battle</span>
          <ArrowRight size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (navigator.share) {
              void navigator.share({
                title: battle.title,
                text: `${battle.left.name} vs ${battle.right.name}`,
                url: window.location.href,
              });
            }
          }}
          className="inline-flex min-h-12 w-full max-w-xs items-center justify-center gap-2 rounded-[var(--radius-scent)] border border-scent-accent/22 bg-black/50 px-6 py-3 text-sm font-bold uppercase tracking-[0.16em] text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 sm:w-auto"
        >
          <Share2 size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>Share</span>
        </button>
      </div>
    </section>
  );
};
