import type { ArenaBattle } from '@/components/arena/arenaBattleMapper';

export const ARENA_REASON_OPTIONS = [
  { key: 'more_attractive', label: 'More attractive' },
  { key: 'safer_choice', label: 'Safer choice' },
  { key: 'better_projection', label: 'Projection' },
  { key: 'better_weather_fit', label: 'Weather fit' },
  { key: 'more_unique', label: 'More unique' },
  { key: 'better_value', label: 'Better value' },
  { key: 'know_both', label: 'Know both' },
] as const;

export type ArenaReasonKey = (typeof ARENA_REASON_OPTIONS)[number]['key'];

export interface ArenaTwist {
  title: string;
  body: string;
}

export function isArenaReasonKey(value: string): value is ArenaReasonKey {
  return ARENA_REASON_OPTIONS.some((option) => option.key === value);
}

export function arenaVoteTotal(battle: ArenaBattle): number {
  return (battle.votes[battle.left.key] ?? 0) + (battle.votes[battle.right.key] ?? 0);
}

export function arenaWinner(battle: ArenaBattle): ArenaBattle['left'] | ArenaBattle['right'] | null {
  const leftVotes = battle.votes[battle.left.key] ?? 0;
  const rightVotes = battle.votes[battle.right.key] ?? 0;
  if (leftVotes === rightVotes) return null;
  return leftVotes > rightVotes ? battle.left : battle.right;
}

export function arenaPercentFor(battle: ArenaBattle, sideKey: string): number {
  const total = arenaVoteTotal(battle);
  if (total <= 0) return 0;
  return Math.round(((battle.votes[sideKey] ?? 0) / total) * 100);
}

export function buildArenaTwist(
  battle: ArenaBattle,
  viewerChoice: string,
  reason?: ArenaReasonKey | null,
): ArenaTwist {
  const total = arenaVoteTotal(battle);
  const winner = arenaWinner(battle);
  const pickedSide = viewerChoice === battle.left.key ? battle.left : battle.right;
  const reasonLabel = reason
    ? ARENA_REASON_OPTIONS.find((option) => option.key === reason)?.label.toLowerCase()
    : null;

  if (total < 4) {
    return {
      title: 'Early read',
      body: reasonLabel
        ? `Your ${reasonLabel} reason is saved on this screen only for now. The crowd result is still forming from ${total} saved ${total === 1 ? 'vote' : 'votes'}.`
        : `This matchup only has ${total} saved ${total === 1 ? 'vote' : 'votes'} so far, so treat the result as an early signal, not a settled verdict.`,
    };
  }

  if (!winner) {
    return {
      title: 'Dead heat',
      body: reasonLabel
        ? `The room is split, and your ${reasonLabel} reason gives ${pickedSide.name} a personal edge without changing the tied server tally.`
        : 'The saved votes are tied, so the next pick has real weight in this matchup.',
    };
  }

  const winnerPct = arenaPercentFor(battle, winner.key);
  if (winner.key !== viewerChoice) {
    return {
      title: 'Against the room',
      body: `${winner.name} leads with ${winnerPct}% of saved votes, while your pick stays marked locally as ${pickedSide.name}.`,
    };
  }

  return {
    title: 'Crowd aligned',
    body: reasonLabel
      ? `${winner.name} leads with ${winnerPct}% of saved votes, and your ${reasonLabel} reason explains why it won your side of the duel.`
      : `${winner.name} leads with ${winnerPct}% of saved votes in this battle.`,
  };
}
