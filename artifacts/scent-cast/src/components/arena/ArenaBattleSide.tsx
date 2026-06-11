import React from 'react';
import { Check, Sparkles } from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import type { ArenaBattleSide as ArenaBattleSideData } from '@/components/arena/arenaBattleMapper';

interface ArenaBattleSideProps {
  side: ArenaBattleSideData;
  align: 'left' | 'right';
  selected: boolean;
  revealed: boolean;
  percent: number;
  count: number;
  disabled: boolean;
  onVote: () => void;
}

export const ArenaBattleSide: React.FC<ArenaBattleSideProps> = ({
  side,
  align,
  selected,
  revealed,
  percent,
  count,
  disabled,
  onVote,
}) => (
  <article
    className={[
      'relative min-w-0 overflow-hidden rounded-[calc(var(--radius-scent)+8px)] border bg-[radial-gradient(85%_70%_at_50%_0%,rgba(255,255,255,0.045),transparent_68%),linear-gradient(180deg,rgba(8,6,3,0.92),rgba(0,0,0,0.98))] p-4 shadow-[0_32px_86px_-56px_rgba(212,175,55,0.5),inset_0_1px_0_rgba(255,236,183,0.09)] sm:p-5 lg:p-6',
      selected
        ? 'border-scent-accent/62'
        : 'border-scent-accent/26',
    ].join(' ')}
  >
    <div
      className={[
        'pointer-events-none absolute inset-x-0 top-0 h-1 bg-scent-accent transition-opacity',
        selected ? 'opacity-80' : 'opacity-0',
      ].join(' ')}
      aria-hidden="true"
    />
    <div className="relative z-10 flex min-h-[clamp(22rem,54svh,38rem)] flex-col">
      <div className="mb-4 flex items-center justify-between gap-4">
        <span className="scent-type-label text-scent-accent/78">{align === 'left' ? 'Option A' : 'Option B'}</span>
        {selected ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-scent-accent/34 bg-scent-accent/[0.1] px-2.5 py-1 scent-type-meta uppercase text-scent-accent">
            <Check size={12} strokeWidth={2} aria-hidden="true" />
            Your pick
          </span>
        ) : null}
      </div>

      <div className="relative flex flex-1 min-h-[15rem] items-end justify-center overflow-hidden rounded-[calc(var(--radius-scent)-6px)] border border-white/8 bg-[linear-gradient(180deg,rgba(255,247,236,0.035),rgba(0,0,0,0.22))]">
        <div className="absolute inset-x-8 bottom-8 h-px bg-gradient-to-r from-transparent via-scent-accent/28 to-transparent" aria-hidden="true" />
        <BottleImage
          src={side.imageUrl}
          alt={`${side.name}${side.brand ? ` by ${side.brand}` : ''}`}
          variant="card"
          className="absolute inset-5 sm:inset-7"
          imgClassName="brightness-[1.08] drop-shadow-[0_22px_28px_rgba(0,0,0,0.62)]"
          loading={align === 'left' ? 'eager' : 'lazy'}
          fetchPriority={align === 'left' ? 'high' : 'auto'}
        />
      </div>

      <div className="mt-5 min-w-0 text-center">
        {side.brand ? (
          <BrandGoldLabel as="p" brand={side.brand} className="scent-card-brand mx-auto block max-w-full" />
        ) : (
          <p className="scent-type-label text-scent-accent/70">Community option</p>
        )}
        <h2 className="mt-2 text-balance font-serif text-3xl italic leading-[1.04] text-[#fff7ec] sm:text-4xl">
          {side.name}
        </h2>
        <p className="mx-auto mt-3 max-w-sm text-sm font-medium leading-6 text-scent-text-muted">
          {side.descriptor}
        </p>
      </div>

      <button
        type="button"
        onClick={onVote}
        disabled={disabled}
        className={[
          'mt-5 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-[var(--radius-scent)] px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60',
          selected
            ? 'border border-scent-accent/50 bg-scent-accent/[0.12] text-[#fff7ec]'
            : 'scent-primary-button text-black',
        ].join(' ')}
      >
        <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>{revealed ? 'Pick again' : `Vote ${align === 'left' ? 'A' : 'B'}`}</span>
      </button>

      {revealed ? (
        <div className="mt-4" aria-label={`${side.name} has ${percent}% from ${count} saved votes`}>
          <div className="flex items-center justify-between gap-3 font-mono text-[12px] text-scent-accent">
            <span>{percent}%</span>
            <span>{count} {count === 1 ? 'vote' : 'votes'}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/8">
            <span className="block h-full rounded-full bg-scent-accent/80" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  </article>
);
