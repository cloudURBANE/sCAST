import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CornerDownRight, LoaderCircle, Send } from 'lucide-react';
import { CommunityAuthorAvatar } from '@/components/community/CommunityAuthorAvatar';
import { ReactionBar } from '@/components/community/ReactionBar';
import {
  useCommunityPostDetail,
  useCreateCommunityComment,
  type CommunityComment,
} from '@/components/community/communityPosts';
import {
  communitySharePath,
  displayCommunityAuthor,
  formatCommunityTime,
} from '@/components/community/communityFormat';

interface CommentThreadProps {
  postId: string;
  authToken: string | null;
  onSignIn: () => void;
}

type CommentNode = CommunityComment & { replies: CommentNode[] };

// Cap the *visual* indentation. Replies keep threading past this depth but stop
// adding left inset so a long reply chain never overflows a 320px iPhone SE.
const MAX_VISUAL_DEPTH = 3;

/**
 * Build a reply tree from the flat, time-ordered comment list. A `Map` preserves
 * the server's ordering for both roots and replies. Any comment whose parent is
 * missing from the list (deleted/out-of-window) falls back to a root so it can
 * never disappear.
 */
function buildCommentTree(comments: CommunityComment[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const comment of comments) byId.set(comment.id, { ...comment, replies: [] });

  const roots: CommentNode[] = [];
  for (const comment of comments) {
    const node = byId.get(comment.id)!;
    const parent = comment.parentCommentId ? byId.get(comment.parentCommentId) : null;
    if (parent && parent !== node) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

interface CommentNodeViewProps {
  node: CommentNode;
  depth: number;
  authToken: string | null;
  isPosting: boolean;
  onSignIn: () => void;
  onReply: (parentCommentId: string, body: string) => void;
}

const CommentNodeView: React.FC<CommentNodeViewProps> = ({
  node,
  depth,
  authToken,
  isPosting,
  onSignIn,
  onReply,
}) => {
  const [showReply, setShowReply] = useState(false);
  const [replyBody, setReplyBody] = useState('');

  const submitReply = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = replyBody.trim();
    if (!authToken) {
      onSignIn();
      return;
    }
    if (!trimmed) return;
    onReply(node.id, trimmed);
    setReplyBody('');
    setShowReply(false);
  };

  // Indent only while under the visual cap; deeper replies render flush with the
  // cap so the thread stays legible at 320px.
  const indented = depth > 0 && depth <= MAX_VISUAL_DEPTH;

  return (
    <div className={indented ? 'border-l border-white/8 pl-3 sm:pl-4' : undefined}>
      <article className="rounded-[calc(var(--radius-scent)-8px)] border border-white/8 bg-white/[0.025] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,236,183,0.035)]">
        <div className="flex items-start gap-3">
          <Link
            to={communitySharePath(node.author)}
            aria-label={`View ${displayCommunityAuthor(node.author)}'s vault`}
            className="shrink-0 rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
          >
            <CommunityAuthorAvatar author={node.author} size="sm" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 scent-type-meta uppercase">
              <Link
                to={communitySharePath(node.author)}
                className="min-w-0 max-w-full truncate font-bold text-scent-accent transition-colors hover:text-foreground"
              >
                {displayCommunityAuthor(node.author)}
              </Link>
              <span>{formatCommunityTime(node.createdAt)}</span>
            </div>
            <p className="whitespace-pre-line text-base leading-7 text-foreground/88">{node.body}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <ReactionBar
                targetType="comment"
                targetId={node.id}
                counts={node.counts.reactions}
                viewerReactions={node.viewerReactions}
                authToken={authToken}
                onSignIn={onSignIn}
                compact
              />
              <button
                type="button"
                onClick={() => {
                  if (!authToken) {
                    onSignIn();
                    return;
                  }
                  setShowReply((open) => !open);
                }}
                aria-expanded={showReply}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-2.5 py-1 scent-type-meta uppercase text-scent-muted transition-colors hover:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
              >
                <CornerDownRight size={13} strokeWidth={1.8} aria-hidden="true" />
                Reply
              </button>
            </div>

            {showReply ? (
              <form onSubmit={submitReply} className="mt-3 space-y-3">
                <textarea
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={2}
                  maxLength={2000}
                  autoFocus
                  placeholder={`Reply to ${displayCommunityAuthor(node.author)}`}
                  aria-label={`Reply to ${displayCommunityAuthor(node.author)}`}
                  className="scent-lux-input min-h-16 w-full resize-y rounded-[var(--radius-scent)] px-3.5 py-2.5 text-base leading-7 text-foreground placeholder:text-scent-text-subtle"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowReply(false);
                      setReplyBody('');
                    }}
                    className="inline-flex min-h-9 items-center rounded-full px-3 py-1.5 scent-type-meta uppercase text-scent-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isPosting || !replyBody.trim()}
                    className="inline-flex min-h-9 items-center gap-2 rounded-full bg-scent-accent/[0.09] px-3.5 py-1.5 scent-type-chip text-foreground shadow-[inset_0_0_0_1px_rgba(212,175,55,0.26)] transition-colors hover:bg-scent-accent/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:pointer-events-none disabled:opacity-55"
                  >
                    {isPosting ? (
                      <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Send size={13} strokeWidth={1.8} aria-hidden="true" />
                    )}
                    Reply
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        </div>
      </article>

      {node.replies.length > 0 ? (
        <div className="mt-3 space-y-3">
          {node.replies.map((child) => (
            <CommentNodeView
              key={child.id}
              node={child}
              depth={depth + 1}
              authToken={authToken}
              isPosting={isPosting}
              onSignIn={onSignIn}
              onReply={onReply}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

export const CommentThread: React.FC<CommentThreadProps> = ({ postId, authToken, onSignIn }) => {
  const [body, setBody] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Hold a comment drafted while logged out and post it once the viewer signs in.
  const [pendingBody, setPendingBody] = useState<string | null>(null);
  const detail = useCommunityPostDetail(postId, true, authToken);
  const commentTree = useMemo(
    () => buildCommentTree(detail.data?.comments ?? []),
    [detail.data?.comments],
  );
  const commentMutation = useCreateCommunityComment(authToken);
  const { mutate } = commentMutation;

  const postComment = (text: string, parentCommentId?: string | null) => {
    setErrorMessage(null);
    mutate(
      { postId, body: text, parentCommentId: parentCommentId ?? null },
      {
        onSuccess: () => {
          if (!parentCommentId) setBody('');
        },
        onError: (err) => {
          setErrorMessage(err instanceof Error ? err.message : 'Comment could not be posted.');
        },
      },
    );
  };

  useEffect(() => {
    if (!authToken || !pendingBody) return;
    const text = pendingBody;
    setPendingBody(null);
    postComment(text);
    // postComment is recreated each render but closes over the same stable refs;
    // gating on authToken + pendingBody keeps this to a single replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, pendingBody]);

  const submitComment = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!authToken) {
      if (trimmed) setPendingBody(trimmed);
      onSignIn();
      return;
    }
    if (!trimmed) return;
    postComment(trimmed);
  };

  return (
    <section className="mt-6 border-t border-white/8 pt-5" aria-label="Comments">
      {detail.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-scent-muted">
          <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
          Loading comments
        </div>
      ) : detail.isError ? (
        <p className="rounded-lg border border-red-500/18 bg-red-500/[0.055] px-4 py-3 text-sm text-red-100">
          {detail.error instanceof Error ? detail.error.message : 'Comments are unavailable.'}
        </p>
      ) : (
        <div className="space-y-3">
          {commentTree.length === 0 ? (
            <p className="rounded-[calc(var(--radius-scent)-10px)] border border-white/8 bg-white/[0.025] px-4 py-3 text-center scent-type-caption">
              No comments yet.
            </p>
          ) : (
            commentTree.map((node) => (
              <CommentNodeView
                key={node.id}
                node={node}
                depth={0}
                authToken={authToken}
                isPosting={commentMutation.isPending}
                onSignIn={onSignIn}
                onReply={(parentCommentId, text) => postComment(text, parentCommentId)}
              />
            ))
          )}
        </div>
      )}

      <form onSubmit={submitComment} className="mt-6 space-y-4">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={3}
          maxLength={2000}
          placeholder={authToken ? 'Add a comment' : 'Sign in to comment'}
          aria-label="Add a comment"
          className="scent-lux-input min-h-24 w-full resize-y rounded-[var(--radius-scent)] px-4 py-3 text-base leading-7 text-foreground placeholder:text-scent-text-subtle"
        />
        {errorMessage ? (
          <p role="status" aria-live="polite" className="text-sm text-red-100">{errorMessage}</p>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <p className="scent-type-meta uppercase">
            {body.length}/2000
          </p>
          <button
            type="submit"
            disabled={commentMutation.isPending || (authToken ? !body.trim() : false)}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-scent-accent/[0.09] px-4 py-2 scent-type-chip text-foreground shadow-[inset_0_0_0_1px_rgba(212,175,55,0.26)] transition-colors hover:bg-scent-accent/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:pointer-events-none disabled:opacity-55"
          >
            {commentMutation.isPending ? (
              <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <Send size={14} strokeWidth={1.8} aria-hidden="true" />
            )}
            {authToken ? 'Post comment' : 'Sign in'}
          </button>
        </div>
      </form>
    </section>
  );
};
