import React from 'react';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import type { CommunityFragranceEntry } from '@/components/community/communityData';

interface CommunityFragranceCardProps {
  item: CommunityFragranceEntry;
  onOpen: (item: CommunityFragranceEntry) => void;
}

export const CommunityFragranceCard = React.forwardRef<HTMLButtonElement, CommunityFragranceCardProps>(({ item, onOpen }, ref) => (
  <button
    type="button"
    ref={ref}
    onClick={() => onOpen(item)}
    aria-label={`Open ${item.name} by ${item.brand}, curated by ${item.curator}`}
    className="scent-fragrance-card relative aspect-[3/4.6] p-5 sm:p-6 flex flex-col group cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
  >
    <div className="scent-card-frame" aria-hidden="true" />
    <div className="relative z-10 flex justify-end">
      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-scent-accent/80">
        from {item.curator}
      </span>
    </div>
    <div className="relative z-10 flex-1 min-h-0 my-3">
      <BottleImage
        src={item.imageUrl}
        alt={`${item.name} by ${item.brand}`}
        variant="card"
        className="absolute inset-0"
        imgClassName="scent-hover-scale brightness-[1.1] transition-transform duration-[900ms] motion-reduce:transition-none"
        adjustment={item.imageAdjustment}
      />
    </div>
    <div className="relative z-10 mt-2">
      <BrandGoldLabel as="span" brand={item.brand} className="scent-card-brand block" />
    </div>
    <div className="scent-card-title-row relative z-10 mt-2">
      <h3 className="scent-card-title" title={item.name}>{item.name}</h3>
    </div>
    {item.family ? (
      <p className="relative z-10 mt-2 text-center text-[9px] uppercase tracking-[0.22em] text-scent-muted">
        {item.family}
      </p>
    ) : null}
  </button>
));

CommunityFragranceCard.displayName = 'CommunityFragranceCard';
