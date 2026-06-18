import React, { useState } from "react";
import { ArrowRight, Check, LockKeyhole, Share2 } from "lucide-react";
import type { ArenaBattle } from "@/components/arena/arenaBattleMapper";
import type { ArenaReasonKey } from "@/components/arena/arenaTwists";
import {
  ARENA_REASON_OPTIONS,
  arenaPercentFor,
  arenaVoteTotal,
} from "@/components/arena/arenaTwists";
import { ArenaReasonPicker } from "@/components/arena/ArenaReasonPicker";

interface ArenaResultRevealProps {
  battle: ArenaBattle;
  viewerChoice: string;
  reason: ArenaReasonKey | null;
  /** Persisted "skip reasons" choice for this battle (lifted to the stage). */
  reasonDeclined: boolean;
  guestLocalOnly: boolean;
  votePending: boolean;
  /** False when this is the only loaded battle, so "Next battle" has nowhere to go. */
  hasMoreBattles?: boolean;
  /** Play the entrance animation only for a fresh vote, not a restored state. */
  animateReveal: boolean;
  onReasonChange: (reason: ArenaReasonKey) => void;
  onReasonDeclinedChange: (declined: boolean) => void;
  onSignIn: () => void;
  onNext: () => void;
}

export const ArenaResultReveal: React.FC<ArenaResultRevealProps> = ({
  battle,
  viewerChoice,
  reason,
  reasonDeclined,
  guestLocalOnly,
  votePending,
  hasMoreBattles = true,
  animateReveal,
  onReasonChange,
  onReasonDeclinedChange,
  onSignIn,
  onNext,
}) => {
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
  const [editingReason, setEditingReason] = useState(false);
  const selectedReason = ARENA_REASON_OPTIONS.find(
    (option) => option.key === reason,
  );
  const showCheckpoint = Boolean(selectedReason) && !editingReason;
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
      className={[
        "mx-auto mt-4 w-full max-w-4xl space-y-3 sm:mt-8 sm:space-y-4",
        animateReveal
          ? "arena-reveal-stagger animate-in fade-in slide-in-from-bottom-4 duration-500"
          : "",
      ].join(" ")}
      aria-live="polite"
    >
      <div
        className={[
          "relative rounded-lg border border-scent-accent/18 bg-[rgba(5,4,3,0.86)] p-3 text-center shadow-[0_28px_80px_-56px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,236,183,0.08)] sm:p-6",
          guestLocalOnly ? "pt-12 sm:pt-14" : "",
        ].join(" ")}
        aria-label={`${pickedSide.name} is your pick at ${pickedPercent} percent. ${battle.left.name} has ${leftPercent} percent from ${leftCount} saved votes. ${battle.right.name} has ${rightPercent} percent from ${rightCount} saved votes. ${voteStatus}`}
      >
        {guestLocalOnly ? (
          <div
            className={[
              "absolute top-3 z-20 flex justify-start sm:top-4",
              showCheckpoint
                ? "left-3 max-w-[calc(60%-1rem)] sm:left-4"
                : "right-3 max-w-[calc(100%-1.5rem)] justify-end sm:right-4",
            ].join(" ")}
          >
            <div className="inline-flex min-h-8 items-center gap-2 rounded-full bg-black/54 px-2.5 py-1 text-left shadow-[inset_0_0_0_1px_rgba(212,175,55,0.14)] backdrop-blur">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-scent-accent/[0.12] text-scent-accent">
                <LockKeyhole size={12} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <span className="min-w-0 truncate text-[10px] font-semibold uppercase leading-none tracking-[0.08em] text-scent-text-muted sm:max-w-[15rem]">
                {voteStatus}
              </span>
              <button
                type="button"
                onClick={onSignIn}
                className="shrink-0 rounded-full bg-scent-accent/14 px-2 py-1 text-[10px] font-bold uppercase leading-none tracking-[0.08em] text-scent-accent transition-colors hover:bg-scent-accent/24 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
              >
                Save
              </button>
            </div>
          </div>
        ) : null}

        {/* Reason, condensed to a single gold check in the top-right corner —
            matching the contender card's pick check. Tapping it reopens the
            reason picker to change "why it won"; the label lives in aria only. */}
        {showCheckpoint && selectedReason ? (
          <button
            type="button"
            onClick={() => setEditingReason(true)}
            aria-label={`Why it won: ${selectedReason.label}. Tap to change reason.`}
            className="arena-badge-pop absolute right-2.5 top-2.5 z-20 inline-grid h-7 w-7 place-items-center rounded-full bg-scent-accent text-black shadow-[0_0_12px_rgba(212,175,55,0.22)] transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/60 sm:right-3 sm:top-3 sm:h-8 sm:w-8"
          >
            <Check size={14} strokeWidth={2.6} aria-hidden="true" />
          </button>
        ) : null}

        <div className="mx-auto max-w-2xl">
          <p className="scent-type-label text-scent-accent/82">Your pick</p>
          <div className="mt-1.5 grid justify-items-center gap-1 sm:mt-2 sm:gap-2">
            <h2 className="text-pretty text-xl font-bold leading-tight text-foreground sm:text-2xl md:text-3xl">
              {pickedSide.name}
            </h2>
            <p className="font-mono text-2xl leading-none text-scent-accent sm:text-3xl">
              {pickedPercent}%
            </p>
          </div>

          <div className="mt-3 sm:mt-5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 text-center text-[11px] font-bold uppercase leading-4 tracking-[0.1em] text-scent-text-muted sm:gap-3 sm:text-xs sm:tracking-[0.12em]">
              <span className="min-w-0 whitespace-normal">
                {battle.left.name}
              </span>
              <span className="shrink-0 text-scent-accent">
                {total} saved {total === 1 ? "vote" : "votes"}
              </span>
              <span className="min-w-0 whitespace-normal">
                {battle.right.name}
              </span>
            </div>
            <div
              className="mt-3 flex h-4 overflow-hidden rounded-full bg-scent-accent/8 shadow-[inset_0_0_0_1px_rgba(212,175,55,0.12)]"
              aria-hidden="true"
            >
              <span
                className={[
                  "block h-full rounded-l-full bg-gradient-to-r from-scent-accent/95 to-scent-accent/72",
                  animateReveal ? "arena-bar-segment" : "",
                ].join(" ")}
                style={{ width: `${leftShare}%` }}
              />
              <span
                className={[
                  "block h-full rounded-r-full bg-gradient-to-r from-scent-accent/30 to-scent-accent/48",
                  animateReveal ? "arena-bar-segment" : "",
                ].join(" ")}
                style={{ width: `${100 - leftShare}%` }}
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-center text-xs font-semibold leading-5 text-scent-text-muted">
              <span>
                {leftPercent}% - {leftCount}{" "}
                {leftCount === 1 ? "vote" : "votes"}
              </span>
              <span>
                {rightPercent}% - {rightCount}{" "}
                {rightCount === 1 ? "vote" : "votes"}
              </span>
            </div>
          </div>
        </div>

        {showCheckpoint ? null : (
          <div
            className={[
              "mt-4 border-t border-scent-accent/10 pt-4 sm:mt-5 sm:pt-5",
            ].join(" ")}
          >
            {reasonDeclined && !reason ? (
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                <p className="text-xs font-medium leading-5 text-scent-text-subtle">
                  Reason skipped — your vote still counts.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onReasonDeclinedChange(false);
                    setEditingReason(true);
                  }}
                  className="inline-flex min-h-8 items-center justify-center rounded-full bg-white/[0.035] px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50"
                >
                  Add a reason
                </button>
              </div>
            ) : (
              <>
                <ArenaReasonPicker
                  value={reason}
                  onChange={(next) => {
                    onReasonChange(next);
                    setEditingReason(false);
                  }}
                />
                {!reason ? (
                  <div className="mt-2 flex justify-center sm:mt-3">
                    <button
                      type="button"
                      onClick={() => onReasonDeclinedChange(true)}
                      className="inline-flex min-h-8 items-center justify-center rounded-full px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-scent-text-subtle transition-colors hover:text-scent-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40"
                    >
                      Skip reasons
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-center rounded-lg border border-scent-accent/14 bg-black/70 p-3 shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] sm:p-4">
        <div className="grid w-full max-w-md grid-cols-2 overflow-hidden rounded-lg bg-black/62 shadow-[inset_0_0_0_1px_rgba(212,175,55,0.14)] sm:min-w-[21rem]">
          <button
            type="button"
            disabled={!hasMoreBattles}
            aria-disabled={!hasMoreBattles}
            title={hasMoreBattles ? undefined : "This is the only battle right now."}
            onClick={(event) => {
              if (!hasMoreBattles) return;
              event.currentTarget.blur();
              onNext();
            }}
            className={[
              "scent-no-mobile-focus-ring inline-flex min-h-12 items-center justify-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-scent-accent/70 sm:text-sm sm:tracking-[0.16em]",
              hasMoreBattles
                ? "bg-scent-accent text-black hover:bg-[#f0cf70] active:bg-[#d7ad32]"
                : "cursor-not-allowed bg-scent-accent/24 text-black/55",
            ].join(" ")}
          >
            <span>{hasMoreBattles ? "Next battle" : "Only battle"}</span>
            <ArrowRight size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              void handleShare();
            }}
            className="inline-flex min-h-12 items-center justify-center gap-2 bg-white/[0.035] px-4 py-3 text-xs font-bold uppercase tracking-[0.12em] text-scent-text-muted transition-colors hover:bg-white/[0.07] hover:text-foreground active:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-scent-accent/55 sm:text-sm sm:tracking-[0.16em]"
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
