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
  { type: 'question', label: 'Questions', Icon: MessageCircleQuestion },
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
    <section
      className="rounded-[var(--radius-scent)] border border-scent-accent/24 bg-black/58 p-4 shadow-[0_16px_40px_-32px_rgba(0,0,0,0.92),0_0_0_1px_rgba(212,175,55,0.05)] sm:p-6"
      aria-label="Community post filters"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-5">
          <button
            type="button"
            onClick={() => onTypeChange(null)}
            aria-pressed={type === null}
            className={[
              'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border px-3 py-2 text-center scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
              type === null
                ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-[#fff7ec]'
                : 'border-scent-accent/16 bg-black/54 text-scent-text-muted hover:border-scent-accent/34 hover:text-[#fff7ec]',
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
                'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border px-3 py-2 text-center scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
                type === roomType
                  ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-[#fff7ec]'
                  : 'border-scent-accent/16 bg-black/54 text-scent-text-muted hover:border-scent-accent/34 hover:text-[#fff7ec]',
              ].join(' ')}
            >
              <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <div className="relative mx-auto w-full max-w-md">
          <Search
            size={16}
            strokeWidth={1.7}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-scent-accent"
            aria-hidden="true"
          />
          <input
            type="search"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search rooms, fragrances, tags, or notes"
            aria-label="Search community rooms"
            className="scent-lux-input h-11 w-full rounded-full pl-11 pr-11 text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
          />
          {draftQuery ? (
            <button
              type="button"
              onClick={() => setDraftQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-scent-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
            >
              <X size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <p className="shrink-0 scent-type-label">
          Popular tags
        </p>
        <div className="flex flex-wrap justify-center gap-2">
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
                  'shrink-0 rounded-full border px-3 py-1.5 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35',
                  active
                    ? 'border-scent-accent/44 bg-scent-accent/[0.08] text-[#fff7ec]'
                    : 'border-white/10 bg-black/54 text-scent-text-muted hover:border-scent-accent/28 hover:text-[#fff7ec]',
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
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
            Clear
          </button>
        ) : null}
      </div>
    </section>
  );
};
