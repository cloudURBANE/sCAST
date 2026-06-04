import React, { useEffect, useMemo, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import { PostCard } from '@/components/community/PostCard';
import {
  type CommunityPostFilters,
  useCommunityPosts,
} from '@/components/community/communityPosts';

interface CommunityFeedProps {
  filters: CommunityPostFilters;
  authToken: string | null;
  onSignIn: () => void;
}

export const CommunityFeed: React.FC<CommunityFeedProps> = ({ filters, authToken, onSignIn }) => {
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
      <div className="grid gap-4" aria-label="Loading community posts">
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="min-h-[13rem] rounded-[var(--radius-scent)] border border-scent-accent/12 bg-white/[0.025] p-5"
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
      <div className="rounded-[var(--radius-scent)] border border-red-500/20 bg-red-500/[0.055] p-6 text-center">
        <p className="text-sm font-medium text-red-100">
          {error instanceof Error ? error.message : 'Community feed is unavailable.'}
        </p>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="rounded-[var(--radius-scent)] border border-scent-accent/14 bg-white/[0.025] px-6 py-14 text-center">
        <p className="font-serif text-2xl italic text-[#fff7ec]">No rooms yet.</p>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-7 text-scent-muted/70">
          Start the first room or clear your filters.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5" aria-busy={isRefetching || isFetchingNextPage}>
      {posts.map((post) => (
        <PostCard key={post.id} post={post} authToken={authToken} onSignIn={onSignIn} />
      ))}

      <div ref={loadMoreRef} className="flex min-h-16 items-center justify-center">
        {hasNextPage ? (
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-scent-accent/22 bg-white/[0.025] px-5 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-scent-muted transition-colors hover:border-scent-accent/42 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-55"
          >
            {isFetchingNextPage ? (
              <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
            ) : null}
            {isFetchingNextPage ? 'Loading' : 'Load more'}
          </button>
        ) : (
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-scent-muted/48">
            End of feed
          </p>
        )}
      </div>
    </div>
  );
};
