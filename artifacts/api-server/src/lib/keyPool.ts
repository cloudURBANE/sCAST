/**
 * Rotating pool of interchangeable API keys for a single upstream service.
 *
 * Motivation: free-tier services (Serper.dev image search, Poof background
 * removal) hand out limited one-time / per-window quota per account. Instead of
 * redeploying every time a single key runs dry, we load a *pool* of keys up
 * front and rotate automatically at runtime:
 *
 *   - The pool drains one key at a time (sticky cursor) so each free account is
 *     used to its full quota before the next is touched.
 *   - A transient rate-limit (HTTP 429) puts the key on a short cooldown and the
 *     pool retries it later.
 *   - An out-of-credits / invalid key (HTTP 401/402/403) is retired for the rest
 *     of the process lifetime.
 *   - Within a single caller request the pool walks to the next usable key, so an
 *     exhausted key never surfaces as a user-visible failure while spares remain.
 *
 * State is intentionally in-memory only: a process restart re-tests every key,
 * which is what we want when a per-day quota has reset.
 */

/** Result of a single attempt against one key, returned by the caller. */
export type PoolAttempt<T> =
  | { ok: true; value: T }
  /** Key is out of credits / invalid — retire it and try the next key. */
  | { ok: false; action: "retire" }
  /** Key is rate-limited — cool it down and try the next key. */
  | { ok: false; action: "cooldown" }
  /** Transient/non-key failure — try the next key without penalizing this one. */
  | { ok: false; action: "skip" }
  /** Not a key problem (bad input, upstream 5xx) — stop; don't burn other keys. */
  | { ok: false; action: "stop" };

export type PoolRunResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "no_keys" | "all_exhausted" | "stopped" };

type KeyState = {
  key: string;
  /** Masked identifier safe to put in logs / diagnostics. */
  label: string;
  /** Epoch ms until which the key is unavailable (cooldown). 0 = available now. */
  cooldownUntil: number;
  /** Permanently unavailable for this process (out of credits / invalid). */
  retired: boolean;
  failures: number;
  lastUsedAt: number;
};

export type KeyPoolOptions = {
  /** Cooldown after a rate-limit (429) before the key is retried. Default 60s. */
  rateLimitCooldownMs?: number;
};

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

function maskKey(key: string): string {
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Split comma/whitespace/newline-delimited env values into unique trimmed keys. */
export function parseKeyList(...rawValues: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const raw of rawValues) {
    if (!raw) continue;
    for (const piece of raw.split(/[\s,]+/)) {
      const k = piece.trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return keys;
}

export class KeyPool {
  readonly name: string;
  private readonly states: KeyState[] = [];
  private readonly index = new Map<string, KeyState>();
  private readonly rateLimitCooldownMs: number;
  private cursor = 0;

  constructor(name: string, keys: string[], options?: KeyPoolOptions) {
    this.name = name;
    this.rateLimitCooldownMs = options?.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.addKeys(keys);
  }

  /** Build a pool from one or more env values (e.g. plural then singular fallback). */
  static fromEnv(name: string, envValues: Array<string | undefined>, options?: KeyPoolOptions): KeyPool {
    return new KeyPool(name, parseKeyList(...envValues), options);
  }

  get size(): number {
    return this.states.length;
  }

  availableCount(now = Date.now()): number {
    return this.states.filter((s) => !s.retired && s.cooldownUntil <= now).length;
  }

  /**
   * Add keys at runtime (e.g. via the admin endpoint) without a redeploy.
   * Re-adding an existing key revives it (clears retirement/cooldown).
   * Returns the number of keys that were newly added or revived.
   */
  addKeys(rawKeys: string[]): number {
    let changed = 0;
    for (const key of rawKeys) {
      const k = key.trim();
      if (!k) continue;
      const existing = this.index.get(k);
      if (existing) {
        if (existing.retired || existing.cooldownUntil > Date.now()) {
          existing.retired = false;
          existing.cooldownUntil = 0;
          existing.failures = 0;
          changed++;
        }
        continue;
      }
      const state: KeyState = { key: k, label: maskKey(k), cooldownUntil: 0, retired: false, failures: 0, lastUsedAt: 0 };
      this.states.push(state);
      this.index.set(k, state);
      changed++;
    }
    return changed;
  }

  /**
   * Run an attempt against usable keys in round-robin order until one succeeds,
   * the caller signals `stop`, or every key is exhausted/cooling down.
   */
  async run<T>(attempt: (key: string, label: string) => Promise<PoolAttempt<T>>): Promise<PoolRunResult<T>> {
    if (this.states.length === 0) return { ok: false, reason: "no_keys" };

    const now = Date.now();
    const n = this.states.length;
    // Capture the starting cursor once: mutating this.cursor mid-loop would
    // corrupt the round-robin index on later iterations.
    const start = this.cursor;

    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const state = this.states[idx];
      if (state.retired || state.cooldownUntil > now) continue;

      state.lastUsedAt = Date.now();
      const result = await attempt(state.key, state.label);

      if (result.ok) {
        state.failures = 0;
        this.cursor = idx; // stick to this key for the next call (drain it fully)
        return { ok: true, value: result.value };
      }

      if (result.action === "stop") {
        // Leave the cursor here so the next call retries this key first.
        this.cursor = idx;
        return { ok: false, reason: "stopped" };
      }

      this.applyStrike(state, result.action);
      // Next call should start past this failed key (retired/cooling keys are
      // skipped anyway, but this keeps the drain order intuitive).
      this.cursor = (idx + 1) % n;
    }

    return { ok: false, reason: "all_exhausted" };
  }

  private applyStrike(state: KeyState, action: "retire" | "cooldown" | "skip"): void {
    state.failures++;
    if (action === "retire") {
      state.retired = true;
    } else if (action === "cooldown") {
      state.cooldownUntil = Date.now() + this.rateLimitCooldownMs;
    }
    // "skip": transient — no penalty.
  }

  /** Diagnostic snapshot (masked keys only) for the admin health endpoint. */
  snapshot(now = Date.now()): {
    name: string;
    size: number;
    available: number;
    keys: Array<{ key: string; status: "available" | "cooling_down" | "retired"; failures: number; cooldownMsRemaining: number }>;
  } {
    return {
      name: this.name,
      size: this.states.length,
      available: this.availableCount(now),
      keys: this.states.map((s) => ({
        key: s.label,
        status: s.retired ? "retired" : s.cooldownUntil > now ? "cooling_down" : "available",
        failures: s.failures,
        cooldownMsRemaining: s.retired ? 0 : Math.max(0, s.cooldownUntil - now),
      })),
    };
  }
}

// --- Process-wide registry so the admin route can inspect / hot-add keys -------

const registry = new Map<string, KeyPool>();

export function registerKeyPool(pool: KeyPool): KeyPool {
  registry.set(pool.name, pool);
  return pool;
}

export function getKeyPool(name: string): KeyPool | undefined {
  return registry.get(name);
}

export function listKeyPools(): KeyPool[] {
  return [...registry.values()];
}
