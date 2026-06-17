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

test('pickResumeCurationTarget prefers a ready deep-linked jobKey', () => {
  const items = [
    readyItem({ jobKey: 'job-a' }),
    readyItem({ jobKey: 'job-b', name: 'Other' }),
  ];
  assert.equal(pickResumeCurationTarget(items, 'job-b')?.jobKey, 'job-b');
});

test('pickResumeCurationTarget falls back to the first ready item', () => {
  const items = [
    readyItem({ jobKey: 'pending-1', status: 'pending', ready: false }),
    readyItem({ jobKey: 'ready-1' }),
  ];
  // Deep-linked jobKey not ready → fall back to first ready.
  assert.equal(pickResumeCurationTarget(items, 'pending-1')?.jobKey, 'ready-1');
  // No jobKey → first ready.
  assert.equal(pickResumeCurationTarget(items, null)?.jobKey, 'ready-1');
});

test('pickResumeCurationTarget returns null when nothing is ready', () => {
  const items = [readyItem({ status: 'pending', ready: false })];
  assert.equal(pickResumeCurationTarget(items, 'job-1'), null);
  assert.equal(pickResumeCurationTarget([], null), null);
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
