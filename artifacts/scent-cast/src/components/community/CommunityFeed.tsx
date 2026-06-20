import React, { useEffect, useMemo, useRef } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import { CommunityLoadingState } from '@/components/community/CommunityLoadingState';
import { PostCard } from '@/components/community/PostCard';
import {
  type CommunityPostType,
  type CommunityPostFilters,
  useCommunityPosts,
} from '@/components/community/communityPosts';

type StartRoomPreset = {
  type?: CommunityPostType | null;
  tag?: string | null;
};

interface CommunityFeedProps {
  filters: CommunityPostFilters;
  authToken: string | null;
  onSignIn: () => void;
  onStartRoom: (preset?: StartRoomPreset) => void;
  onClearFilters: () => void;
}

function roomActionCopy(type?: CommunityPostType | null): { label: string; ariaLabel: string; body: string } {
  switch (type) {
    case 'sotd':
      return {
        label: 'Share your SOTD',
        ariaLabel: 'Share your scent of the day',
        body: 'Share what you are wearing and give this room a fresh thread.',
      };
    case 'question':
      return {
        label: 'Ask a question',
        ariaLabel: 'Ask a fragrance question',
        body: 'Ask for a recommendation, comparison, or honest verdict.',
      };
    case 'battle':
      return {
        label: 'Start a battle',
        ariaLabel: 'Start a fragrance battle',
        body: 'Put two bottles head to head and let the room vote.',
      };
    case 'worth_it':
      return {
        label: 'Post a price check',
        ariaLabel: 'Post a fragrance price check',
        body: 'Give the room the price context and get a read before you buy.',
      };
    default:
      return {
        label: 'Start a room',
        ariaLabel: 'Start a community room',
        body: 'Share a fragrance, ask a question, or start a battle.',
      };
  }
}

function emptyStateCopy(filters: CommunityPostFilters): { title: string; body: string; actionLabel: string; actionAriaLabel: string } {
  if (filters.tag && !filters.q) {
    const copy = roomActionCopy(filters.type);
    return {
      title: `No #${filters.tag} rooms yet.`,
      body: `Start the first #${filters.tag} discussion. ${copy.body}`,
      actionLabel: `Start #${filters.tag} discussion`,
      actionAriaLabel: `Start a discussion tagged ${filters.tag}`,
    };
  }
  if (filters.q || filters.tag) {
    return {
      title: 'Nothing matches that search yet.',
      body: 'Try another phrase or clear the filters to open the full room.',
      actionLabel: 'Clear filters',
      actionAriaLabel: 'Clear community filters',
    };
  }
  switch (filters.type) {
    case 'sotd':
      return {
        title: 'No scents of the day yet.',
        body: 'Be the first to share your scent of the day.',
        actionLabel: 'Share your SOTD',
        actionAriaLabel: 'Share your scent of the day',
      };
    case 'question':
      return {
        title: 'No questions yet.',
        body: 'Ask the room for a recommendation or an honest verdict.',
        actionLabel: 'Ask a question',
        actionAriaLabel: 'Ask a fragrance question',
      };
    case 'battle':
      return {
        title: 'No battles yet.',
        body: 'Pit two bottles against each other and let the room vote.',
        actionLabel: 'Start a battle',
        actionAriaLabel: 'Start a fragrance battle',
      };
    case 'worth_it':
      return {
        title: 'No price checks yet.',
        body: 'Ask the room whether a bottle is worth it before you buy.',
        actionLabel: 'Post a price check',
        actionAriaLabel: 'Post a fragrance price check',
      };
    default:
      return {
        title: 'No rooms yet.',
        body: 'Start the first room and get the conversation going.',
        actionLabel: 'Start a room',
        actionAriaLabel: 'Start a community room',
      };
  }
}

