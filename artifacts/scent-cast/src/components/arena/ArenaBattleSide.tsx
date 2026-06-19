import React, { useRef } from "react";
import { Check, LoaderCircle, Search, Sparkles } from "lucide-react";
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
  onVote: () => void;
  /** Open the pre-vote head-to-head compare detail for both contenders. */
  onCompare: () => void;
}

// Tap-vs-scroll isolation: a pointer that travels farther than this between
// down and up was a scroll/drag, not a tap, so we suppress activation. Mirrors
// NotePyramid's TAP_MOVE_TOLERANCE_PX (see isolate-touch-interaction-gestures).
const TAP_MOVE_TOLERANCE_PX = 10;

export const ArenaBattleSide: React.FC<ArenaBattleSideProps> = ({
  side,
  align,
  selected,
  revealed,
  disabled,
  isSaving = false,
  onVote,
  onCompare,
}) => {
  const contenderLabel = align === "left" ? "A" : "B";

  // Pre-vote: tapping the card opens the compare detail. Post-vote: tapping the
  // chosen card starts the change flow (the stage owns the confirm dialog).
  // Tapping the *other* card post-vote also routes through onVote (switch).
  const cardActivate = () => {
    if (disabled) return;
    if (revealed) {
      onVote();
    } else {
      onCompare();
    }
  };

  // Track pointer travel so a scroll doesn't register as a tap on touch.
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
    const distance = Math.hypot(
      event.clientX - start.x,
      event.clientY - start.y,
    );
    if (distance > TAP_MOVE_TOLERANCE_PX) start.moved = true;
  };

  const handlePointerCancel = () => {
    pointerStartRef.current = null;
  };

  const handleCardClick = (event: React.MouseEvent<HTMLElement>) => {
    // Buttons inside the card (Vote / Change) handle their own activation.
    if ((event.target as HTMLElement).closest("button")) return;
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    // Mouse clicks have no pointer record (or none that moved); only suppress
    // a touch/pen gesture that actually scrolled.
    if (start && start.moved) return;
    cardActivate();
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    // Let inner buttons own the keyboard activation.
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    cardActivate();
  };

  const cardAriaLabel = revealed
    ? selected
      ? `Your pick: ${side.name}. Tap to change.`
      : `Switch pick to ${side.name}`
    : `Compare ${side.name} head-to-head`;

  return (
    <article
      role="button"
      tabIndex={disabled ? undefined : 0}
      aria-label={cardAriaLabel}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerCancel={handlePointerCancel}
      style={{ touchAction: "pan-y" }}
      className={[
        "relative flex h-full min-w-0 overflow-hidden rounded-lg bg-[rgba(4,3,2,0.9)] p-2 shadow-[0_22px_50px_-40px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,236,183,0.08)] transition-all duration-200 hover:bg-[rgba(8,6,4,0.94)] hover:shadow-[0_34px_80px_-50px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,236,183,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/58 sm:p-3 md:p-4",
        disabled ? "" : "cursor-pointer",
        selected ? "bg-scent-accent/[0.022]" : "",
      ].join(" ")}
    >
      <div className="relative z-10 flex w-full flex-col">
        {/* Selected state: the gold top rail, the "your pick" check, and the
            card's rounded top edge fuse into ONE gold header — instead of a thin
            rail plus a separate floating badge. The gold cap is an absolute
            overlay anchored to this fixed-height header row (its negative insets
            reach the card's rounded corners, which the article's overflow-hidden
            clips), so the bottle below never shifts between picked/unpicked and
            the A/B cards stay aligned. Depth comes from inset + hairline shadows
            only — no projected gold glow pooling under the card. */}
        <div className="relative z-10 mb-1.5 flex min-h-5 items-center justify-center px-6 sm:mb-2.5 sm:min-h-6">
          {selected ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-2 -right-2 -top-2 bottom-0 z-0 bg-gradient-to-b from-scent-accent to-[#e7c45f] shadow-[inset_0_-1px_0_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,247,219,0.45)] transition-opacity duration-200 sm:-left-3 sm:-right-3 sm:-top-3 md:-left-4 md:-right-4 md:-top-4"
            />
          ) : null}
          {selected ? (
            <span className="relative z-10 inline-flex items-center gap-1.5 scent-type-label text-[10px] font-bold tracking-[0.18em] text-black sm:text-[12px] sm:tracking-[0.2em]">
              {isSaving ? (
                <LoaderCircle size={11} strokeWidth={2.6} className="animate-spin" aria-hidden="true" />
              ) : (
                <Check size={12} strokeWidth={3} aria-hidden="true" />
              )}
              Your Pick
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
          {/* Pre-vote affordance: make "tap to compare" discoverable without
              stealing the vote button. Hidden once a pick is locked in. */}
          {!revealed ? (
            <span
              className="pointer-events-none absolute bottom-1.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/64 px-2 py-0.5 text-[8px] font-bold uppercase leading-none tracking-[0.08em] text-scent-accent/85 shadow-[inset_0_0_0_1px_rgba(212,175,55,0.18)] backdrop-blur sm:bottom-2 sm:text-[9px]"
              aria-hidden="true"
            >
              <Search size={9} strokeWidth={2.2} aria-hidden="true" />
              Compare
            </span>
          ) : null}
        </div>

        <div className="mt-2.5 flex min-w-0 flex-col text-center sm:mt-3">
          {/* Equal-height brand row so a missing brand on one side doesn't
              shift its name/descriptor relative to the other card. */}
          <div className="flex min-h-[1.05rem] items-center justify-center sm:min-h-[1.4rem]">
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
          </div>
          {/* Name block: fixed two-line height so a 1-line and a 2-line name
              occupy identical vertical space across both contender cards. */}
          <div className="mt-1 flex min-h-[2.25rem] items-center justify-center sm:min-h-[3rem] md:min-h-[3.25rem]">
            <h2 className="line-clamp-2 text-pretty text-balance text-sm font-bold leading-tight text-foreground [overflow-wrap:anywhere] sm:text-xl md:text-2xl">
              {side.name}
            </h2>
          </div>
          <p className="mx-auto mt-1 line-clamp-2 min-h-[2rem] max-w-sm text-[11px] font-medium leading-4 text-scent-text-muted sm:mt-2 sm:min-h-[2.5rem] sm:text-sm sm:leading-5">
            {side.descriptor}
          </p>
        </div>

        {/* Pre-vote keeps the explicit Vote button. After reveal, the whole card
            remains the switch target so the compact battle layout is preserved. */}
        {!revealed ? (
          <button
            type="button"
            onClick={onVote}
            disabled={disabled}
            className="scent-no-mobile-focus-ring mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-scent-accent px-2 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-black shadow-[0_14px_30px_-24px_rgba(0,0,0,0.7)] transition-colors duration-300 hover:bg-[#f0cf70] active:bg-[#d7ad32] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60 sm:min-h-12 sm:gap-2 sm:px-5 sm:py-3 sm:text-sm sm:tracking-[0.16em]"
          >
            <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>{`Vote Contender ${contenderLabel}`}</span>
          </button>
        ) : null}
      </div>
    </article>
  );
};
