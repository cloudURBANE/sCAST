type LooseRecord = Record<string, unknown>;

const PLACEHOLDER_FACT_VALUES = new Set([
  'unknown',
  'n/a',
  'n.a.',
  'na',
  'none',
  'null',
  'not available',
]);

export type FragranceFactSource = {
  year?: unknown;
  gender?: unknown;
  concentration?: unknown;
  season?: unknown;
  derived_metrics?: unknown;
};

export type ResolvedFragranceFacts = {
  year?: number;
  gender?: string;
  concentration?: string;
  /** The stored environment label uses the wardrobe's existing `season` field. */
  season?: string;
};

export type ResolveFragranceFactsInput = {
  /** Authoritative detail response, when available. */
  detail?: unknown;
  /** Search result facts retained when detail is sparse or temporarily unavailable. */
  selected?: unknown;
  /** Generated/local profile used only when neither upstream source has a useful fact. */
  pipelineProfile?: unknown;
};

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFactSource(value: unknown): FragranceFactSource | null {
  return isRecord(value) ? (value as FragranceFactSource) : null;
}

/** Return a trimmed, displayable fragrance fact or `undefined` for placeholder noise. */
export function usefulFragranceFact(
  value: unknown,
  options?: { rejectUniversal?: boolean },
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  if (PLACEHOLDER_FACT_VALUES.has(normalized)) return undefined;
  if (options?.rejectUniversal && normalized === 'universal') return undefined;
  return trimmed;
}

function usefulFragranceYear(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{4}$/.test(value.trim())
      ? Number(value.trim())
      : undefined;
  if (numeric === undefined || !Number.isFinite(numeric)) return undefined;

  const year = Math.trunc(numeric);
  return year >= 1700 && year <= 2100 ? year : undefined;
}

function titleFactValue(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (word.length <= 3 && word === word.toUpperCase()
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

function derivedEnvironment(source: FragranceFactSource): string | undefined {
  if (!isRecord(source.derived_metrics)) return undefined;
  const wearProfile = isRecord(source.derived_metrics.wear_profile)
    ? source.derived_metrics.wear_profile
    : null;
  const primarySeasons = wearProfile?.primary_seasons;
  if (!Array.isArray(primarySeasons)) return undefined;

  const seen = new Set<string>();
  const seasons = primarySeasons.flatMap((value) => {
    const season = usefulFragranceFact(value, { rejectUniversal: true });
    if (!season) return [];
    const key = season.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [titleFactValue(season)];
  });
  return seasons.length > 0 ? seasons.join(' / ') : undefined;
}

function firstUsefulString(
  sources: FragranceFactSource[],
  key: 'gender' | 'concentration',
): string | undefined {
  for (const source of sources) {
    const fact = usefulFragranceFact(source[key]);
    if (fact) return fact;
  }
  return undefined;
}

/**
 * Resolve the durable facts saved with a captured fragrance.
 *
 * Detail data wins, selected-result facts survive a sparse/transient detail
 * response, and pipeline values are a final fallback. Placeholder strings never
 * replace a useful upstream fact. Environment prefers each source's explicit
 * season and then its derived community-voted primary seasons.
 */
export function resolveFragranceFacts({
  detail,
  selected,
  pipelineProfile,
}: ResolveFragranceFactsInput): ResolvedFragranceFacts {
  const sources = [detail, selected, pipelineProfile]
    .map(asFactSource)
    .filter((source): source is FragranceFactSource => source !== null);
  const resolved: ResolvedFragranceFacts = {};

  for (const source of sources) {
    const year = usefulFragranceYear(source.year);
    if (year !== undefined) {
      resolved.year = year;
      break;
    }
  }

  const gender = firstUsefulString(sources, 'gender');
  if (gender) resolved.gender = gender;

  const concentration = firstUsefulString(sources, 'concentration');
  if (concentration) resolved.concentration = concentration;

  for (const source of sources) {
    const explicitEnvironment = usefulFragranceFact(source.season, { rejectUniversal: true });
    const environment = explicitEnvironment ?? derivedEnvironment(source);
    if (environment) {
      resolved.season = environment;
      break;
    }
  }

  return resolved;
}
