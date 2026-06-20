/**
 * Pure scoring/eligibility logic for the Arena "Crowd vs You" mode.
 *
 * Server-authoritative and side-effect free so it is unit-testable without a DB.
 * The route layer (communityPosts.ts) re-reads the live community_votes tally
 * and feeds it through these helpers — never trust a client tally for scoring.
 *
 * Tuned for this app's CURRENT low vote volume; all thresholds are named here so
 * they can be raised in one place as the room grows (see docs/arena spec B.5).
 */

/** Below this many total votes a "winner" is noise, so the battle isn't served. */
export const CROWD_READ_MIN_VOTES = 8;

/** How many reads make up a daily curated set. */
export const CROWD_READ_DAILY_TARGET = 3;

/**
 * The lead must be *stable*: at tiny N a 2-vote gap, scaling to ≥15% of total as
 * N grows, so a single new vote landing between serve and submit can't flip the
 * "answer". Used for both feed eligibility and submit-time leader resolution.
 */
export function crowdReadMinMargin(total: number): number {
  return Math.max(2, Math.ceil(0.15 * Math.max(0, total)));
}

/**
 * Feed eligibility: a battle is playable only when it has enough votes AND a
 * stable, clear lead the user can actually read. (Viewer-already-saw exclusion
 * is handled separately in the route.)
 */
export function isCrowdReadEligible(leftCount: number, rightCount: number): boolean {
  const left = Math.max(0, Math.trunc(leftCount));
  const right = Math.max(0, Math.trunc(rightCount));
  const total = left + right;
  if (total < CROWD_READ_MIN_VOTES) return false;
  if (Math.abs(left - right) < crowdReadMinMargin(total)) return false;
  return left !== right;
}

/**
 * Submit-time leader resolution. Returns the leading option key, or null when
 * there is no clear leader (margin below threshold or a tie) → that's a push,
 * which leaves the streak unchanged. Note this checks margin only (not the
 * MIN_VOTES feed gate): by submit the battle was already served as eligible, and
 * a vote landing in between is the only realistic way the lead goes unclear.
 */
export function resolveCrowdLeader(
  leftKey: string,
  leftCount: number,
  rightKey: string,
  rightCount: number,
): string | null {
  const left = Math.max(0, Math.trunc(leftCount));
  const right = Math.max(0, Math.trunc(rightCount));
  const total = left + right;
  if (total <= 0) return null;
  if (Math.abs(left - right) < crowdReadMinMargin(total)) return null;
  if (left === right) return null;
  return left > right ? leftKey : rightKey;
}

export type CrowdReadOutcome = "correct" | "wrong" | "push";

/**
 * Outcome of a single read. A push (no clear leader at reveal) never counts as a
 * scored attempt for streak purposes.
 */
export function crowdReadOutcome(
  predictedChoice: string,
  leaderAtReveal: string | null,
): CrowdReadOutcome {
  if (leaderAtReveal === null) return "push";
  return predictedChoice === leaderAtReveal ? "correct" : "wrong";
}

/**
 * Beam Streak transition. Correct → +1 (flat at launch); wrong → reset to 0;
 * push → unchanged. Closeness-weighting is a later phase.
 */
export function nextStreak(previousStreak: number, outcome: CrowdReadOutcome): number {
  const prev = Math.max(0, Math.trunc(previousStreak));
  if (outcome === "correct") return prev + 1;
  if (outcome === "wrong") return 0;
  return prev;
}

/**
 * The Beam Streak is a *daily* streak: it survives same-day and next-day plays
 * but breaks if a calendar day is skipped. Given the last-played date (a
 * `YYYY-MM-DD` string, or null for a first-ever read) and today's date, returns
 * whether the stored streak is still alive — the route uses this to decide
 * whether to carry the previous streak or reset to 0 before scoring this read.
 */
export function isStreakContinuable(lastPlayedOn: string | null, today: string): boolean {
  if (!lastPlayedOn) return true;
  const last = Date.parse(`${lastPlayedOn}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(last) || Number.isNaN(now)) return true;
  const diffDays = Math.round((now - last) / 86_400_000);
  return diffDays <= 1;
}

/** Accuracy as a 0–100 integer percent; 0 when no scored reads yet. */
export function crowdReadAccuracy(correctReads: number, totalReads: number): number {
  const total = Math.max(0, Math.trunc(totalReads));
  if (total <= 0) return 0;
  const correct = Math.max(0, Math.trunc(correctReads));
  return Math.round((correct / total) * 100);
}
