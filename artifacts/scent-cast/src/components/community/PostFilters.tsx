import React, { useEffect, useState } from 'react';
import {
  BadgeDollarSign,
  Grid2X2,
  MessageCircleQuestion,
  Search,
  Sun,
  Swords,
  Tags,
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
  const [tagsOpen, setTagsOpen] = useState(false);

  useEffect(() => {
    setDraftQuery(q);
  }, [q]);

  useEffect(() => {
    if (tag) setTagsOpen(true);
  }, [tag]);

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
      className="w-full bg-black/38 p-4 sm:p-5"
      aria-label="Community post filters"
    >
      <div className="grid items-center gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.48fr)]">
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-5">
          <button
            type="button"
            onClick={() => onTypeChange(null)}
            aria-pressed={type === null}
            className={[
              'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border px-3 py-2 text-center scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
              type === null
                ? 'border-scent-accent bg-scent-accent/[0.22] font-bold text-[#fff7ec] shadow-[0_0_12px_-2px_rgba(212,175,55,0.45)]'
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
                'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border px-3 py-2 text-center scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
                type === roomType
                  ? 'border-scent-accent bg-scent-accent/[0.22] font-bold text-[#fff7ec] shadow-[0_0_12px_-2px_rgba(212,175,55,0.45)]'
                  : 'border-scent-accent/16 bg-black/54 text-scent-text-muted hover:border-scent-accent/34 hover:text-[#fff7ec]',
              ].join(' ')}
            >
              <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <div className="relative w-full">
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
              className="absolute right-1.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-scent-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
            >
              <X size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setTagsOpen((open) => !open)}
            aria-expanded={tagsOpen}
            className={[
              'inline-flex min-h-10 items-center gap-2 rounded-full border px-3 py-2 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
              tagsOpen || tag
                ? 'border-scent-accent/38 bg-scent-accent/[0.09] text-[#fff7ec]'
                : 'border-white/10 bg-black/40 text-scent-text-muted hover:border-scent-accent/28 hover:text-[#fff7ec]',
            ].join(' ')}
          >
            <Tags size={14} strokeWidth={1.7} aria-hidden="true" />
            Popular tags
          </button>
          {tag ? (
            <button
              type="button"
              onClick={() => onTagChange(null)}
              aria-label={`Clear #${tag} tag filter`}
              className="inline-flex min-h-10 items-center gap-2 rounded-full border border-scent-accent/42 bg-scent-accent/[0.12] px-3 py-2 scent-type-chip font-bold text-[#fff7ec] transition-colors hover:border-scent-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
            >
              #{tag}
              <X size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {type || tag || q ? (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3 py-2 scent-type-chip text-scent-text-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
            Clear
          </button>
        ) : null}
      </div>

      {tagsOpen ? (
        <div className="mt-3 flex flex-wrap gap-2 rounded-[16px] border border-white/8 bg-black/42 p-3">
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
                  'shrink-0 rounded-full border px-3 py-1.5 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
                  active
                    ? 'border-scent-accent bg-scent-accent/[0.22] font-bold text-[#fff7ec] shadow-[0_0_12px_-2px_rgba(212,175,55,0.45)]'
                    : 'border-white/10 bg-black/54 text-scent-text-muted hover:border-scent-accent/28 hover:text-[#fff7ec]',
                ].join(' ')}
              >
                #{candidate}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};
