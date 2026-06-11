import React, { useEffect, useState } from 'react';
import { BadgeCheck, Heart, Sparkles, type LucideIcon } from 'lucide-react';
import {
  type CommunityReactionTargetType,
  useToggleCommunityReaction,
} from '@/components/community/communityPosts';

interface ReactionDefinition {
  key: string;
  label: string;
  Icon: LucideIcon;
}

const REACTIONS: ReactionDefinition[] = [
  { key: 'like', label: 'Like', Icon: Heart },
  { key: 'wear', label: 'Would wear', Icon: Sparkles },
  { key: 'helpful', label: 'Helpful', Icon: BadgeCheck },
];

interface ReactionBarProps {
  targetType: CommunityReactionTargetType;
  targetId: string;
  counts: Record<string, number>;
  viewerReactions: string[];
  authToken: string | null;
  onSignIn: () => void;
  compact?: boolean;
}

export const ReactionBar: React.FC<ReactionBarProps> = ({
  targetType,
  targetId,
  counts,
  viewerReactions,
  authToken,
  onSignIn,
  compact = false,
}) => {
  const mutation = useToggleCommunityReaction(authToken);
  // Remember a reaction tapped while logged out and replay it once the viewer
  // signs in, so the tap isn't silently dropped.
  const [pendingReaction, setPendingReaction] = useState<string | null>(null);
  // The hook's onError silently rolls back the optimistic cache patch; this
  // local notice makes that rollback visible at the bar that was clicked.
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const { mutate } = mutation;

  const runToggle = React.useCallback(
    (reaction: string) => {
      setErrorNotice(null);
      mutate(
        { targetType, targetId, reaction },
        {
          onError: () => setErrorNotice("Couldn't save your reaction. Please try again."),
        },
      );
    },
    [mutate, targetType, targetId],
  );

  useEffect(() => {
    if (!authToken || !pendingReaction) return;
    const reaction = pendingReaction;
    setPendingReaction(null);
    runToggle(reaction);
  }, [authToken, pendingReaction, runToggle]);

  const toggleReaction = (reaction: string) => {
    if (!authToken) {
      setPendingReaction(reaction);
      onSignIn();
      return;
    }
    runToggle(reaction);
  };

  return (
    <div
      className={
        compact
          ? 'flex flex-wrap items-center justify-center gap-2'
          : 'flex w-full flex-wrap items-center justify-center gap-3'
      }
    >
      {REACTIONS.map(({ key, label, Icon }) => {
        const count = counts[key] ?? 0;
        const active = viewerReactions.includes(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => toggleReaction(key)}
            disabled={mutation.isPending}
            aria-label={authToken ? `${label} ${targetType}` : `Sign in to ${label.toLowerCase()} this ${targetType}`}
            title={authToken ? undefined : 'Sign in to react'}
            aria-pressed={active}
            className={[
              'inline-flex items-center justify-center rounded-full scent-type-chip transition-all duration-200 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:pointer-events-none disabled:opacity-55',
              active
                ? 'bg-scent-accent/[0.16] text-[#fff7ec] shadow-[inset_0_0_0_1px_rgba(212,175,55,0.48)]'
                : 'text-scent-text-muted hover:bg-white/[0.045]',
              compact ? 'min-h-9 gap-1.5 px-2.5 py-1.5' : 'min-h-11 gap-2 px-3.5 py-2.5',
            ].join(' ')}
          >
            <Icon
              size={compact ? 15 : 18}
              strokeWidth={active ? 2.1 : 1.8}
              aria-hidden="true"
              className={active ? 'fill-current text-scent-accent opacity-100 drop-shadow-[0_0_8px_rgba(212,175,55,0.45)]' : undefined}
            />
            <span className={compact ? 'sr-only' : 'sr-only sm:not-sr-only sm:font-bold sm:uppercase sm:tracking-[0.16em]'}>
              {label}
            </span>
            {count > 0 ? (
              <span className="font-mono text-[13px] font-bold leading-none text-scent-accent sm:text-[15px]">
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
      {errorNotice ? (
        <p
          role="alert"
          className={`text-[12px] leading-snug text-red-200 font-sans ${
            compact ? 'w-full text-center' : 'w-full text-center'
          }`}
        >
          {errorNotice}
        </p>
      ) : null}
    </div>
  );
};
