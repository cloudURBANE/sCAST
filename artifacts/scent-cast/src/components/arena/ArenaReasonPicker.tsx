import React, { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  ARENA_REASON_OPTIONS,
  type ArenaReasonKey,
} from "@/components/arena/arenaTwists";

interface ArenaReasonPickerProps {
  value: ArenaReasonKey | null;
  onChange: (value: ArenaReasonKey) => void;
}

export const ArenaReasonPicker: React.FC<ArenaReasonPickerProps> = ({
  value,
  onChange,
}) => {
  const [editing, setEditing] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const selectedReason = ARENA_REASON_OPTIONS.find(
    (reason) => reason.key === value,
  );
  const primaryReasons = ARENA_REASON_OPTIONS.slice(0, 4);
  const extraReasons = ARENA_REASON_OPTIONS.slice(4);
  const visibleReasons = showMore
    ? [...primaryReasons, ...extraReasons]
    : primaryReasons;

  if (selectedReason && !editing) {
    return (
      <div className="flex justify-center" aria-label="Selected vote reason">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="arena-badge-pop inline-flex min-h-8 items-center justify-center gap-2 rounded-full bg-scent-accent/12 px-3 py-1.5 text-center scent-type-chip text-scent-accent shadow-[inset_0_0_0_1px_rgba(212,175,55,0.16)] transition-colors hover:bg-scent-accent/18 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/60"
          aria-label={`Reason: ${selectedReason.label}. Change reason.`}
        >
          <Check size={14} strokeWidth={2.2} aria-hidden="true" />
          <span>Why it won: {selectedReason.label}</span>
          <span className="ml-1 text-[10px] text-scent-text-muted">Change</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="mx-auto w-full max-w-3xl"
      aria-label="Pick your vote reason"
    >
      <p className="mb-3 text-center scent-type-label text-scent-accent/85">
        Why did it win for you?
      </p>
      <div className="mx-auto grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-3.5 lg:grid-cols-4">
        {visibleReasons.map((reason) => {
          const active = value === reason.key;
          return (
            <button
              key={reason.key}
              type="button"
              aria-pressed={active}
              onClick={() => {
                onChange(reason.key);
                setEditing(false);
                setShowMore(false);
              }}
              className={[
                "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-3.5 py-2 text-center scent-type-chip shadow-[inset_0_0_0_1px_rgba(212,175,55,0.14)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55",
                active
                  ? "bg-scent-accent text-black shadow-[0_0_16px_rgba(212,175,55,0.18)]"
                  : "bg-black/48 text-scent-text-muted hover:bg-scent-accent/[0.08] hover:text-foreground",
              ].join(" ")}
            >
              {active ? (
                <Check
                  className="arena-badge-pop shrink-0"
                  size={14}
                  strokeWidth={2.2}
                  aria-hidden="true"
                />
              ) : null}
              {reason.label}
            </button>
          );
        })}
      </div>
      {extraReasons.length > 0 && !showMore ? (
        <button
          type="button"
          onClick={() => setShowMore(true)}
          className="mx-auto mt-3 inline-flex min-h-9 items-center justify-center gap-2 rounded-full bg-white/[0.035] px-4 py-2 scent-type-chip text-scent-text-muted transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50"
        >
          <span>More reasons</span>
          <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
};
