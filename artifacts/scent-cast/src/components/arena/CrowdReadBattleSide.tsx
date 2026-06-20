import React, { useRef } from "react";
import { Check, Target } from "lucide-react";
import { BottleImage } from "@/components/BottleImage";
import { BrandGoldLabel } from "@/components/BrandGoldLabel";
import type { ArenaBattleSide as ArenaBattleSideData } from "@/components/arena/arenaBattleMapper";

// The marker treatment differs per phase of the read:
// - "bet": tap 1 (read the crowd) — a neutral "You bet" chip, an outline ring,
//   explicitly NOT the gold vote check used for a real pick.
// - "pick": tap 2 (your own pick) — the FAMILIAR gold vote treatment (the gold
//   header cap + Check tick), identical to ArenaBattleSide, because this is the
//   user's real own-pick vote.
export type CrowdReadMarker = "bet" | "pick";

interface CrowdReadBattleSideProps {
  side: ArenaBattleSideData;
  align: "left" | "right";
  /** This side is the locked bet (tap 1). Shows the neutral bet marker. */
  isBet: boolean;
  /** This side is the locked own-pick (tap 2). Shows the gold vote marker. */
  isPick: boolean;
  /** Which phase's tap this card currently accepts (drives label + handler). */
  marker: CrowdReadMarker;
  disabled: boolean;
  onSelect: () => void;
}

// Tap-vs-scroll isolation — mirrors ArenaBattleSide's TAP_MOVE_TOLERANCE_PX.
const TAP_MOVE_TOLERANCE_PX = 10;

