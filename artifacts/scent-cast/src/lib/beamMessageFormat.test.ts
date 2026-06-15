import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLISHED_CATALOG_UNAVAILABLE,
  cleanAgentText,
  detectCatalogUnavailable,
  formatAgentResponse,
  parseBeamMessage,
  parseInlineSegments,
  toPlainText,
  type BeamBlock,
} from './beamMessageFormat.ts';

test('parseInlineSegments marks bold runs and strips other markdown', () => {
  const segs = parseInlineSegments('Start with **Black Afgano** — a `dark` _smoky_ pick');
  assert.deepEqual(segs, [
    { text: 'Start with' },
    { text: 'Black Afgano', bold: true },
    { text: '— a dark smoky pick' },
  ]);
});

test('parseInlineSegments resolves markdown links to their text', () => {
  const segs = parseInlineSegments('See [Fragrantica](https://example.com/x) for notes');
  assert.equal(segs.map((s) => s.text).join(' '), 'See Fragrantica for notes');
  assert.ok(!segs.some((s) => /https?:/.test(s.text)));
});

test('no raw markdown tokens survive parsing', () => {
  const raw = '## Tokyo Trip Collection\n\n**From Your Vault**\n\n- **Creed Viking** — daytime energy\n\n---\n\nWhy this fits: it works.';
  const flat = toPlainText(raw);
  assert.ok(!/[*#`]|---/.test(flat), `unexpected markdown in: ${flat}`);
});

test('parseBeamMessage builds headings, lists and paragraphs', () => {
  const raw = [
    '## Tokyo Trip Collection',
    '',
    'A clean, confident rotation.',
    '',
    '**From Your Vault**',
    '- **Nasomatto Black Afgano** — Day/Night wildcard',
    '- **Creed Viking** — Daytime energy',
    '',
    'Why this fits: balanced for humidity.',
  ].join('\n');

  const blocks = parseBeamMessage(raw);
  const kinds = blocks.map((b) => b.type);
  assert.deepEqual(kinds, ['heading', 'paragraph', 'heading', 'list', 'paragraph']);

  const list = blocks.find((b): b is Extract<BeamBlock, { type: 'list' }> => b.type === 'list');
  assert.ok(list);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0][0].text, 'Nasomatto Black Afgano');
  assert.equal(list.items[0][0].bold, true);
});

test('cleanAgentText drops internal lines and collapses repeated catalog rows', () => {
  const raw = [
    'Searching the catalog... 0 fragrances found',
    'Searching the catalog... 0 fragrances found',
    'Searching the catalog... 0 fragrances found',
    'tool_result: returned no unowned fragrances',
    "Here is a vault rotation for you.",
  ].join('\n');

  const cleaned = cleanAgentText(raw);
  assert.equal(cleaned, 'Here is a vault rotation for you.');
  assert.ok(!/0 fragrances found/i.test(cleaned));
  assert.ok(!/unowned/i.test(cleaned));
});

test('detectCatalogUnavailable recognizes internal catalog-empty wording', () => {
  assert.equal(detectCatalogUnavailable('The catalog returned no unowned fragrances.'), true);
  assert.equal(detectCatalogUnavailable("I couldn't reach the catalog right now."), true);
  assert.equal(detectCatalogUnavailable('Here are three great picks from your vault.'), false);
});

test('formatAgentResponse fronts catalog failures with polished copy', () => {
  const { text, catalogUnavailable } = formatAgentResponse(
    'tool_result: returned no unowned fragrances\nBut your vault still has strong options.',
  );
  assert.equal(catalogUnavailable, true);
  assert.ok(text.startsWith(POLISHED_CATALOG_UNAVAILABLE));
  assert.ok(text.includes('your vault still has strong options'));
  assert.ok(!/unowned/i.test(text));
});

test('formatAgentResponse leaves a healthy answer untouched', () => {
  const raw = 'Start with **Creed Viking** for daytime energy.';
  const { text, catalogUnavailable } = formatAgentResponse(raw);
  assert.equal(catalogUnavailable, false);
  assert.equal(text, raw);
});
