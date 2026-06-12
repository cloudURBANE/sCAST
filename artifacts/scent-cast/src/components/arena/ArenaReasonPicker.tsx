import React from 'react';
import { Check } from 'lucide-react';
import {
  ARENA_REASON_OPTIONS,
  type ArenaReasonKey,
} from '@/components/arena/arenaTwists';

interface ArenaReasonPickerProps {
  value: ArenaReasonKey | null;
  onChange: (value: ArenaReasonKey) => void;
}

export const ArenaReasonPicker: React.FC<ArenaReasonPickerProps> = ({ value, onChange }) => (
  <div className="mx-auto w-full max-w-3xl" aria-label="Pick your vote reason">
    <p className="mb-3 text-center scent-type-label text-scent-accent/85">Why did it win for you?</p>
    <div className="mx-auto grid max-w-2xl grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {ARENA_REASON_OPTIONS.map((reason) => {
        const active = value === reason.key;
        return (
          <button
            key={reason.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(reason.key)}
            className={[
              'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border px-3.5 py-2 text-center scent-type-chip transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55',
              active
                ? 'border-scent-accent/70 bg-scent-accent/[0.18] text-foreground shadow-[0_0_12px_rgba(212,175,55,0.15)]'
                : 'border-scent-accent/18 bg-black/48 text-scent-text-muted hover:border-scent-accent/38 hover:text-foreground',
            ].join(' ')}
          >
            {active ? (
              <Check className="arena-badge-pop shrink-0" size={14} strokeWidth={1.8} aria-hidden="true" />
            ) : null}
            {reason.label}
          </button>
        );
      })}
    </div>
  </div>
);
