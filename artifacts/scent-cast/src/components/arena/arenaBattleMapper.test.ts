import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCommunityPostToArenaBattle } from './arenaBattleMapper.ts';
import type { CommunityPost } from '@/components/community/communityPosts';

const basePost: CommunityPost = {
  id: 'post-1',
  postType: 'battle',
  title: 'Office signature',
  body: 'Which one wins Monday morning?',
  metadata: { options: ['Bleu de Chanel', 'Aventus'] },
  createdAt: '2026-06-11T00:00:00.000Z',
  updatedAt: '2026-06-11T00:00:00.000Z',
  author: { id: 'u1', email: 'user@example.com', shareId: 'user' },
  tags: [],
  fragrances: [
    { name: 'Bleu de Chanel', brand: 'Chanel', imageUrl: 'https://example.com/bleu.jpg', family: 'Woody Aromatic' },
    { name: 'Aventus', brand: 'Creed', imageUrl: 'https://example.com/aventus.jpg' },
  ],
  counts: { comments: 0, reactions: {} },
  votes: { 'Bleu de Chanel': 3, Aventus: 2, Other: 10 },
  viewerReactions: [],
  viewerVote: 'Aventus',
};

test('maps a community battle post into a two-side arena battle', () => {
  const mapped = mapCommunityPostToArenaBattle(basePost);

  assert.equal(mapped?.title, 'Office signature');
  assert.equal(mapped?.scenario, 'Which one wins Monday morning?');
  assert.equal(mapped?.left.brand, 'Chanel');
  assert.equal(mapped?.left.descriptor, 'Woody Aromatic');
  assert.equal(mapped?.right.descriptor, 'Classic fragrance');
  assert.deepEqual(mapped?.votes, { 'Bleu de Chanel': 3, Aventus: 2 });
  assert.equal(mapped?.viewerVote, 'Aventus');
});

test('rejects battle posts without exactly two string options', () => {
  assert.equal(mapCommunityPostToArenaBattle({ ...basePost, metadata: { options: ['Only one'] } }), null);
  assert.equal(mapCommunityPostToArenaBattle({ ...basePost, metadata: { options: ['A', 2] } }), null);
});

test('rejects battle posts whose options collapse to the same vote key', () => {
  assert.equal(
    mapCommunityPostToArenaBattle({ ...basePost, metadata: { options: ['Aventus', ' aventus '] } }),
    null,
  );
});
