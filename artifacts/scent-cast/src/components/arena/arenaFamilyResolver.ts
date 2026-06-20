import {
  resolveMainAccordChartRows,
  type FragranceDetail,
  type NumericScentAxes,
} from "../../lib/fragranceApi.ts";
import { sanitizeFamilyLabel } from "../../lib/wardrobeSearchSuggest.ts";

const ARENA_FAMILY_PLACEHOLDERS = new Set(["classic fragrance", "community option"]);

function firstFamilyLabel(...values: unknown[]): string | null {
  for (const value of values) {
    const clean = sanitizeFamilyLabel(value);
    if (clean && ARENA_FAMILY_PLACEHOLDERS.has(clean.toLowerCase())) continue;
    if (clean) return clean;
  }
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericScentAxes(value: unknown): NumericScentAxes | null {
  const source = objectRecord(value);
  const axes: NumericScentAxes = {};
  for (const key of ["freshness", "sweetness", "woodiness", "spice", "warmth", "musk"] as const) {
    const raw = source[key];
    if (typeof raw === "number" && Number.isFinite(raw)) axes[key] = raw;
  }
  return Object.keys(axes).length > 0 ? axes : null;
}

export function resolveArenaFamilyFromDetail(detail: FragranceDetail): string | null {
  const raw = objectRecord(detail.raw);
  const direct = firstFamilyLabel(
    detail.family,
    detail.fragrance_family,
    detail.family_label,
    detail.scent_family,
    raw.family,
    raw.fragrance_family,
    raw.family_label,
    raw.scent_family,
  );
  if (direct) return direct;

  const derivedMetrics = objectRecord(detail.derived_metrics);
  const rows = resolveMainAccordChartRows(
    detail.derived_metrics?.main_accords,
    numericScentAxes(detail.scent_vector) ??
      numericScentAxes(detail.profile) ??
      numericScentAxes(derivedMetrics.scent_vector),
  );
  return firstFamilyLabel(rows[0]?.label);
}
