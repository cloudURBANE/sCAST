import type { CommunityFragranceSnapshot, CommunityPost } from '@/components/community/communityPosts';
import { isArenaReasonKey, type ArenaReasonKey } from './arenaTwists.ts';

export interface ArenaBattleSide {
  key: string;
  name: string;
  brand?: string;
  imageUrl?: string;
  descriptor: string;
}

export interface ArenaBattle {
  id: string;
  title: string;
  scenario: string;
  left: ArenaBattleSide;
  right: ArenaBattleSide;
  votes: Record<string, number>;
  viewerVote: string | null;
  // Server-synced "why it won" reason for this viewer's pick (cross-device).
  viewerReason: ArenaReasonKey | null;
}

function battleOptions(post: CommunityPost): [string, string] | null {
  const options = post.metadata?.options;
  if (!Array.isArray(options) || options.length !== 2) return null;
  const left = typeof options[0] === 'string' ? options[0].trim() : '';
  const right = typeof options[1] === 'string' ? options[1].trim() : '';
  if (!left || !right) return null;
  if (left.toLowerCase() === right.toLowerCase()) return null;
  return [left, right];
}

function sideFromOption(option: string, fragrance: CommunityFragranceSnapshot | undefined): ArenaBattleSide {
  return {
    key: option,
    name: fragrance?.name?.trim() || option,
    ...(fragrance?.brand?.trim() ? { brand: fragrance.brand.trim() } : {}),
    ...(fragrance?.imageUrl?.trim() ? { imageUrl: fragrance.imageUrl.trim() } : {}),
    descriptor: fragrance?.family?.trim() || (fragrance ? 'Classic fragrance' : 'Community option'),
  };
}

export function mapCommunityPostToArenaBattle(post: CommunityPost): ArenaBattle | null {
  if (post.postType !== 'battle') return null;
  const options = battleOptions(post);
  if (!options) return null;

  const [leftOption, rightOption] = options;
  const left = sideFromOption(leftOption, post.fragrances[0]);
  const right = sideFromOption(rightOption, post.fragrances[1]);
  const title = post.title?.trim() || `${left.name} vs ${right.name}`;
  const scenario = post.body.trim() || 'Pick the fragrance that wins this matchup.';
  const votes = {
    [left.key]: Math.max(0, Number(post.votes[left.key]) || 0),
    [right.key]: Math.max(0, Number(post.votes[right.key]) || 0),
  };
  const viewerVote =
    post.viewerVote === left.key || post.viewerVote === right.key ? post.viewerVote : null;
  const viewerReason =
    viewerVote && typeof post.viewerVoteReason === 'string' && isArenaReasonKey(post.viewerVoteReason)
      ? post.viewerVoteReason
      : null;

  return {
    id: post.id,
    title,
    scenario,
    left,
    right,
    votes,
    viewerVote,
    viewerReason,
  };
}
