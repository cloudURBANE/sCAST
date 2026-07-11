import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addWardrobeImageTarget,
  hasWardrobeImageReference,
  includesWardrobeImageTarget,
  removeWardrobeImageTarget,
  wardrobeImageTargetKey,
} from './wardrobeImageRecovery.ts';

test('per-row image targets coexist and clearing one preserves the other', () => {
  const first = { id: 'first', imageUrl: '' };
  const second = { id: 'second', imageUrl: '' };

  const both = addWardrobeImageTarget(addWardrobeImageTarget([], first), second);
  assert.deepEqual(both.map(wardrobeImageTargetKey), ['id:first', 'id:second']);

  const remaining = removeWardrobeImageTarget(both, first);
  assert.equal(includesWardrobeImageTarget(remaining, first), false);
  assert.equal(includesWardrobeImageTarget(remaining, second), true);
});

test('server row id is the canonical coordinator key once available', () => {
  assert.equal(
    wardrobeImageTargetKey({ id: 'client-id', _dbId: 'server-id' }),
    'db:server-id',
  );
});

test('only a non-empty image reference counts as a candidate', () => {
  assert.equal(hasWardrobeImageReference({ imageUrl: '' }), false);
  assert.equal(hasWardrobeImageReference({ imageUrl: '   ' }), false);
  assert.equal(hasWardrobeImageReference({ imageUrl: 'https://cdn.test/bottle.webp' }), true);
});
