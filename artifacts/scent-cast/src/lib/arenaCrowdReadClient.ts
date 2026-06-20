import { normalizeApiBaseUrl } from '@/lib/imageProxy';
import {
  mapCommunityPostToArenaBattle,
  type ArenaBattle,
} from '@/components/arena/arenaBattleMapper';
import type { CommunityPostsPage } from '@/components/community/communityPosts';

// Reveal payload returned by POST /api/community/posts/:id/crowd-read.
// Mirrors the backend contract exactly — do not extend without the server agent.
export interface CrowdReadReveal {
  was_correct: boolean;
  /** Option key of the crowd leader, or null = push (no clear leader). */
  leader_at_reveal: string | null;
  /** Option key -> vote count, the reveal tally. */
  tally: Record<string, number>;
  went_with_crowd: boolean;
  current_streak: number;
  best_streak: number;
  /** Lifetime accuracy, 0-100 integer. */
  accuracy: number;
}

// Persisted Beam Streak stats for the signed-in viewer (GET .../crowd-stats).
// Powers the entry card + prompt header before the first read of a session.
export interface CrowdStats {
  current_streak: number;
  best_streak: number;
  accuracy: number;
  total_reads: number;
}

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env?.VITE_API_BASE_URL as string | undefined);

function appApiUrl(path: string): string {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

// Small inlined equivalents of communityPosts.ts's error/parse helpers — kept
// local so this client owns its own error surface (those are not exported).
async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.clone().json()) as { error?: unknown; detail?: unknown; message?: unknown };
    for (const value of [data.error, data.detail, data.message]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    try {
      const text = await res.text();
      if (text.trim()) return text.trim();
    } catch {
      return fallback;
    }
  }
  return fallback;
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, fallback));
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(fallback);
  }
}

/**
 * Fetch today's blind, playable Crowd vs You battles. The feed returns posts
 * with an empty `votes` map (blind) — the tally only arrives on submit. Returns
 * [] for anonymous users (no token), matching the server's empty response.
 */
export async function fetchPlayableCrowdBattles(
  authToken: string | null,
): Promise<ArenaBattle[]> {
  if (!authToken) return [];

  const url = appApiUrl('/api/community/posts?type=battle&playable=1&limit=3');
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
  });

  const page = await readJson<CommunityPostsPage>(
    res,
    `Crowd vs You feed failed with HTTP ${res.status}`,
  );

  return page.posts
    .map(mapCommunityPostToArenaBattle)
    .filter((battle): battle is ArenaBattle => battle !== null);
}

/**
 * Fetch the viewer's persisted Beam Streak stats. Returns null for anonymous
 * users or on any error, so the UI simply falls back to a 0 streak rather than
 * surfacing an error on the entry card.
 */
export async function fetchCrowdStats(authToken: string | null): Promise<CrowdStats | null> {
  if (!authToken) return null;
  try {
    const res = await fetch(appApiUrl('/api/community/arena/crowd-stats'), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as CrowdStats;
  } catch {
    return null;
  }
}

/**
 * Submit both blind taps together and receive the reveal. Both taps must be
 * locked before calling; the caller guards against double-submit.
 */
export async function submitCrowdRead(args: {
  postId: string;
  predictedChoice: string;
  ownPick: string;
  authToken: string;
}): Promise<CrowdReadReveal> {
  const { postId, predictedChoice, ownPick, authToken } = args;
  const res = await fetch(
    appApiUrl(`/api/community/posts/${encodeURIComponent(postId)}/crowd-read`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ predicted_choice: predictedChoice, own_pick: ownPick }),
    },
  );

  return readJson<CrowdReadReveal>(res, `Crowd read failed with HTTP ${res.status}`);
}
