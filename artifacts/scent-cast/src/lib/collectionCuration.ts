import type { BeamProposalItem } from "./beamAgentClient.ts";
import { vaultIdentityKey } from "./vaultIdentity.ts";

export type CurateCollectionResult = {
  added: number;
  total: number;
  failedItems: BeamProposalItem[];
};

/** Stable across retries so an interrupted add cannot create a second vault row. */
export function stableProposalItemId(item: BeamProposalItem): string {
  const identity =
    vaultIdentityKey(item.brand, item.name) || item.name.trim().toLowerCase();
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `beam-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}
