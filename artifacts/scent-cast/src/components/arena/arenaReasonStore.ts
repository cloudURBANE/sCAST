import { isArenaReasonKey, type ArenaReasonKey } from "@/components/arena/arenaTwists";

/**
 * Per-battle "why it won" reason memory.
 *
 * The reason picker is local UI state, but the arena remounts the battle stage
 * whenever the viewer cycles to another battle and back (the stage is keyed on
 * `battle.id`). Without persistence the picker re-opened on every revisit even
 * after the viewer had already chosen a reason or skipped it. This store keeps
 * the choice in localStorage so a revisited battle restores the resolved state
 * instead of prompting again.
 */

const STORAGE_KEY = "scentbeam_arena_reasons_v1";

export interface ArenaReasonEntry {
  reason: ArenaReasonKey | null;
  declined: boolean;
}

const EMPTY_ENTRY: ArenaReasonEntry = { reason: null, declined: false };

function readAll(): Record<string, ArenaReasonEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, ArenaReasonEntry>;
  } catch {
    return {};
  }
}

export function readArenaReason(battleId: string): ArenaReasonEntry {
  const entry = readAll()[battleId];
  if (!entry || typeof entry !== "object") return EMPTY_ENTRY;
  const reason =
    typeof entry.reason === "string" && isArenaReasonKey(entry.reason)
      ? entry.reason
      : null;
  return { reason, declined: Boolean(entry.declined) };
}

export function writeArenaReason(battleId: string, entry: ArenaReasonEntry): void {
  if (typeof window === "undefined") return;
  try {
    const all = readAll();
    all[battleId] = { reason: entry.reason, declined: entry.declined };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage can be unavailable (private mode, quota) — the picker simply
    // falls back to in-session memory, which is no worse than before.
  }
}
