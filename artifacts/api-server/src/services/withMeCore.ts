export const MAX_WITH_ME_FRAGRANCES = 500;

export type WithMeState = {
  enabled: boolean;
  fragranceIds: string[];
  updatedAt: string | null;
};

export type WithMeUpdate = WithMeState;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWithMeUpdate(input: unknown):
  | { ok: true; value: WithMeUpdate }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "enabled, fragranceIds, and updatedAt are required" };
  }
  const record = input as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (!Array.isArray(record.fragranceIds)) {
    return { ok: false, error: "fragranceIds must be an array" };
  }
  if (record.fragranceIds.length > MAX_WITH_ME_FRAGRANCES) {
    return { ok: false, error: `fragranceIds cannot contain more than ${MAX_WITH_ME_FRAGRANCES} items` };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of record.fragranceIds) {
    if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
      return { ok: false, error: "fragranceIds must contain only wardrobe row UUIDs" };
    }
    const id = value.trim().toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(record, "updatedAt")) {
    return { ok: false, error: "updatedAt is required" };
  }
  const updatedAt = record.updatedAt;
  if (updatedAt !== null && (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)))) {
    return { ok: false, error: "updatedAt must be an ISO timestamp or null" };
  }
  return {
    ok: true,
    value: {
      enabled: record.enabled,
      fragranceIds: record.enabled ? ids : [],
      updatedAt: updatedAt === null ? null : new Date(updatedAt as string).toISOString(),
    },
  };
}

export function scopeRowsWithMe<T extends { id: string }>(
  rows: T[],
  state: Pick<WithMeState, "enabled" | "fragranceIds">,
): T[] {
  if (!state.enabled) return rows;
  const selected = new Set(state.fragranceIds.map((id) => id.toLowerCase()));
  return rows.filter((row) => selected.has(row.id.toLowerCase()));
}

