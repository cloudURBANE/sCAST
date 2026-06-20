export const ARENA_BEAM_MIN_SCORE = 8;
export const ARENA_BEAM_MAX_SCORE = 240;
export const ARENA_BEAM_SCORE_STEP = 4;
export const ARENA_BEAM_MAX_POWER = 30;

export type ArenaBeamScoreResult =
  | { ok: true; score: number; beamPower: number }
  | { ok: false; error: string };

export function scoreArenaBeamRun(value: unknown): ArenaBeamScoreResult {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: "score must be a number" };
  }
  const score = Math.floor(value);
  if (score < ARENA_BEAM_MIN_SCORE) {
    return { ok: false, error: `score must be at least ${ARENA_BEAM_MIN_SCORE}` };
  }
  const clampedScore = Math.min(score, ARENA_BEAM_MAX_SCORE);
  const beamPower = Math.max(
    1,
    Math.min(ARENA_BEAM_MAX_POWER, Math.floor(clampedScore / ARENA_BEAM_SCORE_STEP)),
  );
  return { ok: true, score: clampedScore, beamPower };
}

export function cleanArenaBeamRunId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(trimmed)) return null;
  return trimmed;
}

type ArenaBeamFragranceIdentity = {
  fragranceId?: string | null;
  brand?: string | null;
  name?: string | null;
};

function stableArenaFragranceId(brand: string | null | undefined, name: string | null | undefined): string | null {
  const cleanName = name?.trim();
  if (!cleanName) return null;
  const part = (value: string) =>
    value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `catalog:${part(brand?.trim() || "unknown")}:${part(cleanName)}`;
}

export function resolveArenaBeamFragranceId(snapshot: ArenaBeamFragranceIdentity | null | undefined): string | null {
  const explicitId = snapshot?.fragranceId?.trim();
  return explicitId || stableArenaFragranceId(snapshot?.brand, snapshot?.name);
}
