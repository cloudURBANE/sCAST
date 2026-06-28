type LooseRecord = Record<string, unknown>;

const UNKNOWN_FACT_VALUES = new Set([
  "unknown",
  "n/a",
  "n.a.",
  "na",
  "none",
  "null",
  "not available",
]);

function hasOwn(value: LooseRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usefulDetailFactString(value: unknown, options?: { rejectUniversal?: boolean }): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (UNKNOWN_FACT_VALUES.has(normalized)) return undefined;
  if (options?.rejectUniversal && normalized === "universal") return undefined;
  return trimmed;
}

// WS-9c: heal-resync completion is persisted into fragrance_data as a small
// integer so it is server-authoritative across devices/guests (a fresh device
// loading the vault sees already-healed rows and does not re-fetch the whole
// complete wardrobe). Only accept a finite, non-negative integer version.
function usefulHealVersion(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const version = Math.trunc(value);
  return version >= 0 ? version : undefined;
}

function usefulDetailFactYear(value: unknown): number | undefined {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{4}$/.test(value.trim())
      ? Number(value.trim())
      : undefined;
  if (numberValue === undefined || !Number.isFinite(numberValue)) return undefined;
  const year = Math.trunc(numberValue);
  if (year < 1800 || year > 2100) return undefined;
  return year;
}

function titleFactValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word.length <= 3 && word === word.toUpperCase()
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function derivedWearProfileSeasons(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const wearProfile = isRecord(value.wear_profile) ? value.wear_profile : null;
  const primarySeasons = wearProfile?.primary_seasons;
  if (!Array.isArray(primarySeasons)) return [];
  return uniqueStrings(
    primarySeasons
      .map((season) => usefulDetailFactString(season, { rejectUniversal: true }))
      .filter((season): season is string => Boolean(season)),
  );
}

function firstRawEngineDetail(body: LooseRecord): LooseRecord {
  return isRecord(body.raw_engine_detail) ? body.raw_engine_detail : {};
}

function firstDerivedMetrics(body: LooseRecord, rawDetail: LooseRecord): unknown {
  return hasOwn(body, "derived_metrics") ? body.derived_metrics : rawDetail.derived_metrics;
}

export function hasDetailRefreshPayload(body: LooseRecord): boolean {
  return (
    hasOwn(body, "year") ||
    hasOwn(body, "gender") ||
    hasOwn(body, "concentration") ||
    hasOwn(body, "season") ||
    hasOwn(body, "derived_metrics") ||
    hasOwn(body, "source_coverage") ||
    hasOwn(body, "enrichment") ||
    hasOwn(body, "raw_engine_detail") ||
    hasOwn(body, "accordHealVersion")
  );
}

export function detailRefreshPatchFromBody(body: LooseRecord): LooseRecord {
  const detailPatch: LooseRecord = {};
  const rawDetail = firstRawEngineDetail(body);

  const year = usefulDetailFactYear(hasOwn(body, "year") ? body.year : rawDetail.year);
  if (year !== undefined) detailPatch.year = year;

  const gender = usefulDetailFactString(hasOwn(body, "gender") ? body.gender : rawDetail.gender);
  if (gender) detailPatch.gender = gender;

  const concentration = usefulDetailFactString(
    hasOwn(body, "concentration") ? body.concentration : rawDetail.concentration,
  );
  if (concentration) detailPatch.concentration = concentration;

  const explicitSeason = usefulDetailFactString(
    hasOwn(body, "season") ? body.season : rawDetail.season,
    { rejectUniversal: true },
  );
  const derivedSeasons = derivedWearProfileSeasons(firstDerivedMetrics(body, rawDetail));
  const season = explicitSeason || (derivedSeasons.length > 0
    ? derivedSeasons.map(titleFactValue).join(" / ")
    : undefined);
  if (season) detailPatch.season = season;

  if (hasOwn(body, "derived_metrics")) {
    detailPatch.derived_metrics = body.derived_metrics ?? null;
  }
  if (hasOwn(body, "source_coverage")) {
    detailPatch.source_coverage = body.source_coverage ?? undefined;
  }
  if (hasOwn(body, "enrichment")) {
    detailPatch.enrichment = body.enrichment ?? null;
  }
  if (hasOwn(body, "raw_engine_detail")) {
    detailPatch.raw_engine_detail = body.raw_engine_detail ?? null;
  }
  const accordHealVersion = usefulHealVersion(body.accordHealVersion);
  if (accordHealVersion !== undefined) detailPatch.accordHealVersion = accordHealVersion;
  return detailPatch;
}
