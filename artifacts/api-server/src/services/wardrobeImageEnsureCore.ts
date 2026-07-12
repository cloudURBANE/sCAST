/**
 * Pure concurrency and compare-and-set rules for wardrobe image repair.
 *
 * The runtime service performs network/storage reads and DB writes. Keeping the
 * replacement guard here makes the most important invariant deterministic:
 * an ensure request may fill an empty row or replace the exact URL the browser
 * reported as failed, but it may never overwrite a newer/manual selection.
 */

export type RowImageReplacementGuard =
  | { kind: "empty" }
  | { kind: "exact"; imageUrl: string; sourceProvider: string | null }
  | { kind: "never" };

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Current persisted row image, accepting the legacy snake-case key. */
export function storedWardrobeImageUrl(fragranceData: Record<string, unknown>): string | null {
  return text(fragranceData.imageUrl) ?? text(fragranceData.image_url);
}

/** Current persisted image provider, accepting the legacy snake-case key. */
export function storedWardrobeImageProvider(fragranceData: Record<string, unknown>): string | null {
  return text(fragranceData.sourceProvider) ?? text(fragranceData.source_provider);
}

/**
 * Compare image identities while ignoring only the app's cache-busting `v`
 * parameter. Tokens and every other query parameter remain significant.
 */
export function canonicalWardrobeImageUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const parsed = new URL(raw, "http://local.invalid");
    parsed.searchParams.delete("v");
    return absolute
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return raw;
  }
}

export function sameWardrobeImageUrl(left: unknown, right: unknown): boolean {
  const a = canonicalWardrobeImageUrl(left);
  const b = canonicalWardrobeImageUrl(right);
  return a !== null && b !== null && a === b;
}

/**
 * Snapshot the only row state an automatic ensure write may replace.
 * `exact` includes the provider so a same-URL manual stamp that lands while the
 * request is running also wins the race.
 */
export function wardrobeImageReplacementGuard(
  fragranceData: Record<string, unknown>,
  failedUrl: string | null,
): RowImageReplacementGuard {
  const current = storedWardrobeImageUrl(fragranceData);
  if (!current) return { kind: "empty" };
  if (failedUrl && sameWardrobeImageUrl(current, failedUrl)) {
    return {
      kind: "exact",
      imageUrl: current,
      sourceProvider: storedWardrobeImageProvider(fragranceData),
    };
  }
  return { kind: "never" };
}

/** Different failed/manual snapshots get different jobs; exact repeats dedupe. */
export function wardrobeImageRecoveryKey(
  tenantId: string,
  userId: string,
  rowId: string,
  guard: RowImageReplacementGuard,
): string {
  const snapshot = guard.kind === "exact"
    ? `${guard.imageUrl}|${guard.sourceProvider ?? ""}`
    : guard.kind;
  return `${tenantId}|${userId}|${rowId}|${snapshot}`;
}

/**
 * Small in-process single-flight coordinator. The image pipeline supplies the
 * global concurrency cap; this layer prevents repeated ensure calls from
 * duplicating catalog/exact-row recovery work around that pipeline call.
 */
export class WardrobeImageRecoveryDeduper {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly onError?: (error: unknown, key: string) => void;

  constructor(onError?: (error: unknown, key: string) => void) {
    this.onError = onError;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  start(key: string, task: () => Promise<void>): boolean {
    if (this.inFlight.has(key)) return false;

    let flight!: Promise<void>;
    flight = Promise.resolve()
      .then(task)
      .catch((error) => this.onError?.(error, key))
      .finally(() => {
        if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
      });
    this.inFlight.set(key, flight);
    return true;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }
}
