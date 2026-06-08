import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LoaderCircle, Send } from 'lucide-react';
import { ReactionBar } from '@/components/community/ReactionBar';
import {
  useCommunityPostDetail,
  useCreateCommunityComment,
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

export const CommentThread: React.FC<CommentThreadProps> = ({ postId, authToken, onSignIn }) => {
  const [body, setBody] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const detail = useCommunityPostDetail(postId, true);
  const comments = detail.data?.comments ?? [];
  const commentMutation = useCreateCommunityComment(authToken);

  const submitComment = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!authToken) {
      onSignIn();
      return;
    }
    if (!trimmed) return;

    setErrorMessage(null);
    commentMutation.mutate(
      { postId, body: trimmed },
      {
        onSuccess: () => setBody(''),
        onError: (err) => {
          setErrorMessage(err instanceof Error ? err.message : 'Comment could not be posted.');
        },
      },
    );
  };

  return (
    <section className="mt-5 border-t border-white/10 pt-5" aria-label="Comments">
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
        <div className="space-y-4">
          {comments.length === 0 ? (
            <p className="text-sm text-scent-muted/70">No comments yet.</p>
          ) : (
            comments.map((comment) => (
              <article key={comment.id} className="border-b border-white/8 pb-4 last:border-b-0">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em]">
                  <Link
                    to={communitySharePath(comment.author)}
                    className="font-bold text-scent-accent/82 transition-colors hover:text-[#fff7ec]"
                  >
                    {displayCommunityAuthor(comment.author)}
                  </Link>
                  <span className="text-scent-muted/70">{formatCommunityTime(comment.createdAt)}</span>
                </div>
                <p className="whitespace-pre-line text-sm leading-7 text-[#fff7ec]/88">{comment.body}</p>
                <div className="mt-3">
                  <ReactionBar
                    targetType="comment"
                    targetId={comment.id}
                    counts={comment.counts.reactions}
                    authToken={authToken}
                    onSignIn={onSignIn}
                    compact
                  />
                </div>
              </article>
            ))
          )}
        </div>
      )}

      <form onSubmit={submitComment} className="mt-5 space-y-3">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          maxLength={2000}
          placeholder={authToken ? 'Add a comment' : 'Sign in to comment'}
          aria-label="Add a comment"
          className="scent-lux-input min-h-24 w-full resize-y rounded-[var(--radius-scent)] px-4 py-3 text-sm leading-6 text-[#fff7ec] placeholder:text-scent-muted/45"
        />
        {errorMessage ? (
          <p className="text-sm text-red-100">{errorMessage}</p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-scent-muted/70">
            {body.trim().length}/2000
          </p>
          <button
            type="submit"
            disabled={commentMutation.isPending || (authToken ? !body.trim() : false)}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-scent-accent/30 bg-scent-accent/[0.07] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#fff7ec] transition-colors hover:border-scent-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-55"
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
