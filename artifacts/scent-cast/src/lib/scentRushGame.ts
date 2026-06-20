import type { RushEventOutcome, RushPlanEvent } from './scentRushClient';

export function calculateClientRushScore(plan: RushPlanEvent[], outcomes: RushEventOutcome[]) {
  const byId = new Map(outcomes.map((outcome) => [outcome.eventId, outcome]));
  let score = 0;
  let combo = 0;
  let maximumPossibleScore = 0;
  let maximumCombo = 0;
  let hazardsHit = 0;
  const collectedOrbIds: string[] = [];
  for (const event of plan) {
    const outcome = byId.get(event.id);
    if (event.kind === 'orb') {
      if (event.correct) {
        maximumCombo += 1;
        maximumPossibleScore += 100 + (event.scenarioCompatible ? 150 : 0) + Math.min(100, Math.max(0, maximumCombo - 1) * 25);
      } else maximumCombo = 0;
      if (outcome?.outcome === 'collected') {
        collectedOrbIds.push(event.id);
        if (event.correct) {
          combo += 1;
          score += 100 + (event.scenarioCompatible ? 150 : 0) + Math.min(100, Math.max(0, combo - 1) * 25);
        } else combo = 0;
      }
    } else if (event.kind === 'hazard') {
      maximumPossibleScore += 75;
      if (outcome?.outcome === 'hit') { hazardsHit += 1; score -= 125; combo = 0; }
      else if (outcome?.outcome === 'cleared') score += 75;
    } else if (event.kind === 'npc') {
      maximumPossibleScore += 100;
      if (outcome?.outcome === 'positive') score += 100;
    }
  }
  score = Math.max(0, score);
  return { score, maximumPossibleScore, performance: maximumPossibleScore ? Math.min(1, score / maximumPossibleScore) : 0, collectedOrbIds, hazardsHit };
}

export async function digestRushEvents(events: RushEventOutcome[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
