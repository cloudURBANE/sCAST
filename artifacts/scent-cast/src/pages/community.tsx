import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { AppTopNav } from '@/components/AppTopNav';
import { CommunityHero } from '@/components/community/CommunityHero';
import { useCommunityFragrances } from '@/components/community/communityData';
import type { PostComposerHandle } from '@/components/community/PostComposer';
import type { CommunityPostType } from '@/components/community/communityPosts';

const BottleMarquee = React.lazy(() =>
  import('@/components/community/BottleMarquee').then((module) => ({ default: module.BottleMarquee })),
);
const CommunityFeed = React.lazy(() =>
  import('@/components/community/CommunityFeed').then((module) => ({ default: module.CommunityFeed })),
);
const PostComposer = React.lazy(() =>
  import('@/components/community/PostComposer').then((module) => ({ default: module.PostComposer })),
);
const PostFilters = React.lazy(() =>
  import('@/components/community/PostFilters').then((module) => ({ default: module.PostFilters })),
);

interface CommunityPageProps {
  authToken: string | null;
  authEmail?: string | null;
  authPictureUrl?: string | null;
  authUsername?: string | null;
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
  onEditProfile: () => void;
}

const COMMUNITY_BODY_WAKE_DELAY_MS = 640;

function CommunityPanelFallback() {
  return (
    <div className="mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)-2px)] border border-scent-accent/18 bg-black/46">
      <div className="min-h-[20rem] animate-pulse" />
    </div>
  );
}

function CommunityFeedFallback() {
  return (
    <div className="mx-auto grid w-full max-w-[940px] gap-4" aria-label="Loading community posts">
      {Array.from({ length: 12 }, (_, item) => (
        <div key={item} className="min-h-[15rem] rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/18 bg-black/46" />
      ))}
    </div>
  );
}

