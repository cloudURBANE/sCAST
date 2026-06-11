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
  const { mutate } = mutation;

  useEffect(() => {
    if (!authToken || !pendingReaction) return;
    const reaction = pendingReaction;
    setPendingReaction(null);
    mutate({ targetType, targetId, reaction });
  }, [authToken, pendingReaction, mutate, targetType, targetId]);

  const toggleReaction = (reaction: string) => {
    if (!authToken) {
      setPendingReaction(reaction);
      onSignIn();
      return;
    }
    mutate({ targetType, targetId, reaction });
  };

  return (
    <div
      className={
        compact
          ? 'flex flex-wrap items-center justify-center gap-2'
          : 'grid w-full gap-3 sm:grid-cols-3'
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
            aria-label={`${label} ${targetType}`}
            aria-pressed={active}
            className={[
              'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border scent-type-chip transition-colors hover:border-scent-accent/34 hover:bg-scent-accent/[0.055] hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-55',
              active
                ? 'border-scent-accent/55 bg-scent-accent/[0.12] text-[#fff7ec]'
                : 'border-scent-accent/16 bg-black/58 text-scent-text-muted',
              compact ? 'px-3 py-1.5' : 'w-full px-4 py-3',
            ].join(' ')}
          >
            <Icon
              size={compact ? 13 : 14}
              strokeWidth={1.7}
              aria-hidden="true"
              className={active ? 'fill-current text-scent-accent' : undefined}
            />
            <span className="font-bold uppercase tracking-[0.16em]">
              {label}
            </span>
            {count > 0 ? (
              <span className="font-mono text-[13px] text-scent-accent">
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
};
