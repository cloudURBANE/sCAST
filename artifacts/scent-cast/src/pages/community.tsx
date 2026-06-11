import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppTopNav } from '@/components/AppTopNav';
import { CommunityHero } from '@/components/community/CommunityHero';
import { BottleMarquee } from '@/components/community/BottleMarquee';
import { useCommunityFragrances } from '@/components/community/communityData';
import { CommunityFeed } from '@/components/community/CommunityFeed';
import { PostComposer, type PostComposerHandle } from '@/components/community/PostComposer';
import { PostFilters } from '@/components/community/PostFilters';
import type { CommunityPostType } from '@/components/community/communityPosts';

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
    <div className="min-h-[100svh] relative overflow-x-hidden">
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

      <main className="relative z-10 mx-auto max-w-[1760px] px-4 pb-24 sm:px-8">
        <div className="space-y-14 pt-9 sm:space-y-20 sm:pt-12">
          <CommunityHero />
          <div className="scent-full-bleed">
            {communityBodyReady ? (
              <BottleMarquee items={data ?? []} loading={isLoading} isError={isError} />
            ) : (
              <section className="scent-community-marquee" aria-hidden="true">
                <div className="scent-community-marquee-group opacity-0">
                  <div className="scent-community-marquee-cell" />
                </div>
              </section>
            )}
          </div>
          {communityBodyReady ? (
            <section className="w-full space-y-5 sm:space-y-7" aria-label="Community forum">
              <div className="mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)-2px)] border border-scent-accent/18 bg-[linear-gradient(180deg,rgba(10,9,7,0.82),rgba(0,0,0,0.94))] shadow-[0_18px_44px_-34px_rgba(0,0,0,0.95),0_0_0_1px_rgba(212,175,55,0.045),inset_0_1px_0_rgba(255,236,183,0.05)]">
                <PostComposer ref={composerRef} authToken={authToken} onSignIn={onSignIn} />
                <PostFilters
                  type={postType}
                  tag={postTag}
                  q={postQuery}
                  onTypeChange={setPostType}
                  onTagChange={setPostTag}
                  onQueryChange={setPostQuery}
                />
              </div>
              <CommunityFeed
                filters={feedFilters}
                authToken={authToken}
                onSignIn={onSignIn}
                onStartRoom={(preset) => composerRef.current?.open(preset)}
                onClearFilters={clearCommunityFilters}
              />
            </section>
          ) : null}
        </div>
      </main>

      <footer className="relative z-10 border-t border-scent-accent/10 py-16 px-8 mt-24">
        <div className="max-w-[1400px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center opacity-30">
            <img
              src="/nav/scentbeam-nav-logo.png"
              srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
              alt="ScentBeam"
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
