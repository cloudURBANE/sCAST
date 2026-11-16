import React, { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Swords } from 'lucide-react';
import { AppTopNav } from '@/components/AppTopNav';
import { AppFooter } from '@/components/AppFooter';
import { BottleImage } from '@/components/BottleImage';
import { ArenaBattleStage } from '@/components/arena/ArenaBattleStage';
import { ArenaNextRail } from '@/components/arena/ArenaNextRail';
import { mapCommunityPostToArenaBattle } from '@/components/arena/arenaBattleMapper';
import { useCommunityBattleVote, useCommunityPosts } from '@/components/community/communityPosts';
import { useWardrobeItems } from '@/context/WardrobeContext';

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
  const savedFragrances = useWardrobeItems();
  const previewFragrances = savedFragrances.filter((item) => item.name && item.brand).slice(0, 2);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingGuestVote, setPendingGuestVote] = useState<{
    postId: string;
    choice: string;
    // Preserved through login so a guest's "why it won" reason isn't lost when
    // the queued vote is replayed after auth. Optional for backward compatibility
    // with votes queued before a reason was captured.
    reason?: string | null;
  } | null>(null);
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
      {/* Accent wash resolves through the accent token so data-accent="green"
          tints this page the same way it tints the rest of the app. */}
      <div className="fixed inset-0 z-0 bg-[radial-gradient(ellipse_at_50%_0%,rgb(var(--scent-accent-rgb)/0.04),transparent_60%)]" aria-hidden="true" />
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
        ) : isError && battles.length === 0 ? (
          <section className="mx-auto w-full max-w-5xl py-2 sm:py-6" aria-labelledby="arena-preview-title">
            <div role="status" className="mb-5 rounded-2xl border border-scent-accent/20 bg-scent-surface/35 px-4 py-3 text-center text-sm text-scent-text-muted sm:mb-7 sm:px-6">
              Live community battles are temporarily unavailable. Your saved fragrances are still here to preview.
            </div>
            {previewFragrances.length >= 2 ? (
              <div className="overflow-hidden rounded-[calc(var(--radius-scent)+4px)] border border-scent-accent/28 bg-[radial-gradient(ellipse_at_50%_0%,rgb(var(--scent-accent-rgb)/0.1),transparent_64%),#050403] p-4 shadow-[inset_0_1px_0_rgba(255,236,183,0.06),0_28px_70px_-46px_rgba(0,0,0,0.95)] sm:p-8">
                <div className="mx-auto max-w-2xl text-center">
                  <p className="scent-type-label text-scent-accent">Your vault · head to head</p>
                  <h1 id="arena-preview-title" className="mt-2 font-serif text-3xl text-foreground sm:text-5xl">A matchup, ready when you are.</h1>
                  <p className="mt-3 text-sm leading-6 text-scent-text-muted sm:text-base">A preview built from the first two fragrances saved in your personal vault.</p>
                </div>
                <div className="mx-auto mt-6 grid max-w-4xl grid-cols-2 gap-3 sm:mt-9 sm:gap-6">
                  {previewFragrances.map((item, index) => (
                    <article key={item.id} className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-black/35 p-2.5 sm:rounded-3xl sm:p-5">
                      <div className="relative aspect-[0.9] overflow-hidden rounded-xl bg-[radial-gradient(ellipse_at_50%_68%,rgb(var(--scent-accent-rgb)/0.1),transparent_64%)] sm:rounded-2xl">
                        <BottleImage src={item.imageUrl} alt={`${item.name} by ${item.brand}`} variant="card" className="absolute inset-2 sm:inset-4" imgClassName="brightness-[1.08] drop-shadow-[0_22px_28px_rgba(0,0,0,0.62)]" loading="eager" />
                        <span className="absolute left-2 top-2 rounded-full border border-scent-accent/25 bg-black/75 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-scent-accent sm:left-3 sm:top-3 sm:text-[10px]">{index === 0 ? 'Contender A' : 'Contender B'}</span>
                      </div>
                      <p className="mt-3 truncate text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-scent-accent/90 sm:mt-5 sm:text-xs">{item.brand}</p>
                      <h2 className="mt-1 line-clamp-2 min-h-[2.5rem] text-balance text-center font-serif text-base leading-tight text-foreground sm:min-h-[3.5rem] sm:text-2xl">{item.name}</h2>
                      {item.family ? <p className="mt-1 line-clamp-1 text-center text-xs text-scent-text-muted sm:text-sm">{item.family}</p> : null}
                    </article>
                  ))}
                </div>
                <p className="mt-5 text-center text-xs text-scent-text-muted sm:mt-7 sm:text-sm">This is a visual preview; voting and community totals return when the live service is back.</p>
              </div>
            ) : (
              <div className="mx-auto max-w-2xl rounded-2xl border border-scent-accent/20 bg-scent-surface/40 px-6 py-10 text-center">
                <Swords className="mx-auto h-9 w-9 text-scent-accent" aria-hidden="true" />
                <h1 id="arena-preview-title" className="mt-4 font-serif text-2xl text-foreground sm:text-3xl">Your matchup will appear here.</h1>
                <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-scent-text-muted">Save at least two fragrances in your vault to see a personal Arena preview while live battles are unavailable.</p>
                <a href="/" className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full border border-scent-accent/30 px-5 text-sm font-semibold text-scent-accent transition-colors hover:bg-scent-accent/10">Open your vault</a>
              </div>
            )}
          </section>
        ) : isError ? (
          <div role="alert" className="mx-auto grid min-h-[62svh] max-w-xl place-items-center text-center">
            <div className="scent-error-panel rounded-[var(--radius-scent)] border p-6">
              <p className="font-serif text-2xl">Arena could not load.</p>
              <p className="scent-error-body mt-3 text-sm leading-6">
                {error instanceof Error ? error.message : 'Battle data is unavailable.'}
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="scent-error-action mt-5 inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 scent-type-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
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
            <div className="rounded-[var(--radius-scent)] border border-scent-accent/24 bg-scent-surface/68 px-6 py-8 shadow-[inset_0_1px_0_rgba(255,236,183,0.06),0_18px_44px_-34px_rgba(0,0,0,0.9)] sm:py-10">
              <Swords className="mx-auto h-10 w-10 text-scent-accent" aria-hidden="true" />
              <p className="mt-5 font-serif text-3xl text-foreground">No battles are ready yet.</p>
              <p className="mx-auto mt-4 max-w-md text-base leading-7 text-scent-text-muted">
                Start a battle from Community with two catalog-backed fragrances and it will appear here.
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Shared chrome footer — same wordmark + legal links + dynamic year as
          Home and the legal pages, replacing this page's ad-hoc copy (which
          carried a hardcoded year and no legal links). */}
      <AppFooter />
    </div>
  );
};

export default ArenaPage;
