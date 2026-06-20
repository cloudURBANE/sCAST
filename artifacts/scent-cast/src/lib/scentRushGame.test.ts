import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateClientRushScore } from './scentRushGame.ts';
import type { RushEventOutcome, RushPlanEvent } from './scentRushClient.ts';

test('client preview scoring follows the server-readable constants', () => {
  const plan: RushPlanEvent[] = [
    { id: 'a', atMs: 1000, lane: 0, kind: 'orb', correct: true, scenarioCompatible: true },
    { id: 'b', atMs: 2000, lane: 1, kind: 'orb', correct: true, scenarioCompatible: false },
    { id: 'h', atMs: 3000, lane: 1, kind: 'hazard', hazardType: 'rain-splash' },
    { id: 'n', atMs: 4000, lane: 2, kind: 'npc' },
  ];
  const outcomes: RushEventOutcome[] = [
    { eventId: 'a', atMs: 1000, outcome: 'collected' },
    { eventId: 'b', atMs: 2000, outcome: 'collected' },
    { eventId: 'h', atMs: 3000, outcome: 'hit' },
    { eventId: 'n', atMs: 4000, outcome: 'positive' },
  ];
  const result = calculateClientRushScore(plan, outcomes);
  assert.equal(result.score, 350);
  assert.deepEqual(result.collectedOrbIds, ['a', 'b']);
  assert.equal(result.hazardsHit, 1);
});
