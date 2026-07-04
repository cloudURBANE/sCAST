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
    'group flex min-h-12 w-full items-center justify-center gap-2.5 rounded-full border px-3 py-2 text-center scent-type-chip transition-[color,background-color,border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
    active
      ? 'border-scent-accent/70 bg-scent-accent/[0.18] font-bold text-[#fff7ec] shadow-[inset_0_1px_0_rgba(255,244,210,0.14)]'
      : 'border-scent-accent/14 bg-black/30 text-scent-text-muted hover:border-scent-accent/42 hover:bg-scent-accent/[0.055] hover:text-[#fff7ec]',
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

// Row style for the mobile room dropdown options (icon + label, left aligned).
function roomMenuItemClass(active: boolean) {
  return [
    'flex min-h-11 w-full items-center gap-2.5 rounded-[12px] border px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
    active
      ? 'border-scent-accent/55 bg-scent-accent/[0.16] text-[#fff7ec]'
      : 'border-scent-accent/14 bg-black/30 text-scent-text-muted hover:border-scent-accent/42 hover:bg-scent-accent/[0.055] hover:text-[#fff7ec]',
  ].join(' ');
}

function tagButtonClass(active: boolean) {
  return [
    'inline-flex h-10 min-w-max items-center justify-center rounded-full border px-3 text-center text-xs font-bold uppercase tracking-[0.12em] transition-[color,background-color,border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80',
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
  // Mobile-only room selector menu. Below sm the five room chips collapse into
  // two centered glassmorphic dropdowns (rooms + tags) sitting side by side, so
  // opening one closes the other and a tap-out backdrop dismisses both.
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);

  const activeRoom = ROOMS.find((room) => room.type === type) ?? null;
  const ActiveRoomIcon = activeRoom?.Icon ?? Grid2X2;
  const activeRoomLabel = activeRoom?.label ?? 'All rooms';

  const toggleRoomMenu = () => {
    setRoomMenuOpen((open) => !open);
    setTagMenuOpen(false);
  };
  const toggleTagMenu = () => {
    setTagMenuOpen((open) => !open);
    setRoomMenuOpen(false);
  };
  const closeMenus = () => {
    setRoomMenuOpen(false);
    setTagMenuOpen(false);
  };
  const selectRoom = (roomType: CommunityPostType | null) => {
    onTypeChange(roomType);
    setRoomMenuOpen(false);
  };

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

        {/* Desktop: the full five-room grid stays a single horizontal bar. */}
        <div className="hidden w-full min-w-0 gap-2.5 sm:grid">
          <div className="grid w-full min-w-0 grid-cols-5 gap-2.5">
            <button
              type="button"
              onClick={() => onTypeChange(null)}
              aria-pressed={type === null}
              className={roomButtonClass(type === null)}
            >
              <Grid2X2 size={17} strokeWidth={1.65} aria-hidden="true" />
              <span className="min-w-0 whitespace-nowrap">All rooms</span>
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
                <span className="min-w-0 whitespace-nowrap">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Desktop: popular tags expand into the scrolling marquee. */}
        <div className="hidden min-w-0 border-t border-scent-accent/10 pt-3.5 sm:block">
          <button
            type="button"
            onClick={toggleTagMenu}
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
        </div>

        {/* Mobile: two centered glassmorphic dropdowns sitting side by side. Each
            sits in its own relative cell so an open panel can stretch across both
            columns (200% of the half-width cell + the 0.75rem grid gap). */}
        <div className="grid grid-cols-2 gap-3 sm:hidden">
          <div className="relative z-30 min-w-0">
            <button
              type="button"
              onClick={toggleRoomMenu}
              aria-expanded={roomMenuOpen}
              aria-haspopup="listbox"
              className="flex h-11 w-full min-w-0 items-center justify-between gap-2 rounded-full border border-scent-accent/24 bg-black/40 px-4 text-left transition-colors hover:border-scent-accent/46 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
            >
              <span className="flex min-w-0 items-center gap-2 text-[#fff7ec]">
                <ActiveRoomIcon size={16} strokeWidth={1.65} className="shrink-0 text-scent-accent" aria-hidden="true" />
                <span className="truncate text-xs font-bold uppercase tracking-[0.12em]">{activeRoomLabel}</span>
              </span>
              <ChevronDown
                size={16}
                strokeWidth={1.8}
                aria-hidden="true"
                className={`shrink-0 text-scent-accent transition-transform ${roomMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {roomMenuOpen ? (
              <div
                className="absolute left-0 top-full z-30 mt-2 grid w-[calc(200%+0.75rem)] gap-1.5 rounded-[16px] border border-scent-accent/30 bg-[#0a0805]/95 p-2 shadow-[0_24px_48px_rgba(0,0,0,0.7)] backdrop-blur-md"
                role="listbox"
                aria-label="Room filters"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={type === null}
                  onClick={() => selectRoom(null)}
                  className={roomMenuItemClass(type === null)}
                >
                  <Grid2X2 size={17} strokeWidth={1.65} aria-hidden="true" />
                  <span className="whitespace-nowrap">All rooms</span>
                </button>
                {ROOMS.map(({ type: roomType, label, Icon }) => (
                  <button
                    key={roomType}
                    type="button"
                    role="option"
                    aria-selected={type === roomType}
                    onClick={() => selectRoom(roomType)}
                    className={roomMenuItemClass(type === roomType)}
                  >
                    <Icon size={17} strokeWidth={1.65} aria-hidden="true" />
                    <span className="whitespace-nowrap">{label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="relative z-30 min-w-0">
            <button
              type="button"
              onClick={toggleTagMenu}
              aria-expanded={tagMenuOpen}
              aria-haspopup="listbox"
              className="flex h-11 w-full min-w-0 items-center justify-between gap-2 rounded-full border border-scent-accent/24 bg-black/40 px-4 text-left transition-colors hover:border-scent-accent/46 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
            >
              <span className="truncate text-xs font-bold uppercase tracking-[0.12em] text-[#fff7ec]">
                {tag ? `#${tag}` : 'Popular tags'}
              </span>
              <ChevronDown
                size={16}
                strokeWidth={1.8}
                aria-hidden="true"
                className={`shrink-0 text-scent-accent transition-transform ${tagMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {tagMenuOpen && hasTags ? (
              <div
                className="absolute right-0 top-full z-30 mt-2 flex w-[calc(200%+0.75rem)] flex-wrap justify-center gap-2 rounded-[16px] border border-scent-accent/30 bg-[#0a0805]/95 p-3 shadow-[0_24px_48px_rgba(0,0,0,0.7)] backdrop-blur-md"
                role="listbox"
                aria-label="Popular tag filters"
              >
                {tags.map((candidate) => {
                  const normalized = sanitizeCommunityTag(candidate);
                  const active = tag === normalized;
                  return (
                    <button
                      key={candidate}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onTagChange(active ? null : normalized);
                        setTagMenuOpen(false);
                      }}
                      aria-label={active ? `Clear #${candidate} tag filter` : `Filter by #${candidate}`}
                      className={tagButtonClass(active)}
                    >
                      #{candidate}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* Tap-out backdrop; lives inside the sm:hidden grid so it never
              intercepts taps on desktop where the marquee owns tagMenuOpen. */}
          {roomMenuOpen || tagMenuOpen ? (
            <div className="fixed inset-0 z-20 bg-transparent" aria-hidden="true" onClick={closeMenus} />
          ) : null}
        </div>

        {hasFilters ? (
          <div className="flex justify-center">
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
    </section>
  );
};
