import { normalizeApiBaseUrl } from '@/lib/imageProxy';

export type RushManifest = {
  fragranceId: string;
  version: number;
  displayName: string;
  family: string;
  collectibleNotes: Array<{ id: string; label: string; iconKey: string; weight: number }>;
  supportedScenarios: string[];
  intensity: 'soft' | 'moderate' | 'strong';
  longevity: 'light' | 'moderate' | 'long';
  backgroundTheme: string;
  hazardPool: string[];
  npcReactionPool: string[];
};

export type RushPlanEvent = {
  id: string;
  atMs: number;
  lane: 0 | 1 | 2;
  kind: 'orb' | 'hazard' | 'npc' | 'pickup';
  noteId?: string;
  correct?: boolean;
  scenarioCompatible?: boolean;
  hazardType?: 'overspray-cloud' | 'heat-wave' | 'rain-splash';
  pickupType?: 'sample-vial' | 'atomizer-boost';
};

export type RushEventOutcome = {
  eventId: string;
  outcome: 'collected' | 'missed' | 'hit' | 'cleared' | 'avoided' | 'positive';
  atMs: number;
};

export type RushAction =
  | { type: 'lane'; atMs: number; lane: 0 | 1 | 2 }
  | { type: 'jump'; atMs: number };

export type RushProgressSummary = {
  beamSupporters: number;
  totalBeamPower: number;
  user: {
    freshStartBeamPower: number;
    freshStartBestScore: number;
    freshStartBestPerformance: number;
    totalBeamPower: number;
    maximumBeamPower: number;
  };
};

export type RushRun = {
  runId: string;
  seed: number;
  level: 1;
  manifestVersion: number;
  expiresAt: string;
  durationMs: number;
  manifest: RushManifest;
  eventPlan: RushPlanEvent[];
  progress: RushProgressSummary;
};

export type RushResult = {
  score: number;
  maximumPossibleScore: number;
  performance: number;
  beamPowerEarned: number;
  collectedOrbIds: string[];
  hazardsHit: number;
  previousBest: number;
  newBest: number;
  previousBeamPower: number;
  storedBeamPower: number;
  bestUpgraded: boolean;
  progress: RushProgressSummary;
};

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env?.VITE_API_BASE_URL as string | undefined);
const url = (path: string) => API_BASE_URL ? `${API_BASE_URL}${path}` : path;

async function read<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    const messages: Record<string, string> = {
      fragrance_not_owned: 'Choose a fragrance from your signed-in wardrobe.',
      expired_run: 'This run expired before it could be saved. Start a fresh run.',
      implausible_server_duration: 'This run took too long to verify. Start a fresh run.',
      invalid_event_outcomes: 'The saved run did not match the verified game timeline. Start again.',
      run_not_found: 'This run is no longer available. Start a fresh run.',
    };
    throw new Error(messages[body.error || ''] || body.error || 'Scent Rush is unavailable.');
  }
  return response.json() as Promise<T>;
}

function headers(authToken?: string | null): HeadersInit {
  return { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) };
}

export async function getRushProgress(fragranceId: string, authToken?: string | null): Promise<RushProgressSummary> {
  return read(await fetch(url(`/api/fragrances/${encodeURIComponent(fragranceId)}/rush/progress`), { headers: headers(authToken) }));
}

export async function startRushRun(
  fragrance: { fragranceId: string; name: string; family?: string; notes?: string[] },
  authToken: string,
): Promise<RushRun> {
  return read(await fetch(url(`/api/fragrances/${encodeURIComponent(fragrance.fragranceId)}/rush/runs`), {
    method: 'POST', headers: headers(authToken),
    body: JSON.stringify({ displayName: fragrance.name, family: fragrance.family, notes: fragrance.notes }),
  }));
}

export async function completeRushRun(
  run: RushRun,
  authToken: string,
  payload: { durationMs: number; score: number; collectedOrbIds: string[]; hazardsHit: number; events: RushEventOutcome[]; actions: RushAction[]; eventDigest: string },
): Promise<RushResult> {
  return read(await fetch(url(`/api/fragrances/${encodeURIComponent(run.manifest.fragranceId)}/rush/runs/${encodeURIComponent(run.runId)}/complete`), {
    method: 'POST', headers: headers(authToken), body: JSON.stringify({ ...payload, clientVersion: '1.0.0' }),
  }));
}

export function emitRushEvent(name: string, detail: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('scentbeam:analytics', { detail: { name, ...detail } }));
  } catch {
    // Telemetry is optional and must never interrupt a run.
  }
}
