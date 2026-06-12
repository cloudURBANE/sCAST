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
}) => (
  <article
    className={[
      'relative min-w-0 overflow-hidden rounded-[calc(var(--radius-scent)+8px)] border bg-[rgba(4,3,2,0.88)] p-4 shadow-[0_28px_72px_-42px_rgba(212,175,55,0.28),inset_0_1px_0_rgba(255,236,183,0.09)] transition-all duration-200 hover:border-scent-accent/48 hover:shadow-[0_34px_88px_-52px_rgba(212,175,55,0.38),inset_0_1px_0_rgba(255,236,183,0.12)] sm:p-5 lg:p-6',
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
    <div className="relative z-10 flex min-h-[clamp(24rem,45svh,34rem)] flex-col">
      <div className="mb-4 flex items-center justify-between gap-4">
        <span className="scent-type-label text-scent-accent/78">{align === 'left' ? 'Option A' : 'Option B'}</span>
        {selected ? (
          <span className="arena-badge-pop inline-flex items-center gap-1.5 rounded-full border border-scent-accent/34 bg-scent-accent/[0.1] px-2.5 py-1 scent-type-meta uppercase text-scent-accent shadow-[0_0_12px_rgba(212,175,55,0.15)]">
            <Check size={12} strokeWidth={2} aria-hidden="true" />
            Your pick
          </span>
        ) : null}
      </div>

      <div className="relative flex flex-1 min-h-[15rem] items-end justify-center overflow-hidden rounded-[calc(var(--radius-scent)-6px)] border border-scent-accent/10 bg-black/[0.18]">
        <div className="absolute inset-x-8 bottom-8 h-px bg-gradient-to-r from-transparent via-scent-accent/28 to-transparent" aria-hidden="true" />
        <BottleImage
          src={side.imageUrl}
          alt={`${side.name}${side.brand ? ` by ${side.brand}` : ''}`}
          variant="card"
          className="absolute inset-5 sm:inset-6 lg:inset-7"
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
        <h2 className="mt-2 text-pretty text-balance font-serif text-3xl italic leading-[1.04] text-foreground sm:text-4xl">
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
          'scent-primary-button mt-5 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-[var(--radius-scent)] px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60',
          selected
            ? 'ring-2 ring-scent-accent/40 shadow-[0_0_16px_rgba(212,175,55,0.2)]'
            : '',
        ].join(' ')}
      >
        <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>{revealed ? 'Pick again' : `Vote ${align === 'left' ? 'A' : 'B'}`}</span>
      </button>
    </div>
  </article>
);
