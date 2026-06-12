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
        "relative min-w-0 overflow-hidden rounded-lg border bg-[rgba(4,3,2,0.9)] p-2 shadow-[0_22px_58px_-44px_rgba(212,175,55,0.3),inset_0_1px_0_rgba(255,236,183,0.08)] transition-all duration-200 hover:border-scent-accent/48 hover:shadow-[0_34px_88px_-52px_rgba(212,175,55,0.38),inset_0_1px_0_rgba(255,236,183,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 sm:p-3 md:p-4",
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
      {selected ? (
        <span className="arena-badge-pop absolute right-0 top-0 z-20 inline-flex min-h-7 items-center gap-1 rounded-bl-lg border-b border-l border-scent-accent/42 bg-scent-accent px-2 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-black shadow-[0_0_14px_rgba(212,175,55,0.18)] sm:min-h-8 sm:gap-1.5 sm:px-2.5 sm:text-[11px] sm:tracking-[0.1em]">
          <Check size={12} strokeWidth={2} aria-hidden="true" />
          <span className="hidden min-[390px]:inline">Your pick</span>
          <span className="min-[390px]:hidden">Pick</span>
        </span>
      ) : null}

      <div className="relative z-10 flex flex-col">
        <div className="mb-2 flex min-h-7 items-center justify-start pr-14 sm:mb-3 sm:pr-24">
          <span className="scent-type-label text-[10px] tracking-[0.1em] text-scent-accent/78 sm:text-[12px] sm:tracking-[0.14em]">
            {align === "left" ? "Option A" : "Option B"}
          </span>
        </div>

        <div className="relative aspect-[4/5] w-full overflow-hidden rounded-md border border-scent-accent/10 bg-black/[0.18]">
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
            loading={align === "left" ? "eager" : "lazy"}
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
          <h2 className="mt-1 line-clamp-2 text-pretty text-balance text-sm font-bold leading-tight text-foreground sm:text-xl md:text-2xl">
            {side.name}
          </h2>
          <p className="mx-auto mt-1.5 line-clamp-2 max-w-sm text-[11px] font-medium leading-4 text-scent-text-muted sm:mt-2 sm:text-sm sm:leading-5">
            {side.descriptor}
          </p>
        </div>

        {!revealed ? (
          <button
            type="button"
            onClick={onVote}
            disabled={disabled}
            className="scent-primary-button scent-no-mobile-focus-ring mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[11px] font-bold uppercase tracking-[0.1em] transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60 sm:min-h-12 sm:gap-2 sm:px-5 sm:py-3 sm:text-sm sm:tracking-[0.16em]"
          >
            <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>{`Vote ${align === "left" ? "A" : "B"}`}</span>
          </button>
        ) : null}
      </div>
    </article>
  );
};
