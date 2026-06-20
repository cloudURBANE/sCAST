import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveArenaFamilyFromDetail } from './arenaFamilyResolver.ts';

test('resolveArenaFamilyFromDetail uses direct family labels when present', () => {
  assert.equal(resolveArenaFamilyFromDetail({ family: ' Woody Aromatic ' }), 'Woody Aromatic');
  assert.equal(resolveArenaFamilyFromDetail({ raw: { fragrance_family: 'Fresh Citrus' } }), 'Fresh Citrus');
});

test('resolveArenaFamilyFromDetail derives a label from accords and scent axes', () => {
  assert.equal(
    resolveArenaFamilyFromDetail({
      derived_metrics: {
        main_accords: {
          top_accords: ['amber', 'vanilla'],
        },
      },
    }),
    'amber',
  );
  assert.equal(
    resolveArenaFamilyFromDetail({
      scent_vector: {
        woodiness: 9,
        freshness: 4,
      },
    }),
    'Woodiness',
  );
});

test('resolveArenaFamilyFromDetail rejects placeholder family labels', () => {
  assert.equal(resolveArenaFamilyFromDetail({ family: 'Classic fragrance' }), null);
  assert.equal(resolveArenaFamilyFromDetail({ family: 'Unknown Family' }), null);
});
