import React, { useEffect, useState } from "react";
import { Check, LoaderCircle, Sparkles } from "lucide-react";
import { BottleImage } from "@/components/BottleImage";
import { BrandGoldLabel } from "@/components/BrandGoldLabel";
import type { ArenaBattleSide as ArenaBattleSideData } from "@/components/arena/arenaBattleMapper";

interface ArenaBattleSideProps {
  side: ArenaBattleSideData;
  align: "left" | "right";
  selected: boolean;
  revealed: boolean;
  disabled: boolean;
  /** True while this card's vote is being persisted to the room tally. */
  isSaving?: boolean;
  /**
   * True only for the side the viewer just picked *this mount*. Gates the
   * one-shot "Saving → Saved to tally" badge animation so a restored pick shows
   * the settled checkmark immediately instead of replaying the animation.
   */
  justVoted?: boolean;
  onVote: () => void;
}

export const ArenaBattleSide: React.FC<ArenaBattleSideProps> = ({
  side,
  align,
  selected,
  revealed,
  disabled,
  isSaving = false,
  justVoted = false,
  onVote,
}) => {
  // Inline tally feedback: show the status text immediately on a fresh pick, then
  // collapse it away once the save settles so only the checkmark remains. A pick
  // restored on revisit skips this entirely (justVoted is false).
  const [showTallyText, setShowTallyText] = useState(false);

  useEffect(() => {
    if (!selected || !justVoted) {
      setShowTallyText(false);
      return;
    }
    setShowTallyText(true);
    if (isSaving) return;
    const timer = window.setTimeout(() => setShowTallyText(false), 1800);
    return () => window.clearTimeout(timer);
  }, [selected, isSaving, justVoted]);

  const contenderLabel = align === "left" ? "A" : "B";
  // While the "Saving / Saved to tally" badge is animating we swap it in for the
  // centered "Contender" label so the two never collide. Once the save settles
  // and the badge collapses, the label — now carrying a persistent checkmark for
  // the chosen side — fades back in cleanly.
  const badgeActive = selected && justVoted && (isSaving || showTallyText);

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!revealed || disabled) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onVote();
  };

  return (
    <article
      role={revealed ? "button" : undefined}
      tabIndex={revealed && !disabled ? 0 : undefined}
      aria-label={
        revealed
          ? `${selected ? "Current pick" : "Switch pick to"} ${side.name}`
          : undefined
      }
      onClick={revealed && !disabled ? onVote : undefined}
      onKeyDown={handleCardKeyDown}
      className={[
        "relative flex h-full min-w-0 overflow-hidden rounded-lg bg-[rgba(4,3,2,0.9)] p-2 shadow-[0_22px_58px_-44px_rgba(212,175,55,0.26),inset_0_1px_0_rgba(255,236,183,0.08)] transition-all duration-200 hover:bg-[rgba(8,6,4,0.94)] hover:shadow-[0_34px_88px_-52px_rgba(212,175,55,0.32),inset_0_1px_0_rgba(255,236,183,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/58 sm:p-3 md:p-4",
        revealed && !disabled ? "cursor-pointer" : "",
        selected ? "bg-scent-accent/[0.045]" : "",
      ].join(" ")}
    >
      <div
        className={[
          "pointer-events-none absolute inset-x-0 top-0 h-1 bg-scent-accent transition-opacity",
          selected ? "opacity-80" : "opacity-0",
        ].join(" ")}
        aria-hidden="true"
      />
      <div className="relative z-10 flex w-full flex-col">
        <div className="relative mb-2 flex min-h-7 items-center justify-center sm:mb-3">
          <span
            className={[
              "inline-flex items-center scent-type-label text-[10px] tracking-[0.1em] text-scent-accent/78 transition-opacity duration-300 sm:text-[12px] sm:tracking-[0.14em]",
              badgeActive ? "opacity-0" : "opacity-100",
            ].join(" ")}
          >
            {`Contender ${contenderLabel}`}
            {selected ? <span className="sr-only">your pick</span> : null}
          </span>
          {/* Durable pick marker, pinned away from the centered contender label. */}
          {selected && !badgeActive ? (
            <span
              className="absolute right-0 top-1/2 inline-grid h-4 w-4 -translate-y-1/2 place-items-center rounded-full bg-scent-accent text-black shadow-[0_0_10px_rgba(212,175,55,0.28)] sm:h-[1.05rem] sm:w-[1.05rem]"
              aria-hidden="true"
            >
              <Check size={10} strokeWidth={2.6} aria-hidden="true" />
            </span>
          ) : null}
          {/* One-shot "Saving → Saved to tally" badge: only mounts for a fresh
              vote, and cross-fades over the label so the two never collide. */}
          {selected && justVoted ? (
            <span
              className={[
                "absolute left-1/2 top-1/2 inline-flex min-h-6 -translate-x-1/2 -translate-y-1/2 items-center rounded-full bg-scent-accent px-1.5 py-1 text-[8px] font-bold uppercase tracking-[0.06em] text-black shadow-[0_0_14px_rgba(212,175,55,0.16)] transition-opacity duration-300 sm:min-h-7 sm:px-2.5 sm:text-[10px] sm:tracking-[0.1em]",
                badgeActive
                  ? "arena-badge-pop opacity-100"
                  : "pointer-events-none opacity-0",
              ].join(" ")}
              aria-hidden={!badgeActive}
            >
              {isSaving ? (
                <LoaderCircle
                  size={11}
                  strokeWidth={2}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Check size={11} strokeWidth={2} aria-hidden="true" />
              )}
              <span
                className={[
                  "inline-block overflow-hidden whitespace-nowrap transition-all duration-500",
                  showTallyText
                    ? "ml-1 max-w-[8rem] opacity-100 sm:ml-1.5"
                    : "ml-0 max-w-0 opacity-0",
                ].join(" ")}
              >
                {isSaving ? "Saving to tally" : "Saved to tally"}
              </span>
            </span>
          ) : null}
        </div>

        <div className="relative aspect-[1/1.08] w-full overflow-hidden rounded-md bg-black/[0.18] shadow-[inset_0_0_0_1px_rgba(212,175,55,0.08)] sm:aspect-[4/5]">
          <div
            className="absolute inset-x-3 bottom-5 h-px bg-gradient-to-r from-transparent via-scent-accent/28 to-transparent sm:inset-x-6 sm:bottom-7"
            aria-hidden="true"
          />
          <BottleImage
            src={side.imageUrl}
            alt={`${side.name}${side.brand ? ` by ${side.brand}` : ""}`}
            variant="card"
            className="absolute inset-2.5 sm:inset-4"
            imgClassName="brightness-[1.08] drop-shadow-[0_22px_28px_rgba(0,0,0,0.62)]"
            loading="eager"
            fetchPriority={align === "left" ? "high" : "auto"}
          />
        </div>

        <div className="mt-2.5 min-w-0 text-center sm:mt-3">
          {side.brand ? (
            <BrandGoldLabel
              as="p"
              brand={side.brand}
              className="scent-card-brand scent-arena-brand mx-auto block max-w-full"
              shimmer={false}
            />
          ) : (
            <p className="scent-type-label text-scent-accent/70">
              Community option
            </p>
          )}
          <div className="mt-1 flex min-h-[2.5rem] items-center justify-center sm:min-h-[3.75rem]">
            <h2 className="line-clamp-2 text-pretty text-balance text-sm font-bold leading-tight text-foreground sm:text-xl md:text-2xl">
              {side.name}
            </h2>
          </div>
          <p className="mx-auto mt-1.5 line-clamp-2 min-h-[2rem] max-w-sm text-[11px] font-medium leading-4 text-scent-text-muted sm:mt-2 sm:min-h-[2.5rem] sm:text-sm sm:leading-5">
            {side.descriptor}
          </p>
        </div>

        {!revealed ? (
          <button
            type="button"
            onClick={onVote}
            disabled={disabled}
            className="scent-no-mobile-focus-ring mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-scent-accent px-2 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-black shadow-[0_14px_30px_-24px_rgba(212,175,55,0.9)] transition-colors duration-300 hover:bg-[#f0cf70] active:bg-[#d7ad32] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60 sm:min-h-12 sm:gap-2 sm:px-5 sm:py-3 sm:text-sm sm:tracking-[0.16em]"
          >
            <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>{`Vote Contender ${contenderLabel}`}</span>
          </button>
        ) : null}
      </div>
    </article>
  );
};