export const CrowdReadBattleSide: React.FC<CrowdReadBattleSideProps> = ({
  side,
  align,
  isBet,
  isPick,
  marker,
  disabled,
  onSelect,
}) => {
  const contenderLabel = align === "left" ? "A" : "B";

  const pointerStartRef = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    pointerStartRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const start = pointerStartRef.current;
    if (!start || start.id !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > TAP_MOVE_TOLERANCE_PX) start.moved = true;
  };

  const handlePointerCancel = () => {
    pointerStartRef.current = null;
  };

  const activate = () => {
    if (disabled) return;
    onSelect();
  };

  const handleCardClick = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (start && start.moved) return;
    activate();
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    activate();
  };

  // The "selected" visual is split by intent: a bet draws a neutral outline +
  // chip; an own-pick draws the gold header cap (the real vote look).
  const cardAriaLabel = isPick
    ? `Your pick: ${side.name}`
    : isBet
      ? `You bet the crowd backs ${side.name}`
      : marker === "bet"
        ? `Bet that the crowd backs ${side.name}`
        : `Pick ${side.name} as the one you would wear`;

  return (
    <article
      role="button"
      tabIndex={disabled ? undefined : 0}
      aria-label={cardAriaLabel}
      aria-pressed={isBet || isPick}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerCancel={handlePointerCancel}
      style={{ touchAction: "pan-y" }}
      className={[
        "relative flex h-full min-w-0 overflow-hidden rounded-lg bg-[rgba(4,3,2,0.9)] p-2 shadow-[0_22px_50px_-40px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,236,183,0.08)] transition-all duration-200 hover:bg-[rgba(8,6,4,0.94)] hover:shadow-[0_34px_80px_-50px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,236,183,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/58 sm:p-3 md:p-4",
        disabled ? "" : "cursor-pointer",
        isPick ? "bg-scent-accent/[0.045]" : "",
        // Bet marker: a neutral inset ring — depth/identity without a gold cap or
        // any projected gold glow under the card.
        isBet
          ? "bg-white/[0.02] shadow-[0_22px_50px_-40px_rgba(0,0,0,0.8),inset_0_0_0_1.5px_rgba(212,175,55,0.55),inset_0_1px_0_rgba(255,236,183,0.1)]"
          : "",
      ].join(" ")}
    >
      <div className="relative z-10 flex w-full flex-col">
        {/* Header row: fixed height so picked/unpicked never shifts the bottle.
            For the own-pick (isPick) we reuse ArenaBattleSide's exact gold cap +
            "Your Pick" check. For the bet (isBet) we render a NEUTRAL chip, not
            a gold cap, so prediction never reads as a vote. */}
        <div className="relative z-10 mb-1.5 flex min-h-6 items-center justify-center px-6 sm:mb-2.5 sm:min-h-7">
          {isPick ? (
            <>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -left-2 -right-2 -top-2 bottom-0 z-0 bg-gradient-to-b from-scent-accent to-[#e7c45f] shadow-[inset_0_-1px_0_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,247,219,0.45)] transition-opacity duration-200 sm:-left-3 sm:-right-3 sm:-top-3 md:-left-4 md:-right-4 md:-top-4"
              />
              <span className="relative z-10 inline-flex items-center gap-1.5 scent-type-label text-[10px] font-bold tracking-[0.18em] text-black sm:text-[12px] sm:tracking-[0.2em]">
                <Check size={12} strokeWidth={3} aria-hidden="true" />
                Your Pick
              </span>
            </>
          ) : isBet ? (
            <span className="relative z-10 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-0.5 scent-type-label text-[10px] font-bold tracking-[0.14em] text-scent-accent shadow-[inset_0_0_0_1px_rgba(212,175,55,0.4)] sm:text-[12px] sm:tracking-[0.16em]">
              <Target size={11} strokeWidth={2.4} aria-hidden="true" />
              You bet
            </span>
          ) : (
            <span className="inline-flex items-center scent-type-label text-[10px] tracking-[0.1em] text-scent-accent/78 sm:text-[12px] sm:tracking-[0.14em]">
              {`Contender ${contenderLabel}`}
            </span>
          )}
        </div>

        <div className="relative aspect-[1/0.82] w-full overflow-hidden rounded-md bg-black/[0.18] shadow-[inset_0_0_0_1px_rgba(212,175,55,0.08)] sm:aspect-[1/0.88] md:aspect-[1/0.78] lg:aspect-[1/0.72]">
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

        <div className="mt-2.5 flex min-w-0 flex-col text-center sm:mt-3">
          <div className="flex min-h-[1.05rem] items-center justify-center sm:min-h-[1.4rem]">
            {side.brand ? (
              <BrandGoldLabel
                as="p"
                brand={side.brand}
                className="scent-card-brand scent-arena-brand mx-auto block max-w-full"
                shimmer={false}
              />
            ) : (
              <p className="scent-type-label text-scent-accent/70">Community option</p>
            )}
          </div>
          <div className="mt-1 flex min-h-[2.25rem] items-center justify-center sm:min-h-[3rem] md:min-h-[3.25rem]">
            <h2 className="line-clamp-2 text-pretty text-balance text-sm font-bold leading-tight text-foreground [overflow-wrap:anywhere] sm:text-xl md:text-2xl">
              {side.name}
            </h2>
          </div>
          <p className="mx-auto mt-1 line-clamp-2 min-h-[2rem] max-w-sm text-[11px] font-medium leading-4 text-scent-text-muted sm:mt-2 sm:min-h-[2.5rem] sm:text-sm sm:leading-5">
            {side.descriptor}
          </p>
        </div>

        {/* Explicit action button mirrors ArenaBattleSide's vote CTA, but the
            verb changes with the phase. Hidden once this side is locked. */}
        {!isBet && !isPick ? (
          <button
            type="button"
            onClick={onSelect}
            disabled={disabled}
            className={
              marker === "bet"
                ? "scent-no-mobile-focus-ring mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md border border-scent-accent/45 bg-black/40 px-2 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-scent-accent shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] transition-colors duration-300 hover:border-scent-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60 sm:min-h-12 sm:gap-2 sm:px-5 sm:py-3 sm:text-sm sm:tracking-[0.16em]"
                : "scent-no-mobile-focus-ring mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-scent-accent px-2 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-black shadow-[0_14px_30px_-24px_rgba(0,0,0,0.7)] transition-colors duration-300 hover:bg-[#f0cf70] active:bg-[#d7ad32] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60 sm:min-h-12 sm:gap-2 sm:px-5 sm:py-3 sm:text-sm sm:tracking-[0.16em]"
            }
          >
            {marker === "bet" ? (
              <Target size={16} strokeWidth={1.9} aria-hidden="true" />
            ) : (
              <Check size={16} strokeWidth={1.9} aria-hidden="true" />
            )}
            <span>
              {marker === "bet"
                ? `Bet ${contenderLabel}`
                : `Pick ${contenderLabel}`}
            </span>
          </button>
        ) : null}
      </div>
    </article>
  );
};
