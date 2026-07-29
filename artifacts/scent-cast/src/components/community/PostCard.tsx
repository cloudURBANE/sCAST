import React, { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BadgeDollarSign,
  Bot,
  ChevronDown,
  ChevronUp,
  Crown,
  FlaskConical,
  MessageCircle,
  MessageCircleQuestion,
  Sparkles,
  Sun,
  Swords,
  type LucideIcon,
} from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import { CommentThread } from '@/components/community/CommentThread';
import { CommunityAuthorAvatar } from '@/components/community/CommunityAuthorAvatar';
import { ReactionBar } from '@/components/community/ReactionBar';
import {
  type CommunityPost,
  type CommunityFragranceSnapshot,
  type CommunityPostType,
  useCommunityBattleVote,
} from '@/components/community/communityPosts';
import {
  communitySharePath,
  displayCommunityAuthor,
  formatCommunityTime,
} from '@/components/community/communityFormat';

interface PostTypeDetail {
  label: string;
  Icon: LucideIcon;
}

const POST_TYPE_DETAILS: Record<CommunityPostType, PostTypeDetail> = {
  question: { label: 'Question', Icon: MessageCircleQuestion },
  sotd: { label: 'SOTD', Icon: Sun },
  battle: { label: 'Battle', Icon: Swords },
  worth_it: { label: 'Price Check', Icon: BadgeDollarSign },
};

interface PostCardProps {
  post: CommunityPost;
  authToken: string | null;
  onSignIn: () => void;
}

function metadataString(post: CommunityPost, key: string): string | null {
  const value = post.metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function battleOptions(post: CommunityPost): string[] {
  const options = post.metadata.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => (typeof option === 'string' ? option.trim() : ''))
    .filter(Boolean)
    .slice(0, 2);
}

function isAllowedSnapshotImage(imageUrl: string | undefined): boolean {
  const trimmed = imageUrl?.trim();
  if (!trimmed) return false;
  return !trimmed.toLowerCase().startsWith('data:');
}

const OrnamentalDivider: React.FC<{ className?: string }> = ({
  className = '',
}) => (
  <div
    className={[
      'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3',
      className,
    ].join(' ')}
    aria-hidden="true"
  >
    <span className="h-px min-w-0 bg-scent-accent/24" />
    <span className="h-1.5 w-1.5 rounded-full bg-scent-accent/70" />
    <span className="h-px min-w-0 bg-scent-accent/24" />
  </div>
);