function CommunityMarqueeFallback() {
  return (
    <section className="scent-community-marquee" aria-hidden="true">
      <div className="scent-community-marquee-track opacity-0" data-marquee-ready="false">
        {Array.from({ length: 3 }, (_, copyIndex) => (
          <div className="scent-community-marquee-group" key={copyIndex}>
            {Array.from({ length: 8 }, (_, cellIndex) => (
              <div className="scent-community-marquee-cell" key={cellIndex} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function useAfterInitialRoutePaint() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    let firstFrame = 0;
    let secondFrame = 0;
    let settleTimer: number | null = null;
    let idleHandle: number | null = null;

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        settleTimer = window.setTimeout(() => {
          const scheduleIdle = window.requestIdleCallback as
            | ((callback: IdleRequestCallback, options?: IdleRequestOptions) => number)
            | undefined;

          if (scheduleIdle) {
            idleHandle = scheduleIdle(() => setReady(true), { timeout: 700 });
            return;
          }

          setReady(true);
        }, COMMUNITY_BODY_WAKE_DELAY_MS);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      if (settleTimer) window.clearTimeout(settleTimer);
      if (idleHandle !== null && window.cancelIdleCallback) window.cancelIdleCallback(idleHandle);
    };
  }, []);

  return ready;
}

export const CommunityPage: React.FC<CommunityPageProps> = ({
  authToken,
  authEmail,
  authPictureUrl,
  authUsername,
  onSignIn,
  onShare,
  onSignOut,
  onEditProfile,
}) => {
  const communityBodyReady = useAfterInitialRoutePaint();
  const { data, isLoading, isError } = useCommunityFragrances(communityBodyReady);
  const [postType, setPostType] = useState<CommunityPostType | null>(null);
  const [postTag, setPostTag] = useState<string | null>(null);
  const [postQuery, setPostQuery] = useState('');
  // The panel top is ONE toolbar with two mutually exclusive surfaces:
  // the composer (Start a room) and the search/filters panel. Only one can
  // own the panel body at a time; the toolbar reflects which is active.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const composerRef = useRef<PostComposerHandle | null>(null);
  const toggleSearch = useCallback(() => {
    setFiltersOpen((open) => {
      // Opening search retracts the composer; the open()/close() ref drives
      // PostComposer, which reports back through handleComposerOpenChange.
      if (!open) composerRef.current?.close();
      return !open;
    });
  }, []);
  const toggleComposer = useCallback(() => {
    // The compose control drives the same imperative handle the feed CTAs use,
    // so collapsed/expanded state stays single-sourced inside PostComposer.
    if (composerOpen) composerRef.current?.close();
    else composerRef.current?.open();
  }, [composerOpen]);
  const handleComposerOpenChange = useCallback((open: boolean) => {
    setComposerOpen(open);
    // When the composer expands, retract the search panel.
    if (open) setFiltersOpen(false);
  }, []);
  const clearCommunityFilters = useCallback(() => {
    setPostType(null);
    setPostTag(null);
    setPostQuery('');
  }, []);
  const feedFilters = useMemo(
    () => ({
      type: postType,
      tag: postTag,
      q: postQuery,
      limit: 12,
    }),
    [postType, postTag, postQuery],
  );

  useEffect(() => {
    const previous = document.title;
    document.title = 'Community - SCENTBEAM';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="min-h-[100svh] relative overflow-x-hidden pb-[calc(var(--bottomnav-h)+3rem)] md:pb-0">
      <AppTopNav
        authToken={authToken}
        authEmail={authEmail}
        authPictureUrl={authPictureUrl}
        authUsername={authUsername}
        renderedRoute="community"
        onSignIn={onSignIn}
        onShare={onShare}
        onSignOut={onSignOut}
        onEditProfile={onEditProfile}
      />

      <div style={{ height: 'var(--topbar-h)' }} />

      <main className="relative z-10 mx-auto max-w-[1760px] px-3 sm:px-8 sm:pb-24">
        <div className="space-y-5 pt-2 sm:space-y-20 sm:pt-12">
          <CommunityHero />
          <div className="scent-full-bleed">
            {communityBodyReady ? (
              <React.Suspense fallback={<CommunityMarqueeFallback />}>
                <BottleMarquee items={data ?? []} loading={isLoading} isError={isError} />
              </React.Suspense>
            ) : (
              <CommunityMarqueeFallback />
            )}
          </div>
          <section className="scent-deferred-section w-full space-y-3 pb-[calc(var(--bottomnav-h)+2rem)] sm:space-y-7 sm:pb-0" aria-label="Community forum">
            {communityBodyReady ? (
              <>
              <React.Suspense fallback={<CommunityPanelFallback />}>
                <div className="mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)-2px)] border border-scent-accent/14 bg-[linear-gradient(180deg,rgba(10,9,7,0.76),rgba(0,0,0,0.92))] shadow-[0_14px_36px_-32px_rgba(0,0,0,0.95),0_0_0_1px_rgba(212,175,55,0.035),inset_0_1px_0_rgba(255,236,183,0.04)]">
                  {/* ONE deliberate toolbar: compose on the left, search/filter on
                      the right. The two are mutually exclusive — opening either
                      retracts the other — so this never reads as duplicate UI. */}
                  <div
                    className={[
                      'flex items-center justify-between gap-2 px-2.5 py-1.5 sm:px-4 sm:py-2.5',
                      // Only draw the divider when a surface is expanded beneath
                      // the toolbar, so the resting state reads as one clean bar.
                      composerOpen || filtersOpen ? 'border-b border-scent-accent/10' : '',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      onClick={toggleComposer}
                      aria-expanded={composerOpen}
                      aria-controls="community-composer-panel"
                      aria-label={composerOpen ? 'Close the composer' : 'Start a community room'}
                      className={[
                        'inline-flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-full border px-3 py-1.5 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 sm:min-h-10 sm:flex-none sm:px-4 sm:py-2',
                        composerOpen
                          ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-[#fff7ec]'
                          : 'border-scent-accent/24 bg-black/40 text-scent-text-muted hover:border-scent-accent/46 hover:text-[#fff7ec]',
                      ].join(' ')}
                    >
                      {composerOpen ? (
                        <X size={15} strokeWidth={1.8} aria-hidden="true" />
                      ) : (
                        <Plus size={15} strokeWidth={2} aria-hidden="true" />
                      )}
                      <span className="truncate">{composerOpen ? 'Close' : 'Start a room'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={toggleSearch}
                      aria-expanded={filtersOpen}
                      aria-controls="community-search-panel"
                      aria-label={filtersOpen ? 'Close search and filters' : 'Search rooms and filter'}
                      className={[
                        'inline-flex min-h-8 shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 scent-type-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 sm:min-h-10 sm:px-4 sm:py-2',
                        filtersOpen
                          ? 'border-scent-accent/48 bg-scent-accent/[0.08] text-[#fff7ec]'
                          : 'border-scent-accent/24 bg-black/40 text-scent-text-muted hover:border-scent-accent/46 hover:text-[#fff7ec]',
                      ].join(' ')}
                    >
                      {filtersOpen ? (
                        <X size={15} strokeWidth={1.8} aria-hidden="true" />
                      ) : (
                        <Search size={15} strokeWidth={1.8} aria-hidden="true" />
                      )}
                      <span>{filtersOpen ? 'Close' : 'Search'}</span>
                    </button>
                  </div>
                  {/* PostComposer stays mounted so the feed's "start a room"
                      CTA can drive it via the ref; it renders nothing in its
                      collapsed state (the toolbar owns the trigger) and is
                      hidden while the search panel owns the surface. */}
                  <div id="community-composer-panel" className={filtersOpen ? 'hidden' : undefined}>
                    <PostComposer
                      ref={composerRef}
                      authToken={authToken}
                      onSignIn={onSignIn}
                      onOpenChange={handleComposerOpenChange}
                    />
                  </div>
                  {filtersOpen ? (
                    <div id="community-search-panel">
                      <PostFilters
                        type={postType}
                        tag={postTag}
                        q={postQuery}
                        authToken={authToken}
                        onTypeChange={setPostType}
                        onTagChange={setPostTag}
                        onQueryChange={setPostQuery}
                      />
                    </div>
                  ) : null}
                </div>
              </React.Suspense>
              <React.Suspense fallback={<CommunityFeedFallback />}>
                <CommunityFeed
                  filters={feedFilters}
                  authToken={authToken}
                  onSignIn={onSignIn}
                  onStartRoom={(preset) => composerRef.current?.open(preset)}
                  onClearFilters={clearCommunityFilters}
                />
              </React.Suspense>
              </>
            ) : (
              <>
                <CommunityPanelFallback />
                <CommunityFeedFallback />
              </>
            )}
          </section>
        </div>
      </main>

      <footer className="relative z-10 border-t border-scent-accent/10 py-16 px-8 mt-24">
        <div className="max-w-[1400px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center opacity-30">
            <img
              src="/nav/scentbeam-nav-logo.png"
              srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
              alt="ScentBeam"
              width={69}
              height={20}
              className="h-5 w-auto"
              draggable={false}
            />
          </div>
          <p className="scent-type-label">&copy; 2026 Olfactory Intelligence Systems</p>
        </div>
      </footer>
    </div>
  );
};

export default CommunityPage;
