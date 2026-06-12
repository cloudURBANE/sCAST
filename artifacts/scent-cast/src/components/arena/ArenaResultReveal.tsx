import React, { useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  LoaderCircle,
  LockKeyhole,
  Share2,
} from "lucide-react";
import type { ArenaBattle } from "@/components/arena/arenaBattleMapper";
import type { ArenaReasonKey } from "@/components/arena/arenaTwists";
import {
  arenaPercentFor,
  arenaVoteTotal,
  buildArenaTwist,
} from "@/components/arena/arenaTwists";
import { ArenaReasonPicker } from "@/components/arena/ArenaReasonPicker";

interface ArenaResultRevealProps {
  battle: ArenaBattle;
  viewerChoice: string;
  reason: ArenaReasonKey | null;
  guestLocalOnly: boolean;
  votePending: boolean;
  onReasonChange: (reason: ArenaReasonKey) => void;
  onSignIn: () => void;
  onNext: () => void;
}

export const ArenaResultReveal: React.FC<ArenaResultRevealProps> = ({
  battle,
  viewerChoice,
  reason,
  guestLocalOnly,
  votePending,
  onReasonChange,
  onSignIn,
  onNext,
}) => {
  const twist = buildArenaTwist(battle, viewerChoice, reason);
  const total = arenaVoteTotal(battle);
  const leftCount = battle.votes[battle.left.key] ?? 0;
  const rightCount = battle.votes[battle.right.key] ?? 0;
  const leftPercent = arenaPercentFor(battle, battle.left.key);
  const rightPercent = arenaPercentFor(battle, battle.right.key);
  const leftShare = total > 0 ? (leftCount / total) * 100 : 50;
  const pickedSide =
    viewerChoice === battle.left.key ? battle.left : battle.right;
  const pickedPercent = arenaPercentFor(battle, viewerChoice);
  const [shareCopied, setShareCopied] = useState(false);
  const voteStatus = guestLocalOnly
    ? "Local reveal only. Sign in to save this pick."
    : votePending
      ? "Saving to the room tally."
      : "Saved to the room tally.";

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
      await navigator.clipboard.writeText(
        `${battle.title} - ${shareText} ${window.location.href}`,
      );
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1800);
    } catch {
      // Share cancellation or clipboard denial should not disrupt the reveal flow.
    }
  };

  return (
    <section
      className="arena-reveal-stagger mx-auto mt-6 w-full max-w-[1320px] space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 sm:mt-8"
      aria-live="polite"
    >
      <div
        className="rounded-[calc(var(--radius-scent)+6px)] border border-scent-accent/24 bg-[rgba(5,4,3,0.86)] p-4 shadow-[0_28px_80px_-56px_rgba(212,175,55,0.36),inset_0_1px_0_rgba(255,236,183,0.08)] sm:p-6"
        aria-label={`${pickedSide.name} is your pick at ${pickedPercent} percent. ${battle.left.name} has ${leftPercent} percent from ${leftCount} saved votes. ${battle.right.name} has ${rightPercent} percent from ${rightCount} saved votes. ${voteStatus}`}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(18rem,0.7fr)] lg:items-start">
          <div className="min-w-0">
            <p className="scent-type-label text-scent-accent/82">Your pick</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <h2 className="truncate font-serif text-2xl italic leading-tight text-foreground sm:text-4xl">
                  {pickedSide.name}
                </h2>
                <p className="mt-1 text-sm font-medium text-scent-text-muted">
                  {pickedPercent}% of {total} saved{" "}
                  {total === 1 ? "vote" : "votes"}
                </p>
              </div>
              <p className="font-mono text-3xl leading-none text-scent-accent sm:text-4xl">
                {pickedPercent}%
              </p>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between gap-3 text-xs font-bold uppercase tracking-[0.12em] text-scent-text-muted">
                <span className="min-w-0 truncate">{battle.left.name}</span>
                <span className="shrink-0 text-scent-accent">
                  {total} saved {total === 1 ? "vote" : "votes"}
                </span>
                <span className="min-w-0 truncate text-right">
                  {battle.right.name}
                </span>
              </div>
              <div
                className="mt-2 flex h-4 overflow-hidden rounded-full border border-scent-accent/14 bg-scent-accent/8"
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
              <div className="mt-2 grid grid-cols-2 gap-3 text-xs font-semibold text-scent-text-muted">
                <span>
                  {leftPercent}% - {leftCount}{" "}
                  {leftCount === 1 ? "vote" : "votes"}
                </span>
                <span className="text-right">
                  {rightPercent}% - {rightCount}{" "}
                  {rightCount === 1 ? "vote" : "votes"}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-[calc(var(--radius-scent)-2px)] border border-scent-accent/14 bg-black/42 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-scent-accent/24 bg-scent-accent/[0.09] text-scent-accent">
                {guestLocalOnly ? (
                  <LockKeyhole size={15} strokeWidth={1.9} aria-hidden="true" />
                ) : votePending ? (
                  <LoaderCircle
                    size={15}
                    strokeWidth={1.9}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <CheckCircle2
                    size={15}
                    strokeWidth={1.9}
                    aria-hidden="true"
                  />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="scent-type-label text-scent-accent/82">
                  Vote status
                </p>
                <p className="mt-1 text-sm font-medium leading-6 text-scent-text-muted">
                  {voteStatus}
                </p>
                {guestLocalOnly ? (
                  <button
                    type="button"
                    onClick={onSignIn}
                    className="mt-3 inline-flex min-h-9 items-center justify-center rounded-full border border-scent-accent/34 px-4 py-2 scent-type-chip text-scent-accent transition-colors hover:border-scent-accent/58 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
                  >
                    Save vote
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 border-t border-scent-accent/12 pt-5">
          <ArenaReasonPicker value={reason} onChange={onReasonChange} />
        </div>
      </div>

      <div className="rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/20 bg-black/70 p-4 shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] sm:p-5 lg:flex lg:items-center lg:justify-between lg:gap-6">
        <div key={reason ?? "default"} className="arena-fade-in min-w-0">
          <p className="scent-type-label text-scent-accent">{twist.title}</p>
          <p className="mt-1 line-clamp-2 text-sm font-medium leading-6 text-scent-text-muted sm:text-base sm:leading-7">
            {twist.body}
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row lg:mt-0 lg:shrink-0">
          <button
            type="button"
            onClick={(event) => {
              event.currentTarget.blur();
              onNext();
            }}
            className="scent-primary-button scent-no-mobile-focus-ring inline-flex min-h-12 w-full items-center justify-center gap-2 px-6 py-3 text-sm font-bold uppercase tracking-[0.16em] sm:w-auto"
          >
            <span>Next battle</span>
            <ArrowRight size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              void handleShare();
            }}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-scent)] border border-scent-accent/22 bg-black/68 px-6 py-3 text-sm font-bold uppercase tracking-[0.16em] text-scent-text-muted transition-all hover:border-scent-accent/42 hover:text-foreground active:scale-[0.98] active:border-scent-accent/52 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 sm:w-auto"
          >
            {shareCopied ? (
              <Check size={16} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <Share2 size={16} strokeWidth={1.8} aria-hidden="true" />
            )}
            <span>{shareCopied ? "Copied" : "Share"}</span>
          </button>
        </div>
      </div>
    </section>
  );
};
