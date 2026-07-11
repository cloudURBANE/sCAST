import React from "react";
import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BottleImage } from "@/components/BottleImage";
import { BrandGoldLabel } from "@/components/BrandGoldLabel";
import type {
  ArenaBattle,
  ArenaBattleSide,
} from "@/components/arena/arenaBattleMapper";

interface ArenaCompareDialogProps {
  battle: ArenaBattle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Cast a vote for a contender straight from the compare view. */
  onVote: (choice: string) => void;
}

const normalize = (value?: string): string =>
  (value ?? "").trim().toLowerCase();

/**
 * Pre-vote head-to-head detail. The Arena battle object carries only real,
 * server-mapped attributes per contender — name, brand, image, and a single
 * descriptor (the fragrance family, or a fallback string). There is no scent
 * vector / accord / note data on a battle side, so this view deliberately does
 * NOT borrow BeamCard's radar/axis-bars: it presents the attributes that truly
 * exist and surfaces the real point of difference (same vs different house,
 * same vs different family) instead of inventing scores.
 */
export const ArenaCompareDialog: React.FC<ArenaCompareDialogProps> = ({
  battle,
  open,
  onOpenChange,
  onVote,
}) => {
  const { left, right } = battle;

  const sameBrand =
    Boolean(left.brand && right.brand) &&
    normalize(left.brand) === normalize(right.brand);
  // Treat the generic fallback descriptors as "no family stated" so we don't
  // claim two contenders "share a family" when neither actually has one.
  const leftFamily =
    left.descriptor && left.descriptor !== "Community option"
      ? left.descriptor
      : null;
  const rightFamily =
    right.descriptor && right.descriptor !== "Community option"
      ? right.descriptor
      : null;
  const sameFamily =
    Boolean(leftFamily && rightFamily) &&
    normalize(leftFamily ?? "") === normalize(rightFamily ?? "");

  const differenceLine = (() => {
    if (sameBrand && sameFamily)
      return "Same house, same family — this one's about the details.";
    if (sameBrand) return "Same house, different character.";
    if (sameFamily) return "Different houses, same scent family.";
    if (leftFamily && rightFamily) return "Two distinct houses and families.";
    return "Two contenders — pick the one you'd wear.";
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-2xl gap-0 overflow-x-hidden overflow-y-auto rounded-lg border border-scent-accent/18 bg-[rgba(5,4,3,0.97)] p-0 text-foreground shadow-[0_28px_90px_-48px_rgba(0,0,0,0.9),inset_0_1px_0_rgba(255,236,183,0.08)]">
        <div className="p-4 sm:p-6">
          <DialogHeader className="space-y-2 text-center">
            <p className="scent-type-label text-scent-accent">Head to head</p>
            <DialogTitle className="text-pretty text-balance text-lg font-bold leading-tight text-foreground sm:text-2xl">
              {battle.title}
            </DialogTitle>
            <DialogDescription className="mx-auto max-w-md text-xs font-medium leading-5 text-scent-text-muted sm:text-sm sm:leading-6">
              {differenceLine}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)] items-stretch gap-1.5 sm:mt-6 sm:grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)] sm:gap-3">
            <CompareColumn
              side={left}
              label="A"
              family={leftFamily}
              familyShared={sameFamily}
              brandShared={sameBrand}
              onVote={() => onVote(left.key)}
            />

            <div className="grid place-items-center">
              <span
                className="grid h-7 w-7 place-items-center rounded-full bg-black/85 text-[9px] font-bold tracking-[0.08em] text-scent-accent shadow-[0_0_0_1px_rgba(212,175,55,0.18),inset_0_1px_0_rgba(255,255,255,0.08)] sm:h-9 sm:w-9 sm:text-xs"
                aria-hidden="true"
              >
                VS
              </span>
            </div>

            <CompareColumn
              side={right}
              label="B"
              family={rightFamily}
              familyShared={sameFamily}
              brandShared={sameBrand}
              onVote={() => onVote(right.key)}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