export const CommunityFeed: React.FC<CommunityFeedProps> = ({
  filters,
  authToken,
  onSignIn,
  onStartRoom,
  onClearFilters,
}) => {
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const {
    data,
    isLoading,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isRefetching,
    isPlaceholderData,
    refetch,
  } = useCommunityPosts(filters, authToken);

  const posts = useMemo(
    () => data?.pages.flatMap((page) => page.posts) ?? [],
    [data],
  );

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasNextPage || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '360px 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, posts.length]);

  if (isLoading) {
    return <CommunityLoadingState label="Loading community posts" />;
  }

  if (isError) {
    return (
      <div
        role="alert"
        className="mx-auto w-full max-w-[940px] rounded-[calc(var(--radius-scent)+2px)] border border-red-500/20 bg-red-500/[0.055] p-6 text-center"
      >
        <p className="font-serif text-xl italic text-red-100">The feed could not load.</p>
        <p className="mt-2 text-sm font-medium text-red-100/85">
          {error instanceof Error ? error.message : 'Community feed is unavailable.'}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-red-200/40 px-5 py-2 scent-type-chip text-red-100 transition-colors hover:border-red-200/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200/80"
        >
          Try again
        </button>
      </div>
    );
  }

  if (posts.length === 0) {
    const hasActiveFilters = Boolean(filters.type || filters.tag || filters.q);
    const shouldClearFilters = Boolean(filters.q);
    const { title, body, actionLabel, actionAriaLabel } = emptyStateCopy(filters);
    return (
      <div className="mx-auto w-full max-w-[940px] rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/18 bg-black/46 px-6 py-12 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.04)]">
        <p className="font-serif text-2xl italic text-[#fff7ec]">{title}</p>
        <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-scent-text-muted">{body}</p>
        <div className="mt-6 flex justify-center">
          {shouldClearFilters ? (
            <button
              type="button"
              onClick={onClearFilters}
              aria-label={actionAriaLabel}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-scent-accent/22 bg-black/58 px-5 py-2 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
            >
              <X size={15} strokeWidth={1.8} aria-hidden="true" />
              {actionLabel}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onStartRoom({ type: filters.type, tag: filters.tag })}
              aria-label={actionAriaLabel}
              className="scent-primary-button inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-scent)] px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
            >
              <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>{actionLabel}</span>
            </button>
          )}
        </div>
        {hasActiveFilters && !shouldClearFilters ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="mt-4 inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-4 py-2 scent-type-chip text-scent-text-muted transition-colors hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
            Clear filters
          </button>
        ) : null}
      </div>
    );
  }

  const endCopy = roomActionCopy(filters.type);

  return (
    <div
      className="mx-auto w-full max-w-[940px] space-y-5 sm:space-y-6"
      aria-busy={isRefetching || isFetchingNextPage || isPlaceholderData}
    >
      <div
        className={`transition-opacity duration-200 motion-reduce:transition-none ${
          isPlaceholderData ? 'opacity-55' : 'opacity-100'
        }`}
      >
        <div className="space-y-5 sm:space-y-6">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} authToken={authToken} onSignIn={onSignIn} />
          ))}
        </div>
      </div>

      <div ref={loadMoreRef} className="flex min-h-16 items-center justify-center">
        {hasNextPage ? (
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-scent-accent/22 bg-black/58 px-5 py-2 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80 disabled:pointer-events-none disabled:opacity-55"
          >
            {isFetchingNextPage ? (
              <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
            ) : null}
            {isFetchingNextPage ? 'Loading' : 'Load more'}
          </button>
        ) : (
          <div className="flex w-full flex-col items-center gap-4 rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/18 bg-black/46 px-6 py-10 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.04)]">
            <p className="font-serif text-xl italic text-[#fff7ec]">You&rsquo;ve reached the end.</p>
            <p className="max-w-md text-sm leading-6 text-scent-text-muted">
              {filters.tag
                ? `Keep #${filters.tag} moving. ${endCopy.body}`
                : endCopy.body}
            </p>
            <button
              type="button"
              onClick={() => onStartRoom({ type: filters.type, tag: filters.tag })}
              aria-label={endCopy.ariaLabel}
              className="scent-primary-button inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-scent)] px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
            >
              <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>{endCopy.label}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
