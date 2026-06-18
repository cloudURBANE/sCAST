import React, { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BadgeDollarSign,
  Bot,
  ChevronDown,
  ChevronUp,
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
    <div className="mx-auto mt-4 grid w-full max-w-[46rem] gap-3 sm:mt-6">
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
            <p className="break-words font-serif text-base italic leading-tight text-[#fff7ec] sm:text-3xl">
              {fragrance.name}
            </p>
            <p className="mt-1.5 break-words text-xs font-black uppercase leading-tight tracking-[0.1em] text-[#fff7ec] sm:mt-4 sm:text-3xl sm:tracking-[0.12em]">
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
      className="scent-no-mobile-focus-ring flex min-h-9 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:bg-white/[0.045] hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/60"
      aria-expanded={commentsOpen}
      aria-label={
        commentsOpen
          ? 'Hide comments'
          : `View ${post.counts.comments} comments`
      }
    >
      <MessageCircle size={15} strokeWidth={1.75} aria-hidden="true" />
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] sm:text-xs">
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

// One side of the compact battle card. The gold fill behind the name is a
// showcase of that option's live share of the vote (server-authoritative
// `post.votes`), so the card reads the current standing at a glance.
const BattleRatingOption: React.FC<{
  label: string;
  count: number;
  total: number;
}> = ({ label, count, total }) => {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="relative flex min-h-16 w-full min-w-0 flex-col justify-center overflow-hidden rounded-[14px] border border-scent-accent/42 bg-black/70 px-2.5 py-2 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] sm:min-h-[5.5rem] sm:rounded-[18px] sm:px-5 sm:py-3">
      <span
        className="absolute inset-y-0 left-0 bg-scent-accent/15 transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
        aria-hidden="true"
      />
      <p className="relative z-10 break-words font-serif text-base italic leading-tight text-[#fff7ec] sm:text-2xl">
        {label}
      </p>
      <p className="relative z-10 mt-1 font-mono text-[9px] leading-none text-scent-accent sm:mt-2 sm:text-sm">
        {total > 0 ? `${pct}% · ${count} ${count === 1 ? 'vote' : 'votes'}` : 'No votes yet'}
      </p>
    </div>
  );
};

