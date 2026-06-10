import React, { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BadgeDollarSign,
  ChevronDown,
  ChevronUp,
  MessageCircle,
  MessageCircleQuestion,
  Sun,
  Swords,
  type LucideIcon,
} from 'lucide-react';
import { CommentThread } from '@/components/community/CommentThread';
import { ReactionBar } from '@/components/community/ReactionBar';
import {
  type CommunityPost,
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

function isAllowedSnapshotImage(imageUrl: string): boolean {
  return Boolean(imageUrl) && !imageUrl.trim().toLowerCase().startsWith('data:');
}

const FragranceChips: React.FC<{ post: CommunityPost }> = ({ post }) => {
  const fragrances = post.fragrances.filter((fragrance) => isAllowedSnapshotImage(fragrance.imageUrl));
  if (fragrances.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {fragrances.map((fragrance) => (
        <div
          key={`${fragrance.brand}:${fragrance.name}:${fragrance.imageUrl}`}
          className="grid w-full max-w-[18rem] grid-cols-[3.25rem_1fr] items-center gap-3 rounded-[14px] border border-scent-accent/14 bg-black/62 p-2 text-left sm:w-auto"
        >
          <div className="flex h-16 w-[3.25rem] items-center justify-center overflow-hidden rounded-[10px] bg-white/[0.035]">
            <img
              src={fragrance.imageUrl}
              alt={`${fragrance.name} by ${fragrance.brand}`}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-contain"
            />
          </div>
          <div className="min-w-0">
            <p className="truncate font-serif text-base italic leading-tight text-[#fff7ec]">
              {fragrance.name}
            </p>
            <p className="mt-1 truncate scent-type-label text-scent-accent">
              {fragrance.brand}
            </p>
            {fragrance.family ? (
              <p className="mt-1 truncate scent-type-caption">{fragrance.family}</p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
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
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {items.map(([label, value]) => (
          <span
            key={label}
            className="rounded-full border border-white/10 bg-black/54 px-3 py-1 scent-type-meta"
          >
            <span className="font-bold uppercase tracking-[0.12em] text-scent-accent">{label}</span>
            <span className="ml-2 text-[#fff7ec]/78">{value}</span>
          </span>
        ))}
      </div>
    );
  }

  if (post.postType === 'worth_it') {
    const priceContext = metadataString(post, 'price_context') ?? metadataString(post, 'priceContext');
    if (!priceContext) return null;
    return (
      <p className="mx-auto mt-4 max-w-2xl rounded-[14px] border border-scent-accent/14 bg-black/62 px-4 py-3 text-center text-sm text-[#fff7ec]/82">
        <span className="font-bold uppercase tracking-[0.14em] text-scent-accent">Price context</span>
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
  const options = battleOptions(post);
  const totalVotes = useMemo(
    () => options.reduce((sum, option) => sum + (post.votes[option] ?? 0), 0),
    [options, post.votes],
  );

  if (options.length !== 2) return null;

  const submitVote = (choice: string) => {
    if (!authToken) {
      onSignIn();
      return;
    }
    setErrorMessage(null);
    voteMutation.mutate(
      { postId: post.id, choice },
      {
        onError: (err) => {
          setErrorMessage(err instanceof Error ? err.message : 'Vote could not be saved.');
        },
      },
    );
  };

  return (
    <div className="mx-auto mt-4 max-w-2xl space-y-3">
      {options.map((option) => {
        const count = post.votes[option] ?? 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        return (
          <button
            key={option}
            type="button"
            onClick={() => submitVote(option)}
            disabled={voteMutation.isPending}
            className="group relative w-full overflow-hidden rounded-[14px] border border-scent-accent/16 bg-black/58 px-4 py-3 text-left transition-colors hover:border-scent-accent/38 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-55"
          >
            <span
              className="absolute inset-y-0 left-0 bg-scent-accent/[0.075] transition-[width]"
              style={{ width: `${pct}%` }}
              aria-hidden="true"
            />
            <span className="relative z-10 flex items-center justify-between gap-4">
              <span className="min-w-0 truncate font-serif text-lg italic text-[#fff7ec]">{option}</span>
              <span className="shrink-0 font-mono text-[13px] text-scent-accent">
                {pct}% ({count})
              </span>
            </span>
          </button>
        );
      })}
      {errorMessage ? <p className="text-sm text-red-100">{errorMessage}</p> : null}
    </div>
  );
};

export const PostCard: React.FC<PostCardProps> = ({ post, authToken, onSignIn }) => {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const headingId = useId();
  const detail = POST_TYPE_DETAILS[post.postType];
  const Icon = detail.Icon;
  const heading = post.title?.trim() || detail.label;

  return (
    <article
      aria-labelledby={headingId}
      className="mx-auto w-full max-w-[960px] rounded-[var(--radius-scent)] border border-scent-accent/24 bg-[linear-gradient(180deg,rgba(10,9,7,0.88),rgba(0,0,0,0.96))] p-6 text-center shadow-[0_18px_44px_-30px_rgba(0,0,0,0.95),0_0_0_1px_rgba(212,175,55,0.06),inset_0_1px_0_rgba(255,236,183,0.06)]"
    >
      <header className="flex flex-col items-center gap-4">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-center gap-2 scent-type-meta uppercase">
            <span className="inline-flex items-center gap-2 rounded-full border border-scent-accent/18 bg-scent-accent/[0.05] px-3 py-1 font-bold text-scent-accent">
              <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
              {detail.label}
            </span>
            <Link
              to={communitySharePath(post.author)}
              className="font-bold text-scent-muted transition-colors hover:text-[#fff7ec]"
            >
              {displayCommunityAuthor(post.author)}
            </Link>
            <span>{formatCommunityTime(post.createdAt)}</span>
          </div>
          <h3
            id={headingId}
            className="break-words text-balance font-serif text-2xl italic leading-tight text-[#fff7ec] sm:text-3xl"
          >
            {heading}
          </h3>
        </div>
      </header>

      <div className="mt-4 space-y-4">
        <p className="mx-auto max-w-3xl whitespace-pre-line break-words text-base leading-8 text-[#fff7ec]/88">
          {post.body}
        </p>
        <MetadataLine post={post} />
        {post.postType === 'battle' ? (
          <BattleVotes post={post} authToken={authToken} onSignIn={onSignIn} />
        ) : null}
        <FragranceChips post={post} />
      </div>

      {post.tags.length > 0 ? (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {post.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-white/10 bg-black/54 px-3 py-1 scent-type-chip"
            >
              #{tag}
            </span>
          ))}
        </div>
      ) : null}

      <footer className="mt-6 flex flex-col items-center justify-center gap-4 border-t border-white/10 pt-4 md:flex-row md:justify-center">
        <h4 className="sr-only">Post actions</h4>
        <ReactionBar
          targetType="post"
          targetId={post.id}
          counts={post.counts.reactions}
          authToken={authToken}
          onSignIn={onSignIn}
        />
        <button
          type="button"
          onClick={() => setCommentsOpen((open) => !open)}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-scent-accent/16 bg-black/58 px-4 py-2 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/34 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35"
          aria-expanded={commentsOpen}
          aria-label={commentsOpen ? 'Hide comments' : `View ${post.counts.comments} comments`}
        >
          <MessageCircle size={14} strokeWidth={1.8} aria-hidden="true" />
          {post.counts.comments} comments
          {commentsOpen ? (
            <ChevronUp size={14} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
      </footer>

      {commentsOpen ? (
        <CommentThread postId={post.id} authToken={authToken} onSignIn={onSignIn} />
      ) : null}
    </article>
  );
};