function CompareColumn({
  side,
  label,
  family,
  familyShared,
  brandShared,
  onVote,
}: {
  side: ArenaBattleSide;
  label: "A" | "B";
  family: string | null;
  /** The two contenders share this family — flag it as common ground. */
  familyShared: boolean;
  /** The two contenders share a house — flag it as common ground. */
  brandShared: boolean;
  onVote: () => void;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col rounded-lg bg-[rgba(4,3,2,0.9)] p-2.5 shadow-[inset_0_0_0_1px_rgba(212,175,55,0.08)] sm:p-3.5">
      <p className="scent-type-label text-center text-[10px] tracking-[0.1em] text-scent-accent/78 sm:text-[12px] sm:tracking-[0.14em]">
        {`Contender ${label}`}
      </p>

      <div className="relative mt-2 aspect-[4/5] w-full overflow-hidden rounded-md bg-black/[0.18]">
        <BottleImage
          src={side.imageUrl}
          alt={`${side.name}${side.brand ? ` by ${side.brand}` : ""}`}
          variant="card"
          className="absolute inset-3"
          imgClassName="brightness-[1.08] drop-shadow-[0_18px_24px_rgba(0,0,0,0.6)]"
        />
      </div>

      {/* flex-1 + the two-line phone brand slot keep both columns' House/Family
          rows and Vote buttons level when one brand wraps and the other doesn't
          (same alignment contract as ArenaBattleSide). */}
      <div className="mt-2.5 flex min-w-0 flex-1 flex-col text-center">
        <div className="flex min-h-[1.5rem] items-center justify-center sm:min-h-[1.4rem]">
          {side.brand ? (
            <BrandGoldLabel
              as="p"
              brand={side.brand}
              className="scent-card-brand scent-arena-brand mx-auto block max-w-full line-clamp-2"
              shimmer={false}
            />
          ) : (
            <p className="scent-type-label text-scent-accent/70">
              Community option
            </p>
          )}
        </div>
        <div className="mt-1 flex min-h-[2.5rem] items-center justify-center">
          <h3 className="line-clamp-2 text-pretty text-balance text-sm font-bold leading-tight text-foreground [overflow-wrap:anywhere] sm:text-base">
            {side.name}
          </h3>
        </div>
      </div>

      {/* Real attributes only. The "family" row is the genuine difference axis
          available on a battle side; shared values are tagged as common ground
          so the head-to-head reads honestly even with thin data. */}
      <dl className="mt-2 flex flex-col gap-1.5 border-t border-scent-accent/10 pt-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="scent-type-label text-[9px] text-scent-text-subtle">
            House
          </dt>
          <dd className="min-w-0 truncate text-right text-[11px] font-semibold text-scent-text-muted">
            {side.brand ? (
              <>
                {brandShared ? (
                  <span className="mr-1 align-middle scent-type-label text-[8px] text-scent-accent/80">
                    shared
                  </span>
                ) : null}
                {side.brand}
              </>
            ) : (
              <span className="text-scent-text-subtle">Not stated</span>
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="scent-type-label text-[9px] text-scent-text-subtle">
            Family
          </dt>
          <dd className="min-w-0 truncate text-right text-[11px] font-semibold text-scent-text-muted">
            {family ? (
              <>
                {familyShared ? (
                  <span className="mr-1 align-middle scent-type-label text-[8px] text-scent-accent/80">
                    shared
                  </span>
                ) : null}
                {family}
              </>
            ) : (
              <span className="text-scent-text-subtle">Not stated</span>
            )}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onVote}
        className="scent-no-mobile-focus-ring mt-3 inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-md bg-scent-accent px-2 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-black shadow-[0_14px_30px_-24px_rgba(0,0,0,0.7)] transition-colors duration-200 hover:bg-[#f0cf70] active:bg-[#d7ad32] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 sm:min-h-11 sm:text-[11px] sm:tracking-[0.12em]"
      >
        <Sparkles size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>{`Vote ${label}`}</span>
      </button>
    </div>
  );
}
