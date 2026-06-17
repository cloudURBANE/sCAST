// Browser client for the Beam Agent's curation queue.
//
// Talks to the Express API (same-origin `/api`, exactly like pushNotifications's
// `/api/push/*` calls): GET /api/beam-agent/curation/pending (bearer auth). The
// Beam Agent queues any recommended fragrance it could NOT resolve against the
// catalog for background enrichment; once enrichment lands, that fragrance is
// "ready" and the user can open its detail card and add it to the vault.
//
// Everything degrades quietly: an unconfigured/unreachable server, a non-ok
// response, or a malformed body all resolve to `[]` rather than throwing — the
// resume-on-return flow must never block or crash the normal app open.

import type { Fragrance } from '@/components/Wardrobe';
// Relative (not `@/`) so this module — and its test — run under the node test
// runner, which has no path-alias resolution. (`@/` type-only imports are fine;
// they're erased at runtime, but `proposalItemToFragrance` is a real value.)
import { proposalItemToFragrance } from './scentMissionClient.ts';

/** One pending/ready beam-curated fragrance, mirrors the api-server contract. */
export interface CurationItem {
  jobKey: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  name: string;
  brand: string | null;
  /** True once enrichment completed — `ready === status === "completed"`. */
  ready: boolean;
  lastRequestedAt: string;
}

/** Narrow `unknown` to the curation status union, defaulting to `pending`. */
function asCurationStatus(value: unknown): CurationItem['status'] {
  return value === 'processing' || value === 'completed' || value === 'failed'
    ? value
    : 'pending';
}

/**
 * Coerce one raw API entry into a `CurationItem`, dropping anything without a
 * usable `jobKey`/`name`. Pure (no fetch/DOM) so it can be unit-tested and so a
 * partially-malformed list still yields the well-formed rows. Exported for tests.
 */
export function parseCurationItem(raw: unknown): CurationItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const jobKey = typeof record.jobKey === 'string' ? record.jobKey.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!jobKey || !name) return null;
  const status = asCurationStatus(record.status);
  return {
    jobKey,
    status,
    name,
    brand: typeof record.brand === 'string' && record.brand.trim() ? record.brand.trim() : null,
    // Trust the server's `ready` when present, but keep it consistent with the
    // contract's `ready === status === "completed"` invariant either way.
    ready: typeof record.ready === 'boolean' ? record.ready : status === 'completed',
    lastRequestedAt:
      typeof record.lastRequestedAt === 'string' ? record.lastRequestedAt : '',
  };
}

/** Parse the `{ items: [...] }` envelope into a clean `CurationItem[]`. Pure. */
export function parseCurationResponse(body: unknown): CurationItem[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map(parseCurationItem)
    .filter((item): item is CurationItem => item !== null);
}

/**
 * Project a ready curation item onto a throwaway `Fragrance` the detail modal can
 * display. The enrichment data itself is fetched by the modal's normal detail
 * path (keyed off brand+name); this only carries enough identity to open the card
 * and feed the "Add to vault" path. Mirrors `proposalItemToFragrance` so the two
 * non-vault entry points produce the same minimal shape. Pure — runs under node.
 */
export function curationItemToFragrance(item: CurationItem): Fragrance {
  return proposalItemToFragrance({
    name: item.name,
    brand: item.brand ?? '',
    notes: [],
    accords: [],
  });
}

/**
 * Choose which ready curation to surface on app open / deep-link, given the
 * fetched list and an optional `?curation=<jobKey>` from the push deep-link:
 *   - if the deep-linked jobKey is present AND ready, open exactly that one;
 *   - otherwise open the first ready item (resume the most recent finished pick);
 *   - if nothing is ready, return null (the queue is still pending — no UI).
 * Pure, so it is unit-tested under the node runner.
 */
export function pickResumeCurationTarget(
  items: CurationItem[],
  jobKey?: string | null,
): CurationItem | null {
  const requested = jobKey ? items.find((item) => item.jobKey === jobKey) : undefined;
  if (requested && requested.ready) return requested;
  return items.find((item) => item.ready) ?? null;
}

/**
 * Fetch the signed-in user's pending/ready beam curations. Returns `[]` on any
 * non-ok response or thrown error so callers (resume-on-return, the push
 * deep-link) can treat "no curations" and "couldn't load" identically — neither
 * is worth interrupting the user over.
 */
export async function getPendingCuration(authToken: string): Promise<CurationItem[]> {
  try {
    const res = await fetch('/api/beam-agent/curation/pending', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return [];
    return parseCurationResponse(await res.json());
  } catch {
    return [];
  }
}
