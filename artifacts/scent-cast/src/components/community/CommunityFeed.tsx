import React, { useEffect, useMemo, useRef } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import { PostCard } from '@/components/community/PostCard';
import {
  type CommunityPostFilters,
  useCommunityPosts,
} from '@/components/community/communityPosts';

interface CommunityFeedProps {
  filters: CommunityPostFilters;
  authToken: string | null;
  onSignIn: () => void;
  onStartRoom: () => void;
  onClearFilters: () => void;
}

function emptyStateCopy(filters: CommunityPostFilters): { title: string; body: string } {
  if (filters.q || filters.tag) {
    return {
      title: 'No rooms match yet.',
      body: 'Try a different search or clear your filters to see every room.',
    };
  }
  switch (filters.type) {
    case 'sotd':
      return { title: 'No scents of the day yet.', body: 'Be the first to share your scent of the day.' };
    case 'question':
      return { title: 'No questions yet.', body: 'Ask the room for a recommendation or an honest verdict.' };
    case 'battle':
      return { title: 'No battles yet.', body: 'Pit two bottles against each other and let the room vote.' };
    case 'worth_it':
      return { title: 'No price checks yet.', body: 'Ask the room whether a bottle is worth it before you buy.' };
    default:
      return { title: 'No rooms yet.', body: 'Start the first room and get the conversation going.' };
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
  } = useCommunityPosts(filters);

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
    return (
      <div className="mx-auto grid w-full max-w-[960px] gap-4" aria-label="Loading community posts">
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="min-h-[13rem] rounded-[var(--radius-scent)] border border-scent-accent/24 bg-black/58 p-6 shadow-[0_18px_44px_-30px_rgba(0,0,0,0.95),0_0_0_1px_rgba(212,175,55,0.06)]"
          >
            <div className="mb-5 h-4 w-28 rounded-full bg-scent-accent/10" />
            <div className="mb-3 h-6 w-2/3 rounded-full bg-white/[0.055]" />
            <div className="space-y-2">
              <div className="h-3 w-full rounded-full bg-white/[0.04]" />
              <div className="h-3 w-5/6 rounded-full bg-white/[0.04]" />
              <div className="h-3 w-3/5 rounded-full bg-white/[0.04]" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-[960px] rounded-[var(--radius-scent)] border border-red-500/20 bg-red-500/[0.055] p-6 text-center">
        <p className="text-sm font-medium text-red-100">
          {error instanceof Error ? error.message : 'Community feed is unavailable.'}
        </p>
      </div>
    );
  }

  if (posts.length === 0) {
    const hasActiveFilters = Boolean(filters.type || filters.tag || filters.q);
    const { title, body } = emptyStateCopy(filters);
    return (
      <div className="mx-auto w-full max-w-[960px] rounded-[var(--radius-scent)] border border-scent-accent/24 bg-black/58 px-6 py-14 text-center">
        <p className="font-serif text-2xl italic text-[#fff7ec]">{title}</p>
        <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-scent-text-muted">{body}</p>
        <div className="mt-6 flex justify-center">
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={onClearFilters}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-scent-accent/22 bg-black/58 px-5 py-2 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
            >
              <X size={15} strokeWidth={1.8} aria-hidden="true" />
              Clear filters
            </button>
          ) : (
            <button
              type="button"
              onClick={onStartRoom}
              className="scent-primary-button inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-scent)] px-6 py-3 text-sm font-bold uppercase tracking-[0.18em]"
            >
              <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>Start a room</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[960px] space-y-6" aria-busy={isRefetching || isFetchingNextPage}>
      {posts.map((post) => (
        <PostCard key={post.id} post={post} authToken={authToken} onSignIn={onSignIn} />
      ))}

      <div ref={loadMoreRef} className="flex min-h-16 items-center justify-center">
        {hasNextPage ? (
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-scent-accent/22 bg-black/58 px-5 py-2 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-55"
          >
            {isFetchingNextPage ? (
              <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
            ) : null}
            {isFetchingNextPage ? 'Loading' : 'Load more'}
          </button>
        ) : (
          <p className="scent-type-label">
            End of feed
          </p>
        )}
      </div>
    </div>
  );
};
