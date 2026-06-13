import React, { useEffect, useState } from 'react';
import {
  BadgeDollarSign,
  ChevronDown,
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
  usePopularCommunityTags,
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
  'compliments',
  'fresh',
];

function roomButtonClass(active: boolean, extra = '') {
  return [
    'group flex min-h-12 w-full items-center justify-center gap-2.5 rounded-full border px-3 py-2 text-center scent-type-chip transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
    active
      ? 'border-scent-accent/70 bg-scent-accent/[0.18] font-bold text-[#fff7ec] shadow-[inset_0_1px_0_rgba(255,244,210,0.14)]'
      : 'border-scent-accent/14 bg-black/30 text-scent-text-muted hover:border-scent-accent/42 hover:bg-scent-accent/[0.055] hover:text-[#fff7ec]',
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

function tagButtonClass(active: boolean) {
  return [
    'inline-flex h-10 min-w-max items-center justify-center rounded-full border px-3 text-center text-xs font-bold uppercase tracking-[0.12em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
    active
      ? 'border-scent-accent/76 bg-scent-accent/[0.18] text-[#fff7ec] shadow-[inset_0_1px_0_rgba(255,244,210,0.14)]'
      : 'border-scent-accent/16 bg-black/30 text-[#d9c099] hover:border-scent-accent/46 hover:bg-scent-accent/[0.065] hover:text-[#fff7ec]',
  ].join(' ');
}

interface PostFiltersProps {
  type: CommunityPostType | null;
  tag: string | null;
  q: string;
  authToken?: string | null;
  onTypeChange: (type: CommunityPostType | null) => void;
  onTagChange: (tag: string | null) => void;
  onQueryChange: (query: string) => void;
}

const TAG_LIMIT = 8;

export const PostFilters: React.FC<PostFiltersProps> = ({
  type,
  tag,
  q,
  authToken = null,
  onTypeChange,
  onTagChange,
  onQueryChange,
}) => {
  const [draftQuery, setDraftQuery] = useState(q);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);

  // Popular tags come from the tenant aggregate; fall back to the curated
  // defaults while loading or when the community has no tagged posts yet.
  const { data: popularTags } = usePopularCommunityTags(authToken);
  const tags = (popularTags && popularTags.length > 0 ? popularTags : TAGS).slice(0, TAG_LIMIT);

  const hasTags = tags.length > 0;

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
  const hasFilters = Boolean(type || tag || q || draftQuery.trim());

  return (
    <section
      className="w-full border-t border-scent-accent/10 bg-black/30 p-4 sm:p-5"
      aria-label="Community post filters"
    >
      <div className="mx-auto grid w-full min-w-0 max-w-[850px] gap-4">
        <div className="relative w-full">
          <Search
            size={16}
            strokeWidth={1.7}
            className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-scent-accent"
            aria-hidden="true"
          />
          <input
            type="search"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search rooms, fragrances, tags, or notes"
            aria-label="Search community rooms"
            className="scent-lux-input h-[3.25rem] w-full rounded-full px-14 text-center text-base text-[#fff7ec] placeholder:text-scent-text-subtle"
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

        <div className="grid w-full min-w-0 gap-2.5">
          <div className="grid w-full min-w-0 grid-cols-2 gap-2.5 sm:grid-cols-5">
            <button
              type="button"
              onClick={() => onTypeChange(null)}
              aria-pressed={type === null}
              className={roomButtonClass(type === null)}
            >
              <Grid2X2 size={17} strokeWidth={1.65} aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">All rooms</span>
            </button>
            {ROOMS.map(({ type: roomType, label, Icon }) => (
              <button
                key={roomType}
                type="button"
                onClick={() => onTypeChange(roomType)}
                aria-pressed={type === roomType}
                className={roomButtonClass(type === roomType)}
              >
                <Icon size={17} strokeWidth={1.65} aria-hidden="true" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {label}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 border-t border-scent-accent/10 pt-3.5">
          <button
            type="button"
            onClick={() => setTagMenuOpen((open) => !open)}
            aria-expanded={tagMenuOpen}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-full border border-scent-accent/16 bg-black/30 px-4 py-2 text-left transition-colors hover:border-scent-accent/42 hover:bg-scent-accent/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
          >
            <span className="min-w-0 overflow-hidden">
              <span className="block scent-type-label text-scent-accent">Popular tags</span>
              {tag ? (
                <span className="mt-0.5 block truncate text-xs font-bold uppercase tracking-[0.12em] text-[#fff7ec]">
                  #{tag}
                </span>
              ) : null}
            </span>
            <ChevronDown
              size={17}
              strokeWidth={1.8}
              aria-hidden="true"
              className={`shrink-0 text-scent-accent transition-transform ${tagMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {tagMenuOpen && hasTags ? (
            <div className="scent-community-tag-marquee mt-3 w-full min-w-0 max-w-full" aria-label="Popular tag filters">
              <div className="scent-community-tag-marquee-track">
                {[0, 1].map((copyIndex) => (
                  <div className="scent-community-tag-marquee-group" key={copyIndex} aria-hidden={copyIndex > 0}>
                    {tags.map((candidate) => {
                      const normalized = sanitizeCommunityTag(candidate);
                      const active = tag === normalized;
                      return (
                        <button
                          key={`${copyIndex}:${candidate}`}
                          type="button"
                          tabIndex={copyIndex > 0 ? -1 : 0}
                          onClick={() => onTagChange(active ? null : normalized)}
                          aria-label={
                            active
                              ? `Clear #${candidate} tag filter`
                              : `Filter by #${candidate}`
                          }
                          aria-pressed={active}
                          className={tagButtonClass(active)}
                        >
                          #{candidate}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {hasFilters ? (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3 py-2 scent-type-chip text-scent-text-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
              >
                <X size={13} strokeWidth={1.8} aria-hidden="true" />
                Clear
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
};