const CompactBattlePostCard: React.FC<PostCardProps> = ({
  post,
  authToken,
  onSignIn,
}) => {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const headingId = useId();
  const authorName = displayCommunityAuthor(post.author);
  const heading = post.title?.trim() || 'Battle';
  const options = battleOptions(post);
  const totalVotes = options.reduce(
    (sum, option) => sum + (post.votes[option] ?? 0),
    0,
  );

  return (
    <article
      aria-labelledby={headingId}
      className="mx-auto w-full max-w-[940px] overflow-hidden rounded-[18px] border border-scent-accent/34 bg-[#050403] p-3 text-left shadow-[inset_0_1px_0_rgba(255,236,183,0.06)] sm:rounded-[24px] sm:p-6"
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
              className="block min-w-0 max-w-full truncate scent-type-chip text-xs text-[#fff7ec] transition-colors hover:text-scent-accent sm:text-sm"
            >
              {authorName}
            </Link>
            <p className="mt-1 scent-type-meta text-[10px] uppercase text-scent-muted sm:mt-1.5 sm:text-xs">
              {formatCommunityTime(post.createdAt)}
            </p>
          </div>
        </div>
        <span className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-scent-accent/38 bg-scent-accent/[0.075] px-3 py-1.5 scent-type-chip text-[10px] text-scent-accent shadow-[inset_0_1px_0_rgba(255,236,183,0.055)] sm:min-h-12 sm:gap-2 sm:px-5 sm:py-2 sm:text-xs">
          <Swords size={17} strokeWidth={1.75} aria-hidden="true" />
          Battle
        </span>
      </header>

      <div className="mx-auto mt-3 min-w-0 max-w-[48rem] text-center sm:mt-6">
        <h3
          id={headingId}
          className="mx-auto break-words text-balance font-serif text-xl italic leading-[1.08] text-[#fff7ec] sm:text-3xl"
        >
          {heading}
        </h3>
        {post.body ? (
          <p className="mx-auto mt-1.5 line-clamp-2 whitespace-pre-line break-words text-xs leading-4 text-[#fff7ec]/68 sm:mt-2 sm:text-base sm:leading-6">
            {post.body}
          </p>
        ) : null}
      </div>

      {options.length === 2 ? (
        <div className="mt-3 grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:mt-6 sm:gap-3">
          <BattleRatingOption
            label={options[0]}
            count={post.votes[options[0]] ?? 0}
            total={totalVotes}
          />
          <div className="flex items-center justify-center" aria-hidden="true">
            <span className="font-serif text-base italic text-scent-accent sm:text-lg">vs</span>
          </div>
          <BattleRatingOption
            label={options[1]}
            count={post.votes[options[1]] ?? 0}
            total={totalVotes}
          />
        </div>
      ) : null}

      <div className="mt-3 flex justify-center sm:mt-6">
        <Link
          to="/arena"
          className="scent-primary-button scent-no-mobile-focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-scent-accent/72 px-6 py-2 text-[10px] font-bold uppercase tracking-[0.15em] shadow-[inset_0_0_0_2px_rgba(255,236,183,0.12)] sm:min-h-12 sm:gap-2.5 sm:px-8 sm:py-2.5 sm:text-xs sm:tracking-[0.17em]"
        >
          <span>Open arena</span>
          <ArrowRight size={15} strokeWidth={1.8} aria-hidden="true" />
        </Link>
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

const CompactQuestionPostCard: React.FC<PostCardProps> = ({
  post,
  authToken,
  onSignIn,
}) => {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const headingId = useId();
  const authorName = displayCommunityAuthor(post.author);
  const heading = post.title?.trim() || 'Question';

  return (
    <article
      aria-labelledby={headingId}
      className="mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)-2px)] border border-scent-accent/20 bg-[#050403] p-4 text-left sm:p-5"
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
              className="block min-w-0 max-w-full truncate scent-type-chip text-[12px] text-[#fff7ec] transition-colors hover:text-scent-accent"
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
        <h3
          id={headingId}
          className="break-words text-balance font-serif text-2xl italic leading-tight text-[#fff7ec] sm:text-3xl"
        >
          {heading}
        </h3>
        {post.body ? (
          <p className="mt-2 max-w-2xl whitespace-pre-line break-words text-sm leading-6 text-[#fff7ec]/76 sm:text-[15px]">
            {post.body}
          </p>
        ) : null}
      </div>

      {post.tags.length > 0 ? (
        <div className="mt-4 flex min-w-0 flex-wrap gap-2">
          {post.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="max-w-full rounded-full border border-scent-accent/14 bg-black/48 px-2.5 py-1 scent-type-chip text-[10px] text-scent-text-muted"
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
      <div className="mx-auto mt-5 flex max-w-3xl flex-wrap justify-center gap-2">
        {items.map(([label, value]) => (
          <span
            key={label}
            className="rounded-full border border-scent-accent/16 bg-black/54 px-3 py-1 scent-type-meta"
          >
            <span className="font-bold uppercase tracking-[0.12em] text-scent-accent">
              {label}
            </span>
            <span className="ml-2 text-[#fff7ec]/78">{value}</span>
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
      <p className="mx-auto mt-5 max-w-2xl rounded-[16px] border border-scent-accent/18 bg-black/62 px-4 py-3 text-center text-sm leading-6 text-[#fff7ec]/82">
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
    <div className="mx-auto mt-6 max-w-2xl space-y-3" aria-live="polite">
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
                <span className="min-w-0 truncate font-serif text-lg italic text-[#fff7ec]">
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
      className="mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/22 bg-[#050403] p-4 text-left sm:p-5"
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
              className="block min-w-0 max-w-full truncate scent-type-chip text-[12px] text-[#fff7ec] transition-colors hover:text-scent-accent"
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
              <span className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 font-mono text-[9px] uppercase text-[#fff7ec]/52">
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
                  imgClassName="scent-hover-scale brightness-[1.08] transition-transform duration-[900ms] motion-reduce:transition-none"
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
            <div className="scent-card-title-row relative z-10 mt-2">
              <h3 className="scent-card-title" title={heading}>
                {heading}
              </h3>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col justify-center py-1 text-left">
          <div className="hidden w-fit items-center gap-2 self-start rounded-full border border-scent-accent/18 bg-black/46 px-3 py-1.5 text-scent-accent sm:inline-flex">
            <Bot size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="scent-type-chip text-[10px] uppercase">
              Beam Agent generated
            </span>
          </div>
          <p className="scent-type-label text-scent-accent/88 sm:mt-4">
            Scent of the day
          </p>
          <h3
            id={headingId}
            className="mt-1.5 break-words text-balance font-serif text-2xl italic leading-[0.98] text-[#fff7ec] sm:mt-2 sm:text-5xl"
          >
            {heading}
          </h3>
          <BrandGoldLabel
            as="p"
            brand={brand}
            className="mt-2 font-serif text-sm uppercase tracking-[0.14em] sm:mt-3 sm:text-xl sm:tracking-[0.18em]"
          />
          {fragrance?.family ? (
            <p className="mt-2 max-w-lg text-xs leading-4 text-[#fff7ec]/68 sm:mt-4 sm:text-sm sm:leading-6">
              {fragrance.family}
            </p>
          ) : null}
          {fragments.length > 0 ? (
            <div className="mt-5 hidden min-w-0 flex-wrap gap-2 sm:flex">
              {fragments.map((fragment) => (
                <span
                  key={fragment}
                  className="rounded-full border border-scent-accent/16 bg-black/52 px-3 py-1 scent-type-chip text-[10px] text-scent-text-muted"
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
      className="mx-auto w-full max-w-[940px] overflow-hidden rounded-[calc(var(--radius-scent)+2px)] border border-scent-accent/24 bg-[#050403] p-4 text-left sm:p-7"
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
              className="block min-w-0 max-w-full truncate scent-type-chip text-base text-[#fff7ec] transition-colors hover:text-scent-accent"
            >
              {authorName}
            </Link>
            <p className="mt-2 scent-type-meta uppercase text-scent-muted">
              {formatCommunityTime(post.createdAt)}
            </p>
          </div>
        </div>
        <span className="inline-flex min-h-10 w-fit shrink-0 items-center justify-center gap-2.5 rounded-full bg-scent-accent/[0.075] px-4 py-2 scent-type-chip text-scent-accent shadow-[inset_0_0_0_1px_rgba(212,175,55,0.20)]">
          <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
          {detail.label}
        </span>
      </header>

      <OrnamentalDivider className="my-4 sm:my-6" />

      <div className="space-y-3 sm:space-y-4">
        <h3
          id={headingId}
          className="break-words text-balance text-left font-serif text-2xl italic leading-tight text-[#fff7ec] sm:text-center sm:text-5xl"
        >
          {heading}
        </h3>
        <div
          className="h-px w-28 max-w-full bg-scent-accent/48 sm:mx-auto"
          aria-hidden="true"
        />
        <p className="mx-auto max-w-3xl whitespace-pre-line break-words text-left text-sm leading-6 text-[#fff7ec]/78 sm:text-center sm:text-xl sm:leading-9">
          {post.body}
        </p>
        <MetadataLine post={post} />
        {post.postType === 'battle' ? (
          <BattleVotes post={post} authToken={authToken} onSignIn={onSignIn} />
        ) : null}
        <FragranceShowcase post={post} />
      </div>

      {post.tags.length > 0 ? (
        <div className="mx-auto mt-6 flex max-w-3xl flex-wrap justify-center gap-2">
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

export const PostCard: React.FC<PostCardProps> = (props) => {
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
};
