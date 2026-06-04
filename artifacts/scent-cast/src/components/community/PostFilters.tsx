import React, { useEffect, useState } from 'react';
import {
  BadgeDollarSign,
  Grid2X2,
  MessageCircleQuestion,
  Search,
  Sun,
  Swords,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  type CommunityPostType,
  sanitizeCommunityTag,
} from '@/components/community/communityPosts';

interface RoomDefinition {
  type: CommunityPostType;
  label: string;
  Icon: LucideIcon;
}

const ROOMS: RoomDefinition[] = [
  { type: 'question', label: 'Ask the Room', Icon: MessageCircleQuestion },
  { type: 'sotd', label: 'SOTD', Icon: Sun },
  { type: 'battle', label: 'Battles', Icon: Swords },
  { type: 'worth_it', label: 'Price Checks', Icon: BadgeDollarSign },
];

const TAGS = [
  'summer',
  'office',
  'date-night',
  'longevity',
];

interface PostFiltersProps {
  type: CommunityPostType | null;
  tag: string | null;
  q: string;
  onTypeChange: (type: CommunityPostType | null) => void;
  onTagChange: (tag: string | null) => void;
  onQueryChange: (query: string) => void;
}

export const PostFilters: React.FC<PostFiltersProps> = ({
  type,
  tag,
  q,
  onTypeChange,
  onTagChange,
  onQueryChange,
}) => {
  const [draftQuery, setDraftQuery] = useState(q);

  useEffect(() => {
    setDraftQuery(q);
  }, [q]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      onQueryChange(draftQuery.trim());
    }, 280);
    return () => window.clearTimeout(timeout);
  }, [draftQuery, onQueryChange]);

  const clearFilters = () => {
    onTypeChange(null);
    onTagChange(null);
    setDraftQuery('');
    onQueryChange('');
  };

  return (
    <section className="space-y-4" aria-label="Community post filters">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onTypeChange(null)}
            aria-pressed={type === null}
            className={[
              'inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
              type === null
                ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-[#fff7ec]'
                : 'border-scent-accent/16 bg-white/[0.025] text-scent-muted hover:border-scent-accent/34 hover:text-[#fff7ec]',
            ].join(' ')}
          >
            <Grid2X2 size={14} strokeWidth={1.7} aria-hidden="true" />
            All rooms
          </button>
          {ROOMS.map(({ type: roomType, label, Icon }) => (
            <button
              key={roomType}
              type="button"
              onClick={() => onTypeChange(roomType)}
              aria-pressed={type === roomType}
              className={[
                'inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
                type === roomType
                  ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-[#fff7ec]'
                  : 'border-scent-accent/16 bg-white/[0.025] text-scent-muted hover:border-scent-accent/34 hover:text-[#fff7ec]',
              ].join(' ')}
            >
              <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <div className="relative w-full lg:max-w-sm">
          <Search
            size={16}
            strokeWidth={1.7}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-scent-accent/55"
            aria-hidden="true"
          />
          <input
            type="search"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search rooms, fragrances, tags, or notes"
            aria-label="Search community rooms"
            className="scent-lux-input h-11 w-full rounded-full pl-11 pr-11 text-sm text-[#fff7ec] placeholder:text-scent-muted/45"
          />
          {draftQuery ? (
            <button
              type="button"
              onClick={() => setDraftQuery('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-scent-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
            >
              <X size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        <p className="shrink-0 text-[10px] font-bold uppercase tracking-[0.18em] text-scent-muted/52">
          Popular tags
        </p>
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TAGS.map((candidate) => {
            const normalized = sanitizeCommunityTag(candidate);
            const active = tag === normalized;
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => onTagChange(active ? null : normalized)}
                aria-pressed={active}
                className={[
                  'shrink-0 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
                  active
                    ? 'border-scent-accent/44 bg-scent-accent/[0.08] text-[#fff7ec]'
                    : 'border-white/10 bg-white/[0.02] text-scent-muted/75 hover:border-scent-accent/28 hover:text-[#fff7ec]',
                ].join(' ')}
              >
                #{candidate}
              </button>
            );
          })}
        </div>
        {type || tag || q ? (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-scent-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
            Clear
          </button>
        ) : null}
      </div>
    </section>
  );
};
