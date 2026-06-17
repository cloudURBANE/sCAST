import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const composerRef = useRef<PostComposerHandle | null>(null);
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
    <div className="min-h-[100svh] relative overflow-x-hidden pb-[calc(var(--bottomnav-h)+2rem)] md:pb-0">
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

      <main className="relative z-10 mx-auto max-w-[1760px] px-4 sm:px-8 sm:pb-24">
        <div className="space-y-14 pt-9 sm:space-y-20 sm:pt-12">
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
          <section className="scent-deferred-section w-full space-y-5 sm:space-y-7" aria-label="Community forum">
            {communityBodyReady ? (
              <>
              <React.Suspense fallback={<CommunityPanelFallback />}>
                <div className="mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)-2px)] border border-scent-accent/18 bg-[linear-gradient(180deg,rgba(10,9,7,0.82),rgba(0,0,0,0.94))] shadow-[0_18px_44px_-34px_rgba(0,0,0,0.95),0_0_0_1px_rgba(212,175,55,0.045),inset_0_1px_0_rgba(255,236,183,0.05)]">
                  <PostComposer ref={composerRef} authToken={authToken} onSignIn={onSignIn} />
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
