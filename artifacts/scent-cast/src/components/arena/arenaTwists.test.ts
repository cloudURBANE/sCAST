import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArenaBattle } from './arenaBattleMapper.ts';
import { arenaPercentFor, arenaWinner, buildArenaTwist } from './arenaTwists.ts';

const battle: ArenaBattle = {
  id: 'battle-1',
  title: 'Date night',
  scenario: 'Pick one.',
  left: {
    fragranceId: 'catalog:creed:aventus',
    beamSupporters: 0,
    totalBeamPower: 0,
    key: 'A',
    name: 'Aventus',
    brand: 'Creed',
    descriptor: 'Fruity Chypre',
  },
  right: {
    fragranceId: 'catalog:tom-ford:oud-wood',
    beamSupporters: 0,
    totalBeamPower: 0,
    key: 'B',
    name: 'Oud Wood',
    brand: 'Tom Ford',
    descriptor: 'Woody Oriental',
  },
  votes: { A: 7, B: 3 },
  viewerVote: null,
  viewerReason: null,
};

test('computes winner and rounded percentages from saved votes', () => {
  assert.equal(arenaWinner(battle)?.name, 'Aventus');
  assert.equal(arenaPercentFor(battle, 'A'), 70);
  assert.equal(arenaPercentFor(battle, 'B'), 30);
});

test('uses low-vote twist copy without inventing crowd segments', () => {
  const twist = buildArenaTwist({ ...battle, votes: { A: 1, B: 1 } }, 'A', 'better_projection');

  assert.equal(twist.title, 'Early read');
  assert.match(twist.body, /2 saved votes/);
  assert.doesNotMatch(twist.body, /owners|collectors|demographic|age|gender|geography/i);
});

test('calls out when the viewer picks against the saved tally', () => {
  const twist = buildArenaTwist(battle, 'B', null);

  assert.equal(twist.title, 'Against the room');
  assert.match(twist.body, /70%/);
});