const FragranceShowcase: React.FC<{ post: CommunityPost }> = ({ post }) => {
  const fragrances = post.fragrances.filter((fragrance) =>
    isAllowedSnapshotImage(fragrance.imageUrl),
  );
  if (fragrances.length === 0) return null;

  return (
    <div className="mt-4 grid w-full max-w-[46rem] gap-3 sm:mt-6">
      {fragrances.map((fragrance) => (
        <div
          key={`${fragrance.brand}:${fragrance.name}:${fragrance.imageUrl}`}
          className="grid min-h-36 grid-cols-[7.5rem_minmax(0,1fr)] overflow-hidden rounded-[16px] border border-scent-accent/24 bg-black/72 sm:min-h-[14rem] sm:grid-cols-[minmax(10rem,0.95fr)_1px_minmax(0,1.05fr)] sm:rounded-[20px]"
        >
          <div className="relative min-h-36 sm:min-h-[14rem]">
            {/* Route bottle imagery through BottleImage so this scrolling
                community surface honors the render budget (no high-DPI video on
                low-budget devices) and gets retry / proxy-fallback / shelf-line
                framing — instead of a bare <img> with fixed pixel heights. */}
            <BottleImage
              src={fragrance.imageUrl}
              alt={`${fragrance.name} by ${fragrance.brand}`}
              variant="featured"
              className="absolute inset-0 z-10"
              loading="lazy"
            />
          </div>
          <span
            className="hidden h-full w-px bg-scent-accent/24 sm:block"
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-col justify-center border-l border-scent-accent/16 p-3 text-left sm:border-l-0 sm:border-t-0 sm:p-7">
            <p className="break-words font-serif text-base italic leading-tight text-foreground sm:text-3xl">
              {fragrance.name}
            </p>
            <p className="mt-1.5 break-words text-xs font-black uppercase leading-tight tracking-[0.1em] text-foreground sm:mt-4 sm:text-3xl sm:tracking-[0.12em]">
              {fragrance.brand}
            </p>
            <div
              className="mt-3 h-px w-16 max-w-full bg-scent-accent/55 sm:mt-4 sm:w-28"
              aria-hidden="true"
            />
            {fragrance.family ? (
              <div className="mt-3 flex items-center gap-2 text-scent-text-muted sm:mt-5 sm:gap-3">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-scent-accent/28 bg-black/52 text-scent-accent sm:h-10 sm:w-10">
                  <FlaskConical
                    size={16}
                    strokeWidth={1.65}
                    aria-hidden="true"
                  />
                </span>
                <p className="min-w-0 break-words text-xs font-medium leading-4 sm:text-base sm:leading-6">
                  {fragrance.family}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
};

const PostActionsFooter: React.FC<{
  post: CommunityPost;
  authToken: string | null;
  onSignIn: () => void;
  commentsOpen: boolean;
  onToggleComments: () => void;
}> = ({ post, authToken, onSignIn, commentsOpen, onToggleComments }) => (
  <footer className="mt-4 flex flex-row items-center justify-between gap-4 border-t border-scent-accent/10 pt-3">
    <h4 className="sr-only">Post actions</h4>
    <div className="flex flex-1 justify-start">
      <ReactionBar
        targetType="post"
        targetId={post.id}
        counts={post.counts.reactions}
        viewerReactions={post.viewerReactions}
        authToken={authToken}
        onSignIn={onSignIn}
        compact={true}
      />
    </div>
    <button
      type="button"
      onClick={onToggleComments}
      className="scent-no-mobile-focus-ring flex min-h-9 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:bg-white/[0.045] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/60"
      aria-expanded={commentsOpen}
      aria-label={
        commentsOpen
          ? 'Hide comments'
          : `View ${post.counts.comments} comments`
      }
    >
      <MessageCircle size={15} strokeWidth={1.75} aria-hidden="true" />
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] sm:text-xs">
        {post.counts.comments > 0 ? `${post.counts.comments}` : 'Comment'}
      </span>
      {commentsOpen ? (
        <ChevronUp size={13} strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
      )}
    </button>
  </footer>
);

const CompactBattlePostCard: React.FC<PostCardProps> = ({
  post,
  authToken,
  onSignIn,
}) => {
  const headingId = useId();
  const authorName = displayCommunityAuthor(post.author);
  // No fallback heading: the swords badge already names the type, so a serif
  // "Battle" title next to it read as the same word twice. Untitled battles
  // lead with their body text instead.
  const title = post.title?.trim() || null;
  const options = battleOptions(post);
  const [optionA, optionB] = options;
  const votesA = optionA ? post.votes[optionA] ?? 0 : 0;
  const votesB = optionB ? post.votes[optionB] ?? 0 : 0;
  const totalVotes = votesA + votesB;
  // A battle is a versus format: both contenders render, each with its own
  // share bar, so the card never claims "100%" against an invisible opponent.
  // The crown marks the leader only when someone is actually ahead.
  const leaderLabel =
    options.length < 2 || totalVotes === 0 || votesA === votesB
      ? null
      : votesA > votesB
        ? optionA
        : optionB;

  return (
    <article
      aria-labelledby={title ? headingId : undefined}
      aria-label={title ? undefined : `Battle by ${authorName}`}
      className="scent-night-panel mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/34 bg-[#050403] p-4 text-left shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] sm:p-6"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <Link
            to={communitySharePath(post.author)}
            aria-label={`View ${authorName}'s vault`}
            className="shrink-0 rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70"
          >
            <CommunityAuthorAvatar author={post.author} size="responsive-lg" />
          </Link>
          <div className="min-w-0">
            <Link
              to={communitySharePath(post.author)}
              className="block min-w-0 max-w-full truncate scent-type-chip text-xs text-foreground transition-colors hover:text-scent-accent sm:text-sm"
            >
              {authorName}
            </Link>
            <p className="mt-1 scent-type-meta text-[11px] uppercase text-scent-muted sm:mt-1.5 sm:text-xs">
              {formatCommunityTime(post.createdAt)}
            </p>
          </div>
        </div>
        <span
          role="img"
          aria-label="Battle"
          title="Battle"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/38 bg-scent-accent/[0.075] text-scent-accent shadow-[inset_0_1px_0_rgba(255,236,183,0.055)] sm:h-11 sm:w-11"
        >
          <Swords size={17} strokeWidth={1.75} aria-hidden="true" />
        </span>
      </header>

      <div className="mt-3 min-w-0 max-w-[48rem] sm:mt-5">
        {title ? (
          <h3
            id={headingId}
            className="break-words text-balance font-serif text-xl italic leading-[1.08] text-foreground sm:text-3xl"
          >
            {title}
          </h3>
        ) : null}
        {post.body ? (
          <p
            className={
              title
                ? 'mt-1.5 line-clamp-2 whitespace-pre-line break-words text-xs leading-4 text-foreground/68 sm:mt-2 sm:text-base sm:leading-6'
                : 'line-clamp-2 whitespace-pre-line break-words text-sm leading-5 text-foreground/86 sm:text-lg sm:leading-7'
            }
          >
            {post.body}
          </p>
        ) : null}
      </div>

      {options.length === 2 ? (
        // Head-to-head standing: both contenders, each with its own share bar.
        // The leader's bar carries the stronger gold and the crown; the trailer
        // recedes. Voting itself still lives in the arena.
        <div className="mt-3.5 w-full max-w-[48rem] space-y-2.5 sm:mt-5">
          {options.map((option) => {
            const count = post.votes[option] ?? 0;
            const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
            const isLeader = leaderLabel === option;
            return (
              <div key={option} className="min-w-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="flex min-w-0 items-center gap-1.5 font-serif text-base italic leading-tight text-foreground sm:text-lg">
                    <span className="min-w-0 truncate" title={option}>
                      {option}
                    </span>
                    {isLeader ? (
                      <Crown
                        size={14}
                        strokeWidth={1.8}
                        className="shrink-0 text-scent-accent"
                        aria-hidden="true"
                      />
                    ) : null}
                  </p>
                  <p className="shrink-0 scent-type-meta text-[11px] uppercase text-scent-text-muted sm:text-xs">
                    {totalVotes > 0 ? `${pct}%` : '·'}
                  </p>
                </div>
                <div
                  className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/60"
                  role="img"
                  aria-label={`${option}: ${count} ${count === 1 ? 'vote' : 'votes'}`}
                >
                  <span
                    className={[
                      'block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
                      isLeader ? 'bg-scent-accent/75' : 'bg-scent-accent/35',
                    ].join(' ')}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
          <p className="scent-type-meta text-[11px] uppercase text-scent-text-muted/85">
            {totalVotes === 0
              ? 'No votes yet — cast the first'
              : `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'}`}
          </p>
        </div>
      ) : null}

      {/* Compact footer: the heart reaction sits opposite "Open arena", which is
          the card's single call to action (it replaces the standalone arena row
          and the comment toggle for this glanceable battle surface). */}
      <footer className="mt-3 flex flex-row items-center justify-between gap-4 border-t border-scent-accent/10 pt-3 sm:mt-4">
        <h4 className="sr-only">Post actions</h4>
        <div className="flex flex-1 justify-start">
          <ReactionBar
            targetType="post"
            targetId={post.id}
            counts={post.counts.reactions}
            viewerReactions={post.viewerReactions}
            authToken={authToken}
            onSignIn={onSignIn}
            compact={true}
          />
        </div>
        <Link
          to="/arena"
          className="scent-no-mobile-focus-ring inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-scent-accent/55 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-scent-accent transition-colors hover:border-scent-accent/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/60 sm:min-h-10 sm:px-5 sm:py-2 sm:text-xs"
        >
          <span>Open arena</span>
          <ArrowRight size={14} strokeWidth={1.8} aria-hidden="true" />
        </Link>
      </footer>
    </article>
  );
};

const CompactQuestionPostCard: React.FC<PostCardProps> = ({
  post,
  authToken,
  onSignIn,
}) => {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const headingId = useId();
  const authorName = displayCommunityAuthor(post.author);
  // No fallback heading: the badge in the header already says "Question", so a
  // large serif "Question" title directly under it was the same word twice.
  // Untitled questions lead with the question text itself.
  const title = post.title?.trim() || null;

  return (
    <article
      aria-labelledby={title ? headingId : undefined}
      aria-label={title ? undefined : `Question by ${authorName}`}
      className="scent-night-panel mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/34 bg-[#050403] p-4 text-left sm:p-6"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={communitySharePath(post.author)}
            aria-label={`View ${authorName}'s vault`}
            className="shrink-0 rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70"
          >
            <CommunityAuthorAvatar author={post.author} size="md" />
          </Link>
          <div className="min-w-0">
            <Link
              to={communitySharePath(post.author)}
              className="block min-w-0 max-w-full truncate scent-type-chip text-[12px] text-foreground transition-colors hover:text-scent-accent"
            >
              {authorName}
            </Link>
            <p className="mt-1 scent-type-meta text-[11px] uppercase text-scent-muted">
              {formatCommunityTime(post.createdAt)}
            </p>
          </div>
        </div>
        <span className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-full bg-scent-accent/[0.075] px-3 py-1.5 scent-type-chip text-[11px] text-scent-accent shadow-[inset_0_0_0_1px_rgba(212,175,55,0.18)]">
          <MessageCircleQuestion size={15} strokeWidth={1.75} aria-hidden="true" />
          Question
        </span>
      </header>

      <div className="mt-4 min-w-0">
        {title ? (
          <h3
            id={headingId}
            className="break-words text-balance font-serif text-2xl italic leading-tight text-foreground sm:text-3xl"
          >
            {title}
          </h3>
        ) : null}
        {post.body ? (
          <p
            className={
              title
                ? 'mt-2 max-w-2xl whitespace-pre-line break-words text-sm leading-6 text-foreground/76 sm:text-[15px]'
                : 'max-w-2xl whitespace-pre-line break-words text-[15px] leading-6 text-foreground/90 sm:text-base sm:leading-7'
            }
          >
            {post.body}
          </p>
        ) : null}
      </div>

      {post.tags.length > 0 ? (
        <div className="mt-4 flex min-w-0 flex-wrap justify-start gap-2">
          {post.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="max-w-full rounded-full border border-scent-accent/16 bg-black/48 px-2.5 py-1 scent-type-chip text-[11px] text-scent-text-muted"
            >
              #{tag}
            </span>
          ))}
        </div>
      ) : null}

      <PostActionsFooter
        post={post}
        authToken={authToken}
        onSignIn={onSignIn}
        commentsOpen={commentsOpen}
        onToggleComments={() => setCommentsOpen((open) => !open)}
      />

      {commentsOpen ? (
        <CommentThread
          postId={post.id}
          authToken={authToken}
          onSignIn={onSignIn}
        />
      ) : null}
    </article>
  );
};

const MetadataLine: React.FC<{ post: CommunityPost }> = ({ post }) => {
  if (post.postType === 'sotd') {
    const items = [
      ['Weather', metadataString(post, 'weather')],
      ['Occasion', metadataString(post, 'occasion')],
      ['Mood', metadataString(post, 'mood')],
    ].filter((item): item is [string, string] => Boolean(item[1]));

    if (items.length === 0) return null;
    return (
      <div className="mt-5 flex max-w-3xl flex-wrap justify-start gap-2">
        {items.map(([label, value]) => (
          <span
            key={label}
            className="rounded-full border border-scent-accent/16 bg-black/54 px-3 py-1 scent-type-meta"
          >
            <span className="font-bold uppercase tracking-[0.12em] text-scent-accent">
              {label}
            </span>
            <span className="ml-2 text-foreground/78">{value}</span>
          </span>
        ))}
      </div>
    );
  }

  if (post.postType === 'worth_it') {
    const priceContext =
      metadataString(post, 'price_context') ??
      metadataString(post, 'priceContext');
    if (!priceContext) return null;
    return (
      <p className="mt-5 max-w-2xl rounded-[16px] border border-scent-accent/18 bg-black/62 px-4 py-3 text-left text-sm leading-6 text-foreground/82">
        <span className="font-bold uppercase tracking-[0.14em] text-scent-accent">
          Price context
        </span>
        <span className="ml-2">{priceContext}</span>
      </p>
    );
  }

  return null;
};

const BattleVotes: React.FC<{
  post: CommunityPost;
  authToken: string | null;
  onSignIn: () => void;
}> = ({ post, authToken, onSignIn }) => {
  const voteMutation = useCommunityBattleVote(authToken);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Replay a tap made while logged out, once the viewer signs in.
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);
  const options = battleOptions(post);
  const totalVotes = useMemo(
    () => options.reduce((sum, option) => sum + (post.votes[option] ?? 0), 0),
    [options, post.votes],
  );
  const hasVoted = Boolean(post.viewerVote);
  const { mutate } = voteMutation;

  useEffect(() => {
    if (!authToken || !pendingChoice) return;
    const choice = pendingChoice;
    setPendingChoice(null);
    setErrorMessage(null);
    mutate(
      { postId: post.id, choice },
      {
        onError: (err) =>
          setErrorMessage(
            err instanceof Error ? err.message : 'Vote could not be saved.',
          ),
      },
    );
  }, [authToken, pendingChoice, mutate, post.id]);

  if (options.length !== 2) return null;

  const submitVote = (choice: string) => {
    if (!authToken) {
      setPendingChoice(choice);
      onSignIn();
      return;
    }
    setErrorMessage(null);
    voteMutation.mutate(
      { postId: post.id, choice },
      {
        onError: (err) => {
          setErrorMessage(
            err instanceof Error ? err.message : 'Vote could not be saved.',
          );
        },
      },
    );
  };

  return (
    <div className="mt-6 max-w-2xl space-y-3" aria-live="polite">
      {options.map((option) => {
        const count = post.votes[option] ?? 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const picked = post.viewerVote === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => submitVote(option)}
            disabled={voteMutation.isPending}
            aria-pressed={picked}
            aria-label={
              hasVoted
                ? `Vote for ${option} - currently ${pct}% with ${count} ${count === 1 ? 'vote' : 'votes'}`
                : `Vote for ${option}`
            }
            className={[
              'group relative w-full overflow-hidden rounded-[16px] border px-4 py-3 text-left transition-colors hover:border-scent-accent/38 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80 disabled:pointer-events-none disabled:opacity-55',
              picked
                ? 'border-scent-accent/55 bg-scent-accent/[0.06]'
                : 'border-scent-accent/16 bg-black/58',
            ].join(' ')}
          >
            <span
              className={[
                'absolute inset-y-0 left-0 transition-[width]',
                picked ? 'bg-scent-accent/[0.16]' : 'bg-scent-accent/[0.075]',
              ].join(' ')}
              style={{ width: `${pct}%` }}
              aria-hidden="true"
            />
            <span className="relative z-10 flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate font-serif text-lg italic text-foreground">
                  {option}
                </span>
                {picked ? (
                  <span className="shrink-0 rounded-full border border-scent-accent/40 bg-scent-accent/[0.1] px-2 py-0.5 scent-type-meta uppercase text-scent-accent">
                    Your pick
                  </span>
                ) : null}
              </span>
              {/* Once the viewer has voted the tally reads as results. */}
              <span className="shrink-0 font-mono text-[13px] text-scent-accent">
                {hasVoted ? `${pct}% (${count})` : `${count}`}
              </span>
            </span>
          </button>
        );
      })}
      {errorMessage ? (
        <p role="alert" className="text-sm text-red-100">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
};

const TOM_FORD_OUD_WOOD_VIDEO = '/beta/tom-ford-oud-wood.mp4';

function featuredSotdFragrance(post: CommunityPost): CommunityFragranceSnapshot | null {
  return (
    post.fragrances.find((fragrance) =>
      isAllowedSnapshotImage(fragrance.imageUrl),
    ) ??
    post.fragrances[0] ??
    null
  );
}

function isTomFordOudWood(fragrance: CommunityFragranceSnapshot | null): boolean {
  if (!fragrance) return false;
  const brand = fragrance.brand.trim().toLowerCase();
  const name = fragrance.name.trim().toLowerCase();
  return brand === 'tom ford' && name.includes('oud wood');
}

function sotdFragments(post: CommunityPost, fragrance: CommunityFragranceSnapshot | null): string[] {
  const metadataFragments = post.metadata.fragments;
  if (Array.isArray(metadataFragments)) {
    const fragments = metadataFragments
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
      .slice(0, 4);
    if (fragments.length > 0) return fragments;
  }

  if (isTomFordOudWood(fragrance)) {
    return ['polished oud', 'cardamom', 'sandalwood', 'amber'];
  }

  return [
    fragrance?.family,
    metadataString(post, 'mood'),
    metadataString(post, 'occasion'),
    post.tags[0],
  ]
    .filter((item): item is string => Boolean(item))
    .slice(0, 4);
}

const ScentOfDayPostCard: React.FC<PostCardProps> = ({
  post,
  authToken,
  onSignIn,
}) => {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const headingId = useId();
  const authorName = displayCommunityAuthor(post.author);
  const fragrance = featuredSotdFragrance(post);
  const heading = fragrance?.name || post.title?.trim() || 'Scent of the day';
  const brand = fragrance?.brand || 'Beam Agent';
  const fragments = sotdFragments(post, fragrance);
  const videoSrc = isTomFordOudWood(fragrance) ? TOM_FORD_OUD_WOOD_VIDEO : null;

  return (
    <article
      aria-labelledby={headingId}
      className="scent-night-panel mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/34 bg-[#050403] p-4 text-left sm:p-6"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={communitySharePath(post.author)}
            aria-label={`View ${authorName}'s vault`}
            className="shrink-0 rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70"
          >
            <CommunityAuthorAvatar author={post.author} size="md" />
          </Link>
          <div className="min-w-0">
            <Link
              to={communitySharePath(post.author)}
              className="block min-w-0 max-w-full truncate scent-type-chip text-[12px] text-foreground transition-colors hover:text-scent-accent"
            >
              {authorName}
            </Link>
            <p className="mt-1 scent-type-meta text-[11px] uppercase text-scent-muted">
              {formatCommunityTime(post.createdAt)}
            </p>
          </div>
        </div>
        <span className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-full bg-scent-accent/[0.075] px-3 py-1.5 scent-type-chip text-[11px] text-scent-accent shadow-[inset_0_0_0_1px_rgba(212,175,55,0.18)]">
          <Sun size={15} strokeWidth={1.75} aria-hidden="true" />
          SOTD
        </span>
      </header>

      <div className="mt-4 grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3 sm:mt-5 sm:grid-cols-[minmax(13rem,0.82fr)_minmax(0,1fr)] sm:items-stretch sm:gap-5">
        <div className="min-w-0">
          {/* When a black-mastered packshot video is present, the
              `sotd-video-card` modifier strips the bezel, sheen, and border so
              the video's pure-#000 master blends into the card and the bottle
              reads as floating (see index.css). Gated on videoSrc, so the
              reduce-motion / low-budget still-poster fallback keeps its frame. */}
          <div
            className={[
              'scent-fragrance-card scent-community-marquee-card relative mx-auto flex aspect-[3/4.4] w-full max-w-[8rem] flex-col overflow-hidden p-2.5 sm:max-w-[18rem] sm:p-5',
              videoSrc ? 'sotd-video-card' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="scent-card-frame" aria-hidden="true" />
            <div className="relative z-10 hidden justify-between gap-3 sm:flex">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-scent-accent/22 bg-black/54 px-2.5 py-1 scent-type-label text-scent-accent">
                <Sparkles size={12} strokeWidth={1.8} aria-hidden="true" />
                Today
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 font-mono text-[10px] uppercase text-foreground/52">
                Beam
              </span>
            </div>
            <div className="relative z-10 my-1 min-h-0 flex-1 sm:my-3">
              {fragrance?.imageUrl ? (
                <BottleImage
                  src={fragrance.imageUrl}
                  alt={`${fragrance.name} by ${fragrance.brand}`}
                  variant="card"
                  className="absolute inset-0"
                  imgClassName="scent-hover-scale brightness-[1.08] transition-transform duration-500 motion-reduce:transition-none"
                  videoSrc={videoSrc}
                  loading="lazy"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center rounded-sm border border-dashed border-white/15 bg-white/[0.03]">
                  <span className="scent-type-placeholder">No image</span>
                </div>
              )}
            </div>
            <BrandGoldLabel as="span" brand={brand} className="scent-card-brand relative z-10 block" />
            {/* Not a heading: the identity h3 beside the packshot is this
                article's labelled heading; a second h3 with the same text
                duplicated it in the outline. */}
            <div className="scent-card-title-row relative z-10 mt-2">
              <p className="scent-card-title" title={heading}>
                {heading}
              </p>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col justify-center py-1 text-left">
          <div className="hidden w-fit items-center gap-2 self-start rounded-full border border-scent-accent/18 bg-black/46 px-3 py-1.5 text-scent-accent sm:inline-flex">
            <Bot size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="scent-type-chip text-[11px] uppercase">
              Beam Agent generated
            </span>
          </div>
          <p className="scent-type-label text-scent-accent/88 sm:mt-4">
            Scent of the day
          </p>
          <h3
            id={headingId}
            className="mt-1.5 break-words text-balance font-serif text-2xl italic leading-[0.98] text-foreground sm:mt-2 sm:text-5xl"
          >
            {heading}
          </h3>
          <BrandGoldLabel
            as="p"
            brand={brand}
            className="mt-2 font-serif text-sm uppercase tracking-[0.14em] sm:mt-3 sm:text-xl sm:tracking-[0.18em]"
          />
          {fragrance?.family ? (
            <p className="mt-2 max-w-lg text-xs leading-4 text-foreground/68 sm:mt-4 sm:text-sm sm:leading-6">
              {fragrance.family}
            </p>
          ) : null}
          {fragments.length > 0 ? (
            <div className="mt-5 hidden min-w-0 flex-wrap gap-2 sm:flex">
              {fragments.map((fragment) => (
                <span
                  key={fragment}
                  className="rounded-full border border-scent-accent/16 bg-black/52 px-3 py-1 scent-type-chip text-[11px] text-scent-text-muted"
                >
                  {fragment}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <PostActionsFooter
        post={post}
        authToken={authToken}
        onSignIn={onSignIn}
        commentsOpen={commentsOpen}
        onToggleComments={() => setCommentsOpen((open) => !open)}
      />

      {commentsOpen ? (
        <CommentThread
          postId={post.id}
          authToken={authToken}
          onSignIn={onSignIn}
        />
      ) : null}
    </article>
  );
};

const StandardPostCard: React.FC<PostCardProps> = ({
  post,
  authToken,
  onSignIn,
}) => {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const headingId = useId();
  const detail = POST_TYPE_DETAILS[post.postType];
  const Icon = detail.Icon;
  const heading = post.title?.trim() || detail.label;
  const authorName = displayCommunityAuthor(post.author);

  return (
    <article
      aria-labelledby={headingId}
      className="scent-night-panel mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/34 bg-[#050403] p-4 text-left sm:p-6"
    >
      <header className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="flex min-w-0 items-center gap-4 sm:gap-5">
          <Link
            to={communitySharePath(post.author)}
            aria-label={`View ${authorName}'s vault`}
            className="shrink-0 rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/80"
          >
            <CommunityAuthorAvatar author={post.author} size="lg" />
          </Link>
          <div className="min-w-0">
            <Link
              to={communitySharePath(post.author)}
              className="block min-w-0 max-w-full truncate scent-type-chip text-base text-foreground transition-colors hover:text-scent-accent"
            >
              {authorName}
            </Link>
            <p className="mt-2 scent-type-meta uppercase text-scent-muted">
              {formatCommunityTime(post.createdAt)}
            </p>
          </div>
        </div>
        <span className="inline-flex min-h-10 w-fit shrink-0 items-center justify-center gap-2.5 rounded-full bg-scent-accent/[0.075] px-4 py-2 scent-type-chip text-scent-accent shadow-[inset_0_0_0_1px_rgba(212,175,55,0.18)]">
          <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
          {detail.label}
        </span>
      </header>

      <OrnamentalDivider className="my-4 sm:my-6" />

      <div className="space-y-3 sm:space-y-4">
        {/* Left-aligned reading spine on every breakpoint: feed content is for
            scanning, so the eye drops down one edge instead of re-centering on
            each line (the old sm:text-center read as a landing page). */}
        <h3
          id={headingId}
          className="break-words text-balance text-left font-serif text-2xl italic leading-tight text-foreground sm:text-4xl"
        >
          {heading}
        </h3>
        <div
          className="h-px w-28 max-w-full bg-scent-accent/48"
          aria-hidden="true"
        />
        <p className="max-w-3xl whitespace-pre-line break-words text-left text-sm leading-6 text-foreground/78 sm:text-lg sm:leading-8">
          {post.body}
        </p>
        <MetadataLine post={post} />
        {post.postType === 'battle' ? (
          <BattleVotes post={post} authToken={authToken} onSignIn={onSignIn} />
        ) : null}
        <FragranceShowcase post={post} />
      </div>

      {post.tags.length > 0 ? (
        <div className="mt-6 flex max-w-3xl flex-wrap justify-start gap-2">
          {post.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-scent-accent/16 bg-black/54 px-3 py-1 scent-type-chip text-scent-text-muted"
            >
              #{tag}
            </span>
          ))}
        </div>
      ) : null}

      <PostActionsFooter
        post={post}
        authToken={authToken}
        onSignIn={onSignIn}
        commentsOpen={commentsOpen}
        onToggleComments={() => setCommentsOpen((open) => !open)}
      />

      {commentsOpen ? (
        <CommentThread
          postId={post.id}
          authToken={authToken}
          onSignIn={onSignIn}
        />
      ) : null}
    </article>
  );
};

// Memoized so an accumulating, unvirtualized feed doesn't re-render every
// already-rendered card (and its heavy sub-cards) when CommunityFeed re-renders
// for its own state — refetch / placeholderData / fetchNextPage toggles. Those
// re-renders keep the same `post`/`authToken`/`onSignIn` references, so the
// shallow compare skips untouched cards. Memoizing the dispatcher short-circuits
// the whole post subtree in one boundary.
export const PostCard = React.memo(function PostCard(props: PostCardProps) {
  if (props.post.postType === 'battle') {
    return <CompactBattlePostCard {...props} />;
  }

  if (props.post.postType === 'question') {
    return <CompactQuestionPostCard {...props} />;
  }

  if (props.post.postType === 'sotd') {
    return <ScentOfDayPostCard {...props} />;
  }

  return <StandardPostCard {...props} />;
});
