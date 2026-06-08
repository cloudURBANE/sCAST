import React from 'react';
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
  authToken: string | null;
  onSignIn: () => void;
  compact?: boolean;
}

export const ReactionBar: React.FC<ReactionBarProps> = ({
  targetType,
  targetId,
  counts,
  authToken,
  onSignIn,
  compact = false,
}) => {
  const mutation = useToggleCommunityReaction(authToken);

  const toggleReaction = (reaction: string) => {
    if (!authToken) {
      onSignIn();
      return;
    }
    mutation.mutate({ targetType, targetId, reaction });
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {REACTIONS.map(({ key, label, Icon }) => {
        const count = counts[key] ?? 0;
        return (
          <button
            key={key}
            type="button"
            onClick={() => toggleReaction(key)}
            disabled={mutation.isPending}
            aria-label={`${label} ${targetType}`}
            className={[
              'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-scent-accent/16 bg-black/58 text-scent-muted transition-colors hover:border-scent-accent/34 hover:bg-scent-accent/[0.055] hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-55',
              compact ? 'px-3 py-1.5 text-[10px]' : 'px-4 py-2 text-[11px]',
            ].join(' ')}
          >
            <Icon size={compact ? 13 : 14} strokeWidth={1.7} aria-hidden="true" />
            <span className="font-bold uppercase tracking-[0.16em]">{label}</span>
            <span className="font-mono text-[10px] text-scent-accent/80">{count}</span>
          </button>
        );
      })}
    </div>
  );
};
