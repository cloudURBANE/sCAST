import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyTurnOutcome,
  composerPlaceholderForState,
  deriveFlowState,
  formatKitTitle,
  hasPendingLanguage,
  looksLikeRecommendation,
  normalizeLocation,
  parseDateLabel,
  recapLabelForOutcome,
  recommendCtaForState,
  sanitizeDestination,
} from './beamAnswerContract.ts';

test('sanitizeDestination drops run-on word-salad and keeps real places', () => {
  assert.equal(sanitizeDestination('Chicago I want to sneak bike she it'), '');
  assert.equal(sanitizeDestination('Chicago'), 'Chicago');
  assert.equal(sanitizeDestination('New York'), 'New York');
  assert.equal(sanitizeDestination('Salt Lake City'), 'Salt Lake City');
  assert.equal(sanitizeDestination(undefined), '');
});

/* ---------------------------------------------------------------- location -- */

test('normalizeLocation formats a city + US state abbreviation', () => {
  assert.equal(normalizeLocation('duluth mn'), 'Duluth, MN');
  assert.equal(normalizeLocation('Duluth MN'), 'Duluth, MN');
  assert.equal(normalizeLocation('duluth, mn'), 'Duluth, MN');
  assert.equal(normalizeLocation('new york ny'), 'New York, NY');
});

test('normalizeLocation leaves a plain city untouched (no bogus state)', () => {
  assert.equal(normalizeLocation('tokyo'), 'Tokyo');
  assert.equal(normalizeLocation('san francisco'), 'San Francisco');
  // "in" / "to" are 2-letter words but not states — must not be uppercased.
  assert.equal(normalizeLocation('go to'), 'Go To');
});

test('normalizeLocation never title-cases a state abbreviation into "Mn"', () => {
  assert.ok(!normalizeLocation('duluth mn').includes('Mn'));
  assert.equal(normalizeLocation(''), '');
});

test('parseDateLabel preserves date context', () => {
  assert.equal(parseDateLabel('Duluth mn tomorrow'), 'Tomorrow');
  assert.equal(parseDateLabel('something tonight'), 'Tonight');
  assert.equal(parseDateLabel('plans this weekend'), 'This Weekend');
  assert.equal(parseDateLabel('no date here'), null);
});

test('formatKitTitle produces clean, human titles', () => {
  assert.equal(formatKitTitle({ destination: 'tokyo', month: 'august' }), 'Your Tokyo · August kit');
  assert.equal(
    formatKitTitle({ destination: 'duluth mn', dateLabel: 'Tomorrow' }),
    'Your Duluth, MN · Tomorrow kit',
  );
  assert.equal(formatKitTitle({ destination: 'duluth mn' }), 'Your Duluth, MN kit');
  assert.equal(formatKitTitle({ destination: '' }), '');
});

/* -------------------------------------------------------- completion gate -- */

test('hasPendingLanguage detects "before I commit" stalls', () => {
  assert.ok(hasPendingLanguage('Let me pull your vault taste and search the catalog before I commit to picks.'));
  assert.ok(hasPendingLanguage('Give me a moment to check the catalog.'));
  assert.ok(!hasPendingLanguage('Aventus Cologne is a confident, controlled pick.'));
});

test('looksLikeRecommendation detects real pick structure', () => {
  assert.ok(looksLikeRecommendation('**Aventus Cologne** — mandarin, ginger, spearmint up top.'));
  assert.ok(looksLikeRecommendation("Here are your two picks for the trip."));
  assert.ok(!looksLikeRecommendation('Let me search the catalog first.'));
});

test('classifyTurnOutcome: the stall message is NOT answered', () => {
  assert.equal(
    classifyTurnOutcome({
      text: 'Let me pull your vault taste and search the catalog before I commit to picks.',
      deliveredResult: false,
      emittedCues: false,
    }),
    'pending',
  );
});

test('classifyTurnOutcome: real text picks are answered', () => {
  assert.equal(
    classifyTurnOutcome({
      text: '**Aventus Cologne** — mandarin, ginger, spearmint. **Sauvage** — fresh and bold.',
      deliveredResult: false,
      emittedCues: false,
    }),
    'answered',
  );
});

test('classifyTurnOutcome: a delivered card/proposal is answered', () => {
  assert.equal(
    classifyTurnOutcome({ text: 'Here is your kit.', deliveredResult: true, emittedCues: false }),
    'answered',
  );
});

test('classifyTurnOutcome: a clarifying question needs more info', () => {
  assert.equal(
    classifyTurnOutcome({
      text: 'What is the occasion — work, a night out, or something else?',
      deliveredResult: false,
      emittedCues: true,
    }),
    'needs_more_info',
  );
});

test('recapLabelForOutcome is truthful per outcome', () => {
  assert.equal(recapLabelForOutcome('answered', 12), 'Answered in 12s');
  assert.equal(recapLabelForOutcome('pending', 13), 'Still working · 13s');
  assert.equal(recapLabelForOutcome('needs_more_info', 5), 'Asked a question · 5s');
});

/* ------------------------------------------------------------ state machine -- */

test('deriveFlowState: a completed stall is an actionable error, not answered', () => {
  assert.equal(
    deriveFlowState({
      busy: false,
      catalogFailure: false,
      hasMatch: false,
      lastTurnOutcome: 'pending',
      hasClarifyingCues: false,
      conversationStarted: true,
    }),
    'error',
  );
});

test('deriveFlowState: text-only answer is answered even without a proposal', () => {
  assert.equal(
    deriveFlowState({
      busy: false,
      catalogFailure: false,
      hasMatch: false,
      lastTurnOutcome: 'answered',
      hasClarifyingCues: false,
      conversationStarted: true,
    }),
    'answered',
  );
});

test('deriveFlowState: busy is always thinking; cold start is idle', () => {
  assert.equal(
    deriveFlowState({
      busy: true,
      catalogFailure: false,
      hasMatch: false,
      lastTurnOutcome: null,
      hasClarifyingCues: false,
      conversationStarted: true,
    }),
    'thinking',
  );
  assert.equal(
    deriveFlowState({
      busy: false,
      catalogFailure: false,
      hasMatch: false,
      lastTurnOutcome: null,
      hasClarifyingCues: false,
      conversationStarted: false,
    }),
    'idle',
  );
});

test('recommendCtaForState changes meaning with state', () => {
  assert.deepEqual(recommendCtaForState('collecting_cues'), {
    hidden: false,
    disabled: false,
    label: 'Recommend now',
  });
  assert.equal(recommendCtaForState('thinking').disabled, true);
  assert.equal(recommendCtaForState('thinking').label, 'Finding picks…');
  assert.equal(recommendCtaForState('answered').hidden, true);
  assert.equal(recommendCtaForState('error').label, 'Try again');
});

test('composerPlaceholderForState adapts, keeps cold-start to caller', () => {
  assert.equal(composerPlaceholderForState('idle'), null);
  assert.equal(composerPlaceholderForState('collecting_cues'), null);
  assert.match(composerPlaceholderForState('answered') ?? '', /alternatives/i);
  assert.match(composerPlaceholderForState('needs_more_info') ?? '', /missing detail/i);
  assert.match(composerPlaceholderForState('error') ?? '', /try again/i);
});
