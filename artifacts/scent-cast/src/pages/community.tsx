import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wind } from 'lucide-react';
import { AppTopNav } from '@/components/AppTopNav';
import { APP_BRAND_MARK } from '@/lib/appBrand';
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
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
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
  onSignIn,
  onShare,
  onSignOut,
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
        onSignIn={onSignIn}
        onShare={onShare}
        onSignOut={onSignOut}
      />

      <div style={{ height: 'var(--topbar-h)' }} />

      <main className="relative z-10 pb-24 px-4 sm:px-8 max-w-[1760px] mx-auto">
        <div className="space-y-16 pt-10 sm:space-y-24 sm:pt-14">
          <CommunityHero />
          <div className="flex items-center gap-4 text-center">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent via-scent-accent/30 to-scent-accent/10" aria-hidden="true" />
            <p className="shrink-0 text-[9px] uppercase tracking-[0.2em] text-scent-muted/80 sm:text-[11px] sm:tracking-[0.32em]">
              <span className="sm:hidden">Community vault</span>
              <span className="hidden sm:inline">Drifting through the community vault</span>
            </p>
            <span className="h-px flex-1 bg-gradient-to-r from-scent-accent/10 via-scent-accent/30 to-transparent" aria-hidden="true" />
          </div>
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
            <section className="mx-auto w-full max-w-[1180px] space-y-6 pt-1 sm:space-y-7" aria-label="Community forum">
              <PostComposer ref={composerRef} authToken={authToken} onSignIn={onSignIn} />
              <PostFilters
                type={postType}
                tag={postTag}
                q={postQuery}
                onTypeChange={setPostType}
                onTagChange={setPostTag}
                onQueryChange={setPostQuery}
              />
              <CommunityFeed
                filters={feedFilters}
                authToken={authToken}
                onSignIn={onSignIn}
                onStartRoom={() => composerRef.current?.open()}
                onClearFilters={clearCommunityFilters}
              />
            </section>
          ) : null}
        </div>
      </main>

      <footer className="relative z-10 border-t border-scent-accent/10 py-16 px-8 mt-24">
        <div className="max-w-[1400px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center gap-2 opacity-30">
            <Wind size={18} />
            <p className="font-serif font-bold italic tracking-tighter uppercase">{APP_BRAND_MARK}</p>
          </div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-scent-muted">&copy; 2026 Olfactory Intelligence Systems</p>
        </div>
      </footer>
    </div>
  );
};

export default CommunityPage;
