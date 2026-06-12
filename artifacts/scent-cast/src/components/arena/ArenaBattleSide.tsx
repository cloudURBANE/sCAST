import React from "react";
import { Check, Sparkles } from "lucide-react";
import { BottleImage } from "@/components/BottleImage";
import { BrandGoldLabel } from "@/components/BrandGoldLabel";
import type { ArenaBattleSide as ArenaBattleSideData } from "@/components/arena/arenaBattleMapper";

interface ArenaBattleSideProps {
  side: ArenaBattleSideData;
  align: "left" | "right";
  selected: boolean;
  revealed: boolean;
  disabled: boolean;
  onVote: () => void;
}

export const ArenaBattleSide: React.FC<ArenaBattleSideProps> = ({
  side,
  align,
  selected,
  revealed,
  disabled,
  onVote,
}) => {
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
        "relative min-w-0 overflow-hidden rounded-[calc(var(--radius-scent)-4px)] border bg-[rgba(4,3,2,0.9)] p-2.5 shadow-[0_22px_58px_-44px_rgba(212,175,55,0.3),inset_0_1px_0_rgba(255,236,183,0.08)] transition-all duration-200 hover:border-scent-accent/48 hover:shadow-[0_34px_88px_-52px_rgba(212,175,55,0.38),inset_0_1px_0_rgba(255,236,183,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 sm:rounded-[calc(var(--radius-scent)+2px)] sm:p-4 lg:rounded-[calc(var(--radius-scent)+8px)] lg:p-6",
        revealed && !disabled ? "cursor-pointer" : "",
        selected ? "border-scent-accent/62" : "border-scent-accent/26",
      ].join(" ")}
    >
      <div
        className={[
          "pointer-events-none absolute inset-x-0 top-0 h-1 bg-scent-accent transition-opacity",
          selected ? "opacity-80" : "opacity-0",
        ].join(" ")}
        aria-hidden="true"
      />
      <div className="relative z-10 flex min-h-[clamp(18rem,46svh,26rem)] flex-col sm:min-h-[clamp(24rem,45svh,34rem)]">
        <div className="mb-2 flex items-center justify-between gap-2 sm:mb-4 sm:gap-4">
          <span className="scent-type-label text-[10px] tracking-[0.1em] text-scent-accent/78 sm:text-[13px] sm:tracking-[0.14em]">
            {align === "left" ? "Option A" : "Option B"}
          </span>
          {selected ? (
            <span className="arena-badge-pop inline-flex items-center gap-1 rounded-full border border-scent-accent/34 bg-scent-accent/[0.1] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-scent-accent shadow-[0_0_12px_rgba(212,175,55,0.15)] sm:gap-1.5 sm:px-2.5 sm:py-1 sm:text-[13px] sm:tracking-[0.1em]">
              <Check size={12} strokeWidth={2} aria-hidden="true" />
              <span className="hidden min-[390px]:inline">Your pick</span>
              <span className="min-[390px]:hidden">Pick</span>
            </span>
          ) : null}
        </div>

        <div className="relative flex flex-1 min-h-[9.75rem] items-end justify-center overflow-hidden rounded-[calc(var(--radius-scent)-10px)] border border-scent-accent/10 bg-black/[0.18] sm:min-h-[15rem] sm:rounded-[calc(var(--radius-scent)-6px)]">
          <div
            className="absolute inset-x-4 bottom-5 h-px bg-gradient-to-r from-transparent via-scent-accent/28 to-transparent sm:inset-x-8 sm:bottom-8"
            aria-hidden="true"
          />
          <BottleImage
            src={side.imageUrl}
            alt={`${side.name}${side.brand ? ` by ${side.brand}` : ""}`}
            variant="card"
            className="absolute inset-3 sm:inset-6 lg:inset-7"
            imgClassName="brightness-[1.08] drop-shadow-[0_22px_28px_rgba(0,0,0,0.62)]"
            loading={align === "left" ? "eager" : "lazy"}
            fetchPriority={align === "left" ? "high" : "auto"}
          />
        </div>

        <div className="mt-3 min-w-0 text-center sm:mt-5">
          {side.brand ? (
            <BrandGoldLabel
              as="p"
              brand={side.brand}
              className="scent-card-brand scent-arena-brand mx-auto block max-w-full"
            />
          ) : (
            <p className="scent-type-label text-scent-accent/70">
              Community option
            </p>
          )}
          <h2 className="mt-1 line-clamp-2 text-pretty text-balance font-serif text-xl italic leading-[1.04] text-foreground sm:mt-2 sm:text-4xl">
            {side.name}
          </h2>
          <p className="mx-auto mt-2 line-clamp-2 max-w-sm text-[12px] font-medium leading-5 text-scent-text-muted sm:mt-3 sm:text-sm sm:leading-6">
            {side.descriptor}
          </p>
        </div>

        {!revealed ? (
          <button
            type="button"
            onClick={onVote}
            disabled={disabled}
            className="scent-primary-button scent-no-mobile-focus-ring mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[calc(var(--radius-scent)-6px)] px-2 py-2 text-[11px] font-bold uppercase tracking-[0.1em] transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60 sm:mt-5 sm:min-h-14 sm:gap-2 sm:rounded-[var(--radius-scent)] sm:px-5 sm:py-3 sm:text-sm sm:tracking-[0.16em]"
          >
            <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>{`Vote ${align === "left" ? "A" : "B"}`}</span>
          </button>
        ) : null}
      </div>
    </article>
  );
};
