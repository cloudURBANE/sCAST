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
import { proposalItemToFragrance } from './scentMissionClient';
import { normalizeApiBaseUrl } from './imageProxy';

const rawApiBase =
  (typeof process !== 'undefined' && process.env?.VITE_API_BASE_URL) ||
  (typeof process !== 'undefined' && process.env?.VITE_API_ORIGIN) ||
  (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_API_BASE_URL || import.meta.env?.VITE_API_ORIGIN));
const API_BASE_URL = normalizeApiBaseUrl(rawApiBase as string | undefined);

function appApiUrl(path: string): string {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

/** One pending/ready beam-curated fragrance, mirrors the api-server contract. */
export interface CurationItem {
  jobKey: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  name: string;
  brand: string | null;
  /**
   * True once enrichment is FULLY complete and the fragrance is addable. The
   * server only sets `status: "completed"` at full source coverage, so a `ready`
   * item is safe to open — never an under-enriched "Unknown" card.
   */
  ready: boolean;
  /** Coarse completeness reported by the server ("none" | "partial" | "full"). */
  enrichmentLevel: 'none' | 'partial' | 'full';
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
  const ready = typeof record.ready === 'boolean' ? record.ready : status === 'completed';
  return {
    jobKey,
    status,
    name,
    brand: typeof record.brand === 'string' && record.brand.trim() ? record.brand.trim() : null,
    // Trust the server's `ready` when present, but keep it consistent with the
    // contract's `ready === status === "completed"` invariant either way.
    ready,
    // A completed/ready job is full by definition; otherwise trust the server's
    // level, defaulting unknown values to "none".
    enrichmentLevel:
      record.enrichmentLevel === 'partial' || record.enrichmentLevel === 'full'
        ? record.enrichmentLevel
        : ready
          ? 'full'
          : 'none',
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

/** A curation is safe to force-open only when it is fully complete. */
export function isCurationOpenable(item: CurationItem | null | undefined): boolean {
  return Boolean(item && item.ready && item.enrichmentLevel === 'full');
}

/**
 * Choose which curation to force-open on app open, given the fetched list and the
 * `?curation=<jobKey>` from a push deep-link.
 *
 * Deliberately DEEP-LINK-ONLY and COMPLETE-ONLY: we open a detail modal on load
 * ONLY when the user actually tapped a "ready to add" notification (which carries
 * the jobKey) AND that exact pick is fully enriched. A plain app open never
 * force-opens anything — previously it opened the first `ready` item every load,
 * which, combined with the old too-weak "ready" bar, slammed an under-enriched
 * "Unknown / NO IMAGE" card in the user's face on every launch. Ready picks on a
 * plain open are surfaced through the notification feed instead, not a modal.
 *
 * Returns null when there is no jobKey, the jobKey isn't found, or the target
 * isn't fully complete. Pure, so it is unit-tested under the node runner.
 */
export function pickResumeCurationTarget(
  items: CurationItem[],
  jobKey?: string | null,
): CurationItem | null {
  if (!jobKey) return null;
  const requested = items.find((item) => item.jobKey === jobKey);
  return isCurationOpenable(requested) ? (requested as CurationItem) : null;
}

/**
 * Fetch the signed-in user's pending/ready beam curations. Returns `[]` on any
 * non-ok response or thrown error so callers (resume-on-return, the push
 * deep-link) can treat "no curations" and "couldn't load" identically — neither
 * is worth interrupting the user over.
 */
export async function getPendingCuration(authToken: string): Promise<CurationItem[]> {
  try {
    const res = await fetch(appApiUrl('/api/beam-agent/curation/pending'), {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return [];
    return parseCurationResponse(await res.json());
  } catch {
    return [];
  }
}
