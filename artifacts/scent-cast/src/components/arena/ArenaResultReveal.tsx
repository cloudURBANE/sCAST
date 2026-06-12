import React, { useState } from 'react';
import { ArrowRight, Check, Share2 } from 'lucide-react';
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
  const [shareCopied, setShareCopied] = useState(false);

  const handleShare = async () => {
    const shareText = `${battle.left.name} vs ${battle.right.name}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: battle.title,
          text: shareText,
          url: window.location.href,
        });
        return;
      }

      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(`${battle.title} - ${shareText} ${window.location.href}`);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1800);
    } catch {
      // Share cancellation or clipboard denial should not disrupt the reveal flow.
    }
  };

  return (
    <section className="arena-reveal-stagger mx-auto mt-8 w-full max-w-5xl space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500" aria-live="polite">
      <div className="grid gap-4 divide-y divide-scent-accent/12 rounded-[var(--radius-scent)] border border-scent-accent/22 bg-black/72 p-5 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] sm:grid-cols-3 sm:items-center sm:gap-6 sm:divide-x sm:divide-y-0 sm:p-6 sm:text-left">
        <div className="pt-4 first:pt-0 sm:pt-0 sm:first:pl-0 sm:pl-6">
          <p className="scent-type-label text-scent-accent/82">Your pick</p>
          <p className="mt-1 truncate font-serif text-xl italic text-foreground">{pickedSide.name}</p>
        </div>
        <div className="pt-4 text-center first:pt-0 sm:pt-0 sm:first:pl-0 sm:pl-6">
          <p className="font-mono text-2xl text-scent-accent">
            {arenaPercentFor(battle, viewerChoice)}%
          </p>
          <p className="mt-1 scent-type-meta uppercase">{total} saved {total === 1 ? 'vote' : 'votes'}</p>
        </div>
        <div className="pt-4 first:pt-0 sm:pt-0 sm:first:pl-0 sm:pl-6 sm:text-right">
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

      <div className="mx-auto max-w-3xl rounded-[var(--radius-scent)] border border-scent-accent/24 bg-black/68 px-5 py-6 text-center transition-all duration-300">
        <p className="scent-type-label text-scent-accent">Twist</p>
        <div key={reason ?? 'default'} className="arena-fade-in">
          <h3 className="mt-2 font-serif text-2xl italic text-foreground">{twist.title}</h3>
          <p className="mx-auto mt-3 max-w-2xl text-base leading-7 text-scent-text-muted">{twist.body}</p>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        <button
          type="button"
          onClick={onNext}
          className="scent-primary-button inline-flex min-h-12 w-full max-w-xs items-center justify-center gap-2 px-6 py-3 text-sm font-bold uppercase tracking-[0.16em] sm:w-auto"
        >
          <span>Next battle</span>
          <ArrowRight size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => {
            void handleShare();
          }}
          className="inline-flex min-h-12 w-full max-w-xs items-center justify-center gap-2 rounded-[var(--radius-scent)] border border-scent-accent/22 bg-black/68 px-6 py-3 text-sm font-bold uppercase tracking-[0.16em] text-scent-text-muted transition-all hover:border-scent-accent/42 hover:text-foreground active:scale-[0.98] active:border-scent-accent/52 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 sm:w-auto"
        >
          {shareCopied ? (
            <Check size={16} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <Share2 size={16} strokeWidth={1.8} aria-hidden="true" />
          )}
          <span>{shareCopied ? 'Copied' : 'Share'}</span>
        </button>
      </div>
    </section>
  );
};
