// Pure core of the vision validation gate (image selection audit Tier 3 #10 /
// Tier 1 #4). Decides whether an AUTOMATICALLY selected bottle image actually
// depicts the requested fragrance by asking an injected vision model
// "single product bottle of {brand} {name}? yes/no" — the only check that can
// catch wrong-bottle picks whose metadata carries no usable title/source text
// (the engine-crawled fimgs.net fallback, audit W1).
//
// Fail-open by design: the gate REJECTS only on an explicit "no". A disabled
// gate, an erroring/timing-out model, an unloadable image, or an unparseable
// answer all PASS, so behavior is unchanged whenever the optional Gemini
// integration is absent or unhealthy (repo convention: optional integrations
// degrade gracefully).
//
// Kept dependency-free (no runtime imports) so the node:test runner can
// exercise it with injected fakes (imageVisionGateCore.test.ts). The Gemini /
// network / cache wiring lives in imageVisionGate.ts.

export type VisionGateVerdict = "pass" | "reject";
export type VisionGateAnswer = "yes" | "no" | "unknown";

export type VisionGateImage = { data: Buffer; mimeType: string };

export const VISION_GATE_CACHE_MAX_ENTRIES = 500;

export interface VisionGateCoreDeps {
  /** Cheap short-circuit: when false, the gate is a no-op pass-through. */
  enabled: () => boolean;
  /** Load the image to check. Returning null fails open (pass). */
  loadImage: () => Promise<VisionGateImage | null>;
  /** Ask the vision model; returns its raw text answer. */
  askModel: (prompt: string, image: VisionGateImage) => Promise<string>;
  /**
   * Verdict memo keyed by caller-supplied cache keys (bounded FIFO). Only
   * definitive answers ("yes"/"no") are stored — fail-open passes from errors
   * or unparseable output are never cached, so they retry next time.
   */
  cache?: Map<string, VisionGateVerdict>;
  maxCacheEntries?: number;
  onError?: (error: unknown) => void;
}

export function buildVisionGatePrompt(brand: string, name: string): string {
  const label = `${brand} ${name}`.replace(/\s+/g, " ").trim();
  return `Is this image a single product bottle of the fragrance "${label}"? Answer with exactly one word: yes or no.`;
}

export function parseVisionGateAnswer(text: string | null | undefined): VisionGateAnswer {
  const normalized = (text ?? "").trim().toLowerCase().replace(/^["'*`\s]+/, "");
  if (/^no\b/.test(normalized)) return "no";
  if (/^yes\b/.test(normalized)) return "yes";
  return "unknown";
}

function rememberVerdict(
  deps: VisionGateCoreDeps,
  keys: string[],
  verdict: VisionGateVerdict,
): void {
  if (!deps.cache) return;
  const max = deps.maxCacheEntries ?? VISION_GATE_CACHE_MAX_ENTRIES;
  for (const key of keys) {
    if (!deps.cache.has(key)) {
      // Bounded FIFO: evict the oldest entry once full. Map preserves
      // insertion order, so the first key is the oldest.
      while (deps.cache.size >= max) {
        const oldest = deps.cache.keys().next();
        if (oldest.done) break;
        deps.cache.delete(oldest.value);
      }
    }
    deps.cache.set(key, verdict);
  }
}

/**
 * Run the gate for one image. Returns "reject" ONLY when the model answers an
 * explicit "no"; every failure mode passes (fail-open) so the pipeline can
 * never be blocked or hung by the optional integration.
 */
export async function evaluateVisionGate(
  deps: VisionGateCoreDeps,
  input: { brand: string; name: string; cacheKeys?: Array<string | null | undefined> },
): Promise<VisionGateVerdict> {
  let enabled: boolean;
  try {
    enabled = deps.enabled();
  } catch {
    return "pass";
  }
  if (!enabled) return "pass";

  const keys = (input.cacheKeys ?? []).filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
  if (deps.cache) {
    for (const key of keys) {
      const hit = deps.cache.get(key);
      if (hit) return hit;
    }
  }

  try {
    const image = await deps.loadImage();
    if (!image || image.data.length === 0) return "pass";
    const answer = parseVisionGateAnswer(
      await deps.askModel(buildVisionGatePrompt(input.brand, input.name), image),
    );
    if (answer === "unknown") return "pass";
    const verdict: VisionGateVerdict = answer === "no" ? "reject" : "pass";
    rememberVerdict(deps, keys, verdict);
    return verdict;
  } catch (error) {
    deps.onError?.(error);
    return "pass";
  }
}

export type VisionRankedCandidate<T> = { value: T; score: number; ordinal: number };

/**
 * Final-winner arbitration for the Serper candidate loop: gate candidates in
 * descending score order (earliest ordinal wins ties, matching the loop's
 * legacy `best` tracking) until one passes; vision-rejected entries are
 * reported via onReject. Only presumptive winners are ever gated — never the
 * whole candidate set up front — so the model spend is one call per rejection
 * plus one for the accepted winner. When the gate is a pass-through this
 * returns the same candidate the legacy `best` tracking selected.
 */
export async function pickVisionApprovedWinner<T>(
  candidates: Array<VisionRankedCandidate<T>>,
  verify: (candidate: VisionRankedCandidate<T>) => Promise<boolean>,
  onReject?: (candidate: VisionRankedCandidate<T>) => void,
): Promise<VisionRankedCandidate<T> | null> {
  const pool = [...candidates].sort((a, b) => b.score - a.score || a.ordinal - b.ordinal);
  for (const candidate of pool) {
    if (await verify(candidate)) return candidate;
    onReject?.(candidate);
  }
  return null;
}
