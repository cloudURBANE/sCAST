import React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { CommunityAuthor } from '@/components/community/communityPosts';
import { displayCommunityAuthor } from '@/components/community/communityFormat';

function authorInitials(author: CommunityAuthor): string {
  const displayName = displayCommunityAuthor(author);
  const compact = displayName.replace(/[^a-z0-9]/gi, '');
  return (compact || author.email || 'SB').slice(0, 2).toUpperCase();
}

interface CommunityAuthorAvatarProps {
  author: CommunityAuthor;
  /** Comments render a slightly smaller portrait than the post header. */
  size?: 'lg' | 'md' | 'sm';
}

const SIZE_CLASSES = {
  lg: 'h-16 w-16 sm:h-20 sm:w-20',
  md: 'h-12 w-12 sm:h-14 sm:w-14',
  sm: 'h-9 w-9 sm:h-10 sm:w-10',
} as const;

const FALLBACK_TEXT_CLASSES = {
  lg: 'text-xl sm:text-2xl',
  md: 'text-base sm:text-lg',
  sm: 'text-sm sm:text-base',
} as const;

export const CommunityAuthorAvatar: React.FC<CommunityAuthorAvatarProps> = ({
  author,
  size = 'md',
}) => (
  <div className="relative shrink-0 rounded-full bg-[linear-gradient(135deg,rgba(212,175,55,0.72),rgba(255,247,236,0.1)_46%,rgba(212,175,55,0.38))] p-px shadow-[0_16px_34px_-24px_rgba(212,175,55,0.7),0_0_0_1px_rgba(255,236,183,0.08)]">
    <Avatar
      className={`${SIZE_CLASSES[size]} border border-black/70 bg-[#090604]`}
    >
      {author.pictureUrl ? (
        <AvatarImage
          src={author.pictureUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="object-cover"
        />
      ) : null}
      <AvatarFallback
        className={`bg-[radial-gradient(circle_at_35%_20%,rgba(212,175,55,0.22),rgba(5,3,2,0.98)_62%)] font-serif font-bold italic text-scent-accent ${FALLBACK_TEXT_CLASSES[size]}`}
      >
        {authorInitials(author)}
      </AvatarFallback>
    </Avatar>
  </div>
);
