import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  curationItemToFragrance,
  parseCurationItem,
  parseCurationResponse,
  pickResumeCurationTarget,
  type CurationItem,
} from './curationClient.ts';

const readyItem = (over: Partial<CurationItem> = {}): CurationItem => ({
  jobKey: 'job-1',
  status: 'completed',
  name: 'Layton',
  brand: 'Parfums de Marly',
  ready: true,
  enrichmentLevel: 'full',
  lastRequestedAt: '2026-06-17T00:00:00.000Z',
  ...over,
});

test('parseCurationItem coerces a well-formed row and trims', () => {
  const item = parseCurationItem({
    jobKey: '  job-7 ',
    status: 'completed',
    name: '  Aventus ',
    brand: ' Creed ',
    ready: true,
    lastRequestedAt: '2026-06-17T00:00:00.000Z',
  });
  assert.deepEqual(item, {
    jobKey: 'job-7',
    status: 'completed',
    name: 'Aventus',
    brand: 'Creed',
    ready: true,
    enrichmentLevel: 'full',
    lastRequestedAt: '2026-06-17T00:00:00.000Z',
  });
});

test('parseCurationItem drops rows missing jobKey or name, and null garbage', () => {
  assert.equal(parseCurationItem({ jobKey: 'j', name: '' }), null);
  assert.equal(parseCurationItem({ name: 'No key' }), null);
  assert.equal(parseCurationItem(null), null);
  assert.equal(parseCurationItem('nope'), null);
});

test('parseCurationItem defaults: unknown status → pending, ready derived from status', () => {
  const pending = parseCurationItem({ jobKey: 'j', name: 'X', status: 'weird' });
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.ready, false);
  assert.equal(pending?.brand, null);

  // When `ready` is absent it is derived: completed → true.
  const done = parseCurationItem({ jobKey: 'j', name: 'X', status: 'completed' });
  assert.equal(done?.ready, true);
});

test('parseCurationResponse filters malformed rows and tolerates a bad envelope', () => {
  const items = parseCurationResponse({
    items: [
      { jobKey: 'a', name: 'Good', status: 'completed' },
      { jobKey: '', name: 'Bad' },
      42,
      { jobKey: 'b', name: 'AlsoGood', status: 'pending' },
    ],
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.jobKey), ['a', 'b']);

  assert.deepEqual(parseCurationResponse({}), []);
  assert.deepEqual(parseCurationResponse(null), []);
  assert.deepEqual(parseCurationResponse({ items: 'nope' }), []);
});

test('pickResumeCurationTarget opens the deep-linked job only when fully complete', () => {
  const items = [
    readyItem({ jobKey: 'job-a' }),
    readyItem({ jobKey: 'job-b', name: 'Other' }),
  ];
  assert.equal(pickResumeCurationTarget(items, 'job-b')?.jobKey, 'job-b');
});

test('pickResumeCurationTarget NEVER force-opens on a plain load (no jobKey)', () => {
  // Even with a ready item present, no deep-link → no modal. Ready picks surface
  // through the notification feed on a plain open, not a forced card.
  const items = [readyItem({ jobKey: 'ready-1' })];
  assert.equal(pickResumeCurationTarget(items, null), null);
  assert.equal(pickResumeCurationTarget(items, undefined), null);
  assert.equal(pickResumeCurationTarget(items, ''), null);
});

test('pickResumeCurationTarget refuses an incomplete or unfinished deep-link target', () => {
  // status completed but only partially enriched → not openable (the bug class).
  const partial = readyItem({ jobKey: 'job-x', enrichmentLevel: 'partial' });
  assert.equal(pickResumeCurationTarget([partial], 'job-x'), null);
  // still pending → not openable.
  const pending = readyItem({ jobKey: 'job-y', status: 'pending', ready: false, enrichmentLevel: 'none' });
  assert.equal(pickResumeCurationTarget([pending], 'job-y'), null);
  // jobKey not in the list → null.
  assert.equal(pickResumeCurationTarget([readyItem({ jobKey: 'job-z' })], 'missing'), null);
  assert.equal(pickResumeCurationTarget([], 'anything'), null);
});

test('curationItemToFragrance projects a minimal, non-vault Fragrance', () => {
  const fragrance = curationItemToFragrance(readyItem());
  assert.equal(fragrance.name, 'Layton');
  assert.equal(fragrance.brand, 'Parfums de Marly');
  assert.equal(fragrance.imageUrl, '');
  assert.ok(fragrance.id.startsWith('beam-'), 'gets a throwaway client id');
});

test('curationItemToFragrance tolerates a null brand', () => {
  const fragrance = curationItemToFragrance(readyItem({ brand: null }));
  assert.equal(fragrance.brand, '');
  assert.equal(fragrance.name, 'Layton');
});
