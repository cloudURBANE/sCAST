import React, { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Swords } from 'lucide-react';
import { AppTopNav } from '@/components/AppTopNav';
import { ArenaBattleStage } from '@/components/arena/ArenaBattleStage';
import { ArenaNextRail } from '@/components/arena/ArenaNextRail';
import { mapCommunityPostToArenaBattle } from '@/components/arena/arenaBattleMapper';
import { useCommunityBattleVote, useCommunityPosts } from '@/components/community/communityPosts';

interface ArenaPageProps {
  authToken: string | null;
  authEmail?: string | null;
  authPictureUrl?: string | null;
  authUsername?: string | null;
  onSignIn: () => void;
  onShare: () => void;
  onSignOut: () => void;
  onEditProfile: () => void;
}

export const ArenaPage: React.FC<ArenaPageProps> = ({
  authToken,
  authEmail,
  authPictureUrl,
  authUsername,
  onSignIn,
  onShare,
  onSignOut,
  onEditProfile,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingGuestVote, setPendingGuestVote] = useState<{ postId: string; choice: string } | null>(null);
  const [savingGuestVotePostId, setSavingGuestVotePostId] = useState<string | null>(null);
  const [guestVoteSaveError, setGuestVoteSaveError] = useState<{ postId: string; message: string } | null>(null);
  const guestVoteMutation = useCommunityBattleVote(authToken);
  const { data, isLoading, isError, error, refetch } = useCommunityPosts(
    { type: 'battle', limit: 6 },
    authToken,
  );

  const battles = useMemo(
    () =>
      data?.pages
        .flatMap((page) => page.posts)
        .map(mapCommunityPostToArenaBattle)
        .filter((battle): battle is NonNullable<typeof battle> => battle !== null) ?? [],
    [data],
  );
  const activeBattle = battles[activeIndex] ?? battles[0] ?? null;

  useEffect(() => {
    const previous = document.title;
    document.title = 'Arena - SCENTBEAM';
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (activeIndex >= battles.length) setActiveIndex(0);
  }, [activeIndex, battles.length]);

  useEffect(() => {
    if (!authToken || !pendingGuestVote) return;

    const vote = pendingGuestVote;
    setPendingGuestVote(null);
    setSavingGuestVotePostId(vote.postId);
    setGuestVoteSaveError(null);
    guestVoteMutation.mutate(vote, {
      onError: (err) => {
        setGuestVoteSaveError({
          postId: vote.postId,
          message: err instanceof Error ? err.message : 'Vote could not be saved.',
        });
      },
      onSettled: () => setSavingGuestVotePostId(null),
    });
  }, [authToken, guestVoteMutation, pendingGuestVote]);

  const selectBattle = (index: number) => {
    setActiveIndex(index);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const nextBattle = () => {
    if (battles.length <= 1) return;
    setActiveIndex((index) => (index + 1) % battles.length);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-[100svh] overflow-x-hidden pb-[calc(var(--bottomnav-h)+2rem)] md:pb-0">
      <div className="fixed inset-0 z-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(212,175,55,0.04),transparent_60%)]" aria-hidden="true" />
      <AppTopNav
        authToken={authToken}
        authEmail={authEmail}
        authPictureUrl={authPictureUrl}
        authUsername={authUsername}
        renderedRoute="arena"
        onSignIn={onSignIn}
        onShare={onShare}
        onSignOut={onSignOut}
        onEditProfile={onEditProfile}
      />

      <div style={{ height: 'var(--topbar-h)' }} />

      <main className="relative z-10 px-4 pt-8 sm:px-8 sm:pb-24 sm:pt-12">
        {isLoading ? (
          <div className="grid min-h-[62svh] place-items-center text-center">
            <div>
              <LoaderCircle className="mx-auto h-8 w-8 animate-spin text-scent-accent" aria-hidden="true" />
              <p className="mt-4 scent-type-label text-scent-accent/82">Loading arena</p>
            </div>
          </div>
        ) : isError ? (
          <div role="alert" className="mx-auto grid min-h-[62svh] max-w-xl place-items-center text-center">
            <div className="rounded-[var(--radius-scent)] border border-red-500/24 bg-red-500/[0.055] p-6">
              <p className="font-serif text-2xl text-red-100">Arena could not load.</p>
              <p className="mt-3 text-sm leading-6 text-red-100/82">
                {error instanceof Error ? error.message : 'Battle data is unavailable.'}
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-5 inline-flex min-h-11 items-center justify-center rounded-full border border-red-200/38 px-5 py-2 scent-type-chip text-red-100 transition-colors hover:border-red-200/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200/70"
              >
                Try again
              </button>
            </div>
          </div>
        ) : activeBattle ? (
          <>
            <ArenaBattleStage
              key={activeBattle.id}
              battle={activeBattle}
              authToken={authToken}
              hasMoreBattles={battles.length > 1}
              onSignIn={onSignIn}
              onNext={nextBattle}
              onGuestVoteQueued={setPendingGuestVote}
              externalVotePending={savingGuestVotePostId === activeBattle.id}
              externalErrorMessage={
                guestVoteSaveError?.postId === activeBattle.id ? guestVoteSaveError.message : null
              }
            />
            <ArenaNextRail battles={battles} activeId={activeBattle.id} onSelect={selectBattle} />
          </>
        ) : (
          <div className="mx-auto grid min-h-[62svh] max-w-2xl place-items-center text-center">
            <div className="rounded-[var(--radius-scent)] border border-scent-accent/24 bg-black/68 px-6 py-8 shadow-[inset_0_1px_0_rgba(255,236,183,0.06),0_18px_44px_-34px_rgba(0,0,0,0.9)] sm:py-10">
              <Swords className="mx-auto h-10 w-10 text-scent-accent" aria-hidden="true" />
              <p className="mt-5 font-serif text-3xl text-foreground">No battles are ready yet.</p>
              <p className="mx-auto mt-4 max-w-md text-base leading-7 text-scent-text-muted">
                Start a battle from Community with two catalog-backed fragrances and it will appear here.
              </p>
            </div>
          </div>
        )}
      </main>

      <footer className="relative z-10 border-t border-scent-accent/10 px-8 py-10 sm:py-12">
        <div className="mx-auto max-w-4xl space-y-4 text-center">
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

export default ArenaPage;
