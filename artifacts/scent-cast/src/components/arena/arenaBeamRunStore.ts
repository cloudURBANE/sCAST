/**
 * Per-user Scent Beam run stats (best score, total runs, total Beam Power
 * claimed), persisted in localStorage so streak/best framing survives
 * remounts and revisits. Mirrors the guarded-storage pattern used by
 * arenaReasonStore.ts: every read/write is wrapped so unavailable or corrupt
 * storage degrades to zeros instead of throwing.
 *
 * Keyed by a caller-supplied userKey (the component passes the auth email or
 * "guest").
 */

const STORAGE_KEY = "scentbeam_arena_beam_runs_v1";

export interface BeamRunStats {
  bestScore: number;
  totalRuns: number;
  totalBeamPower: number;
}

const EMPTY_STATS: BeamRunStats = { bestScore: 0, totalRuns: 0, totalBeamPower: 0 };

function sanitizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  return floored > 0 ? floored : 0;
}

function sanitizeStats(entry: unknown): BeamRunStats {
  if (typeof entry !== "object" || entry === null) return { ...EMPTY_STATS };
  const record = entry as Record<string, unknown>;
  return {
    bestScore: sanitizeCount(record.bestScore),
    totalRuns: sanitizeCount(record.totalRuns),
    totalBeamPower: sanitizeCount(record.totalBeamPower),
  };
}

function readAll(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeStats(userKey: string, stats: BeamRunStats): void {
  if (typeof window === "undefined") return;
  try {
    const all = readAll();
    all[userKey] = stats;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage can be unavailable (private mode, quota) — stats simply fall
    // back to in-session memory, which is no worse than before.
  }
}

export function readBeamRunStats(userKey: string): BeamRunStats {
  return sanitizeStats(readAll()[userKey]);
}

export function recordBeamRunEnd(
  userKey: string,
  score: number,
): { stats: BeamRunStats; isNewBest: boolean } {
  const previous = readBeamRunStats(userKey);
  const cleanScore = sanitizeCount(score);
  const isNewBest = cleanScore > previous.bestScore && cleanScore > 0;
  const stats: BeamRunStats = {
    bestScore: Math.max(previous.bestScore, cleanScore),
    totalRuns: previous.totalRuns + 1,
    totalBeamPower: previous.totalBeamPower,
  };
  writeStats(userKey, stats);
  return { stats, isNewBest };
}

export function recordBeamPowerClaim(userKey: string, beamPower: number): BeamRunStats {
  const previous = readBeamRunStats(userKey);
  const stats: BeamRunStats = {
    ...previous,
    totalBeamPower: previous.totalBeamPower + sanitizeCount(beamPower),
  };
  writeStats(userKey, stats);
  return stats;
}
