import React from 'react';
import { BottleImage } from '@/components/BottleImage';
import type { CommunityFragranceEntry } from '@/components/community/communityData';

interface CommunityFragranceCardProps {
  item: CommunityFragranceEntry;
}

export function brandLengthBucket(brand: string): 'short' | 'medium' | 'long' | 'xlong' {
  const length = brand.trim().length;
  if (length <= 8) return 'short';
  if (length <= 14) return 'medium';
  if (length <= 22) return 'long';
  return 'xlong';
}

export const CommunityFragranceCard: React.FC<CommunityFragranceCardProps> = ({ item }) => (
  <article className="scent-fragrance-card relative aspect-[3/4.6] p-5 sm:p-6 flex flex-col group cursor-pointer">
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
        imgClassName="brightness-[1.1] group-hover:scale-[1.035] motion-reduce:group-hover:scale-100 transition-transform duration-[900ms] motion-reduce:transition-none"
        adjustment={item.imageAdjustment}
      />
    </div>
    <div className="relative z-10 mt-2">
      <span className="scent-card-brand block" data-len={brandLengthBucket(item.brand)}>
        {item.brand}
      </span>
    </div>
    <div className="scent-card-title-row relative z-10 mt-2">
      <h3 className="scent-card-title" title={item.name}>{item.name}</h3>
    </div>
    {item.family ? (
      <p className="relative z-10 mt-2 text-center text-[9px] uppercase tracking-[0.22em] text-scent-muted">
        {item.family}
      </p>
    ) : null}
  </article>
);
