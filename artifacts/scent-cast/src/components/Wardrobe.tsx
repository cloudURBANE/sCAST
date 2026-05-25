import React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Trash2,
  CalendarDays,
  Activity,
  CircleDollarSign,
  RefreshCw,
  Undo2,
  HelpCircle,
  Sparkles,
  Check,
  Maximize2,
  ChevronDown,
  Search,
  Crop,
  MoveHorizontal,
  MoveVertical,
  RotateCcw,
  Save,
  ZoomIn,
  ZoomOut,
  ArrowUp,
  ArrowRight,
  ArrowDown,
  ArrowLeft,
} from 'lucide-react';
import { ReviewsPanel } from './ReviewsPanel';
import { CyclingTilePair, type CyclingPart } from './CyclingTilePair';
import { bottleFeaturedSlotClass } from '@/lib/bottleImageFrame';

import {
  BOTTLE_CROP_STORED_MAX,
  DEFAULT_BOTTLE_IMAGE_ADJUSTMENT,
  bottleImageAdjustmentsEqual,
  normalizeBottleImageAdjustment,
  type BottleImageAdjustment,
  type NormalizedBottleImageAdjustment,
} from '@/lib/bottleImageAdjustment';
import { BottleImage } from '@/components/BottleImage';
import { ScentNotesInfographic } from '@/components/ScentNotesInfographic';
import {
  WARDROBE_CLARIFY_SOLVERS,
  WARDROBE_REFRESH_COUNT_STORAGE_KEY,
  type WardrobeImageSolverId,
} from '@/lib/imageRefreshSolvers';
import {
  buildWardrobeSearchSuggestions,
  matchesWardrobeQuery,
  type WardrobeSearchSuggestion,
} from '@/lib/wardrobeSearchSuggest';
import {
  collectMainAccordDisplayRows,
  extractDetailReviews,
  normalizeSourceCoverage,
  getCachedReviewSummary,
  reviewSummaryCacheKey,
  summarizeReviews,
  type DerivedMetrics,
  type FragranceDetail,
  type SourceCoverage,
} from '@/lib/fragranceApi';

export interface ScentVector {
  freshness: number;
  sweetness: number;
  woodiness: number;
  spice: number;
  warmth: number;
  musk: number;
}

export type DestinationType = 'Staying In' | 'Going Out' | 'Work' | 'Night Out';
export type EnergyState = 'Calm' | 'Focused' | 'Confident' | 'Social' | 'Relaxed';

export interface Fragrance {
  id: string;
  name: string;
  brand: string;
  house?: string;
  year?: number | null;
  gender?: string | null;
  imageUrl: string;
  season: string;
  notes?: string[];
  concentration?: string;
  scent_vector?: ScentVector;
  intents?: DestinationType[];
  energies?: EnergyState[];
  family?: string;
  performance?: { sillage: number; longevity: number };
  source_coverage?: SourceCoverage;
  derived_metrics?: DerivedMetrics | null;
  enrichment?: FragranceDetail["enrichment"];
  /** Full Railway `/api/fragrances/details` payload — preferred for nested lookups */
  raw_engine_detail?: FragranceDetail | null;
  fragranceApiId?: string;
  source_url?: string | null;
  pyramid?: { top: string[]; heart: string[]; base: string[] };
  context?: { weather: string[]; time: string[]; occasion: string[] };
  synthesized?: boolean;
  shareHidden?: boolean;
  imageAdjustment?: BottleImageAdjustment | null;
  /** Legacy ScentProfile shape — some old vault rows only have product.name/brand */
  product?: { name?: string; brand?: string; perfumer?: string };
  /** Postgres row UUID — surfaced by GET /wardrobe; preferred for delete/patch (B9). */
  _dbId?: string;
}

/** Resolve the human-facing name/brand even if the row predates the flat shape. */
function entryName(item: {
  name?: string;
  product?: { name?: string };
}): string {
  return item?.name || item?.product?.name || "";
}
function entryBrand(item: {
  brand?: string;
  product?: { brand?: string };
}): string {
  return item?.brand || item?.product?.brand || "";
}

function dedupeNotesPreserveOrder(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const key = label.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label.trim());
  }
  return out;
}

/** Flat tokens for vault cards — first three + ellipsis when there are more. */
function collectCardNoteTokens(item: Fragrance): string[] {
  const dm = item.raw_engine_detail?.derived_metrics ?? item.derived_metrics;
  const dmNotes = dm?.notes;
  if (dmNotes) {
    const ordered = [
      ...(dmNotes.top ?? []),
      ...(dmNotes.heart ?? []),
      ...(dmNotes.base ?? []),
      ...(dmNotes.flat ?? []),
    ]
      .map((s) => s.trim())
      .filter(Boolean);
    if (ordered.length > 0) return dedupeNotesPreserveOrder(ordered);
    const summary = dm?.main_accords?.accord_summary?.trim();
    if (summary) return [summary];
  }

  const raw = item.notes?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (raw.length > 0) return dedupeNotesPreserveOrder(raw);

  const pyramidNotes = [
    ...(item.pyramid?.top ?? []),
    ...(item.pyramid?.heart ?? []),
    ...(item.pyramid?.base ?? []),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  if (pyramidNotes.length > 0) return dedupeNotesPreserveOrder(pyramidNotes);

  if (collectMainAccordDisplayRows(dm?.main_accords).length > 0) {
    const labels = collectMainAccordDisplayRows(dm?.main_accords)
      .map((row) => row.label.trim())
      .filter(Boolean);
    return dedupeNotesPreserveOrder(labels);
  }

  const fallbackSummary = dm?.main_accords?.accord_summary?.trim();
  if (fallbackSummary) return [fallbackSummary];

  return [];
}

const CARD_NOTE_JOINER = "\u2009·\u2009";

function entryNotesCardLine(item: Fragrance, maxNotes = 3): string {
  const tokens = collectCardNoteTokens(item);
  if (tokens.length === 0) return "Notes unavailable for this fragrance.";
  const visible = tokens.slice(0, maxNotes);
  const joined = visible.join(CARD_NOTE_JOINER);
  return tokens.length > maxNotes ? `${joined}\u2026` : joined;
}

/** Adaptive brand-text sizing bucket. Longer brand names get smaller type. */
function brandLengthBucket(brand: string): "short" | "medium" | "long" | "xlong" {
  const len = brand.trim().length;
  if (len <= 10) return "short";
  if (len <= 16) return "medium";
  if (len <= 24) return "long";
  return "xlong";
}

function entryNotes(item: Fragrance): string {
  const dm = item.raw_engine_detail?.derived_metrics ?? item.derived_metrics;
  const dmNotes = dm?.notes;
  if (dmNotes) {
    const engineLine = joinDisplayParts([
      formatNoteList(dmNotes.top),
      formatNoteList(dmNotes.heart),
      formatNoteList(dmNotes.base),
      formatNoteList(dmNotes.flat),
    ]);
    if (engineLine) return engineLine;
    const summary = dm?.main_accords?.accord_summary?.trim();
    if (summary) return summary;
  }

  const notes = item.notes?.filter(Boolean);
  if (notes && notes.length > 0) return notes.join(" • ");
  const pyramidNotes = [
    ...(item.pyramid?.top ?? []),
    ...(item.pyramid?.heart ?? []),
    ...(item.pyramid?.base ?? []),
  ].filter(Boolean);
  if (pyramidNotes.length > 0) return pyramidNotes.slice(0, 8).join(" • ");

  if (collectMainAccordDisplayRows(dm?.main_accords).length > 0) {
    return collectMainAccordDisplayRows(dm?.main_accords)
      .slice(0, 6)
      .map((row) => row.label)
      .join(" • ");
  }

  return "Notes unavailable for this fragrance.";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatScore100(value: unknown): string | null {
  return isFiniteNumber(value) ? `${Math.round(value)}/100` : null;
}

function formatLegacyTenPointScore(value: unknown): string | null {
  return isFiniteNumber(value) ? `${value}/10` : null;
}

function formatPercent(value: unknown): string | null {
  return isFiniteNumber(value) ? `${Math.round(value)}%` : null;
}

function scoreNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

function percentFromMetricValue(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value >= 0 && value <= 1) return Math.max(0, Math.min(100, Math.round(value * 100)));
  if (value >= 0 && value <= 10) return Math.max(0, Math.min(100, Math.round(value * 10)));
  return Math.max(0, Math.min(100, Math.round(value)));
}

function percentFromTenPoint(value: unknown): number | null {
  return isFiniteNumber(value) ? Math.max(0, Math.min(100, Math.round(value * 10))) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    const next = stringValue(value);
    if (next) return next;
  }
  return null;
}

function formatYear(value: unknown): string | null {
  return isFiniteNumber(value) ? String(Math.round(value)) : null;
}

function joinDisplayParts(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return cleaned.length > 0 ? cleaned.join(" · ") : null;
}

function formatWearProfile(wear?: DerivedMetrics["wear_profile"] | null): string | null {
  if (!wear) return null;

  const seasons = wear.primary_seasons?.filter(Boolean) ?? [];
  const seasonOrder = ["Winter", "Spring", "Summer", "Autumn", "Autumn/Fall", "Fall"];
  const rank = (season: string) => {
    const index = seasonOrder.indexOf(season);
    return index === -1 ? seasonOrder.length : index;
  };
  const ordered = [...seasons].sort((a, b) => rank(a) - rank(b));
  const seasonLabel = ordered.length > 0 ? ordered.join("/") : null;
  const time = wear.primary_time?.trim() || null;

  if (seasonLabel && time) return `${seasonLabel} · ${time}`;
  if (seasonLabel) return seasonLabel;
  if (time) return time;

  return null;
}

function formatNoteList(values?: string[]): string | null {
  const cleaned = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return cleaned.length > 0 ? cleaned.join(", ") : null;
}

function hasDerivedMetricNotes(metrics?: DerivedMetrics | null): boolean {
  const notes = metrics?.notes;
  if (!notes) return false;
  return Boolean(
    formatNoteList(notes.top) ||
      formatNoteList(notes.heart) ||
      formatNoteList(notes.base) ||
      formatNoteList(notes.flat),
  );
}

function hasDerivedMetricsContent(metrics?: DerivedMetrics | null): boolean {
  if (!metrics) return false;
  return Boolean(
    metrics.headline?.summary?.trim() ||
      formatScore100(metrics.headline?.crowd_consensus_score) ||
      metrics.headline?.label?.trim() ||
      metrics.performance_score ||
      metrics.value_score ||
      formatWearProfile(metrics.wear_profile) ||
      formatScore100(metrics.community_interest_score?.score) ||
      metrics.main_accords?.accord_summary?.trim() ||
      (collectMainAccordDisplayRows(metrics.main_accords).length > 0) ||
      hasDerivedMetricNotes(metrics),
  );
}

function FragrancePanel({
  title,
  children,
  className = "",
  titleSuffix,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  titleSuffix?: React.ReactNode;
}) {
  return (
    <section className={`border border-white/[0.04] bg-gradient-to-b from-white/[0.018] to-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] ${className}`}>
      <div className="relative flex items-center justify-center border-b border-white/[0.05] px-4 py-3 text-center">
        <p className="text-[11px] font-bold uppercase tracking-[0.34em] text-white/70">
          {title}
        </p>
        {titleSuffix ? <div className="absolute right-3 top-1/2 -translate-y-1/2">{titleSuffix}</div> : null}
      </div>
      {children}
    </section>
  );
}



type DetailMetaRow = { label: string; value: string };

function toTitleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildWearProfileParts(
  wear: DerivedMetrics["wear_profile"] | null | undefined,
): CyclingPart[] {
  if (!wear) return [];
  const seasonOrder = ["Winter", "Spring", "Summer", "Autumn", "Autumn/Fall", "Fall"];
  const rank = (season: string) => {
    const index = seasonOrder.indexOf(season);
    return index === -1 ? seasonOrder.length : index;
  };
  const seasons = (wear.primary_seasons?.filter(Boolean) ?? [])
    .slice()
    .sort((a, b) => rank(a) - rank(b));
  const time = wear.primary_time?.trim() || null;
  const parts: CyclingPart[] = [];
  for (const season of seasons) parts.push({ primary: season, secondary: "Season" });
  if (time) parts.push({ primary: time, secondary: "Time" });
  return parts;
}

function buildPerformanceParts(
  performance: DerivedMetrics["performance_score"] | null | undefined,
): CyclingPart[] {
  const parts: CyclingPart[] = [];
  const sillage = performance?.sillage_label?.trim();
  const longevity = performance?.longevity_label?.trim();
  if (sillage) parts.push({ primary: toTitleCase(sillage), secondary: "Sillage" });
  if (longevity) parts.push({ primary: toTitleCase(longevity), secondary: "Longevity" });
  return parts;
}

function buildLegacyPerformanceParts(
  performance: Fragrance["performance"] | null | undefined,
): CyclingPart[] {
  const parts: CyclingPart[] = [];
  const sillage = formatLegacyTenPointScore(performance?.sillage);
  const longevity = formatLegacyTenPointScore(performance?.longevity);
  if (sillage) parts.push({ primary: sillage, secondary: "Sillage" });
  if (longevity) parts.push({ primary: longevity, secondary: "Longevity" });
  return parts;
}

type PriceSignalTone = "standard" | "accent";

function PriceValueSignal({
  symbols,
  label,
  tone = "standard",
}: {
  symbols: string;
  label: string;
  tone?: PriceSignalTone;
}) {
  const intensity = symbols.length;
  const baseClass =
    tone === "accent"
      ? "inline-flex font-serif italic text-scent-accent font-bold drop-shadow-[0_0_10px_rgba(212,175,55,0.7)] whitespace-nowrap"
      : "inline-flex font-serif italic text-white/90 whitespace-nowrap";
  const animate =
    intensity >= 4
      ? { y: [0, -2, 1, 0], opacity: [0.82, 1, 0.9, 0.82] }
      : intensity === 3
        ? { y: [0, -2, 0], rotate: [0, -4, 0], opacity: [0.88, 1, 0.88] }
        : intensity === 2
          ? { y: [0, -1.5, 0], scale: [1, 1.05, 1] }
          : { y: [0, -2, 0], opacity: [0.9, 1, 0.9] };
  const duration = intensity >= 4 ? 1.35 : intensity === 3 ? 1.55 : 1.8;

  return (
    <span className={baseClass} aria-label={label}>
      {symbols.split("").map((symbol, index) => (
        <motion.span
          key={`${symbol}-${index}`}
          aria-hidden="true"
          className="inline-block"
          animate={animate}
          transition={{
            duration,
            delay: index * 0.11,
            repeat: Infinity,
            repeatType: "mirror",
            ease: "easeInOut",
          }}
        >
          {symbol}
        </motion.span>
      ))}
    </span>
  );
}

function renderValueSignal(label: string | null | undefined): React.ReactNode {
  if (!label) return null;
  const normalized = label.trim().toLowerCase();
  if (normalized === "way overpriced") {
    return <PriceValueSignal symbols="$$$$" label={label} />;
  }
  if (normalized === "overpriced") {
    return <PriceValueSignal symbols="$$$" label={label} />;
  }
  if (normalized === "okay" || normalized === "ok") {
    return <PriceValueSignal symbols="$$" label={label} />;
  }
  if (normalized === "good value") {
    return <PriceValueSignal symbols="$" label={label} />;
  }
  if (normalized === "great value") {
    return <PriceValueSignal symbols="$" label={label} tone="accent" />;
  }
  if (normalized.includes("way overpriced")) return <PriceValueSignal symbols="$$$$" label={label} />;
  if (normalized.includes("overpriced")) return <PriceValueSignal symbols="$$$" label={label} />;
  if (normalized.includes("ok")) return <PriceValueSignal symbols="$$" label={label} />;
  if (normalized.includes("great")) {
    return <PriceValueSignal symbols="$" label={label} tone="accent" />;
  }
  if (normalized.includes("value") || normalized.includes("good")) return <PriceValueSignal symbols="$" label={label} />;

  return <span className="font-serif italic text-white/90">{label}</span>;
}

/**
 * Profile intelligence panel.
 *
 * The score is intentionally treated as a headline tile while the supporting
 * metrics stay compact, so the detail view has one clear hierarchy on every
 * screen size.
 * The unavailable-state notice renders only in the `tiles` section.
 */
function ProfileScorePanel({
  metrics,
  coverage,
  legacyPerformance,
  section,
}: {
  metrics?: DerivedMetrics | null;
  coverage?: SourceCoverage;
  legacyPerformance?: Fragrance["performance"];
  section: "tiles" | "score";
}) {
  const headline = metrics?.headline ?? null;
  const performance = metrics?.performance_score ?? null;
  const value = metrics?.value_score ?? null;
  const consensusScore = scoreNumber(headline?.crowd_consensus_score);
  const wearProfile = formatWearProfile(metrics?.wear_profile);

  if (!metrics || !hasDerivedMetricsContent(metrics)) {
    if (section === "score" || !coverage) return null;

    return (
      <FragrancePanel title="Derived Intelligence">
        <div className="px-4 py-5 text-center">
          <p className="text-sm italic text-white/55 font-serif">
            {coverage.complete === false
              ? "Awaiting Source Data"
              : "Derived fragrance intelligence unavailable."}
          </p>
          {coverage.complete === false ? (
            <p className="mt-1.5 text-[10px] uppercase tracking-[0.18em] text-white/38 font-bold">
              Derived intelligence not available yet
            </p>
          ) : null}
        </div>
      </FragrancePanel>
    );
  }

  // --- Score headline section (desktop: below the bottle visual) -----------
  if (section === "score") {
    return (
      <div className="hidden sm:flex flex-col items-center justify-center border border-white/10 bg-white/[0.025] px-4 py-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
        <p className="text-[10px] uppercase tracking-[0.28em] text-white/64 font-bold">Profile Score</p>
        <div className="mt-1 flex items-end justify-center gap-2">
          <span className="font-serif italic text-6xl leading-none text-scent-accent">
            {consensusScore ?? "--"}
          </span>
          <span className="pb-2 text-xl text-white/76">/100</span>
        </div>
        <p className="mt-1 text-sm text-scent-accent/90">{headline?.label ?? "Intelligence profile"}</p>
      </div>
    );
  }

  // --- Stat tiles section --------------------------------------------------
  const wearParts = buildWearProfileParts(metrics?.wear_profile);
  const derivedPerfParts = buildPerformanceParts(performance);
  const perfParts =
    derivedPerfParts.length > 0 ? derivedPerfParts : buildLegacyPerformanceParts(legacyPerformance);
  const valueLabel = value?.dominant_label?.trim() || null;

  type ScoreCard = {
    kind: "score";
    label: string;
    score: number | null;
    sub: string | null;
  };

  type MetricCard = {
    kind: "metric";
    icon: typeof CalendarDays;
    label: string;
    cycle: CyclingPart[];
    value: React.ReactNode;
    sub: string | null;
  };

  type StatCard = ScoreCard | MetricCard;

  const statCards: StatCard[] = [
    {
      kind: "score",
      label: "Profile Score",
      score: consensusScore,
      sub: headline?.label ?? "Intelligence profile",
    },
    {
      kind: "metric",
      icon: CalendarDays,
      label: "Wear Profile",
      cycle: wearParts,
      value: wearProfile ?? "Universal",
      sub: "Season / Time",
    },
    {
      kind: "metric",
      icon: Activity,
      label: "Performance",
      cycle: perfParts,
      value: null,
      sub: perfParts.length > 0 ? "Longevity / Sillage" : null,
    },
    {
      kind: "metric",
      icon: CircleDollarSign,
      label: "PRICE VALUE",
      cycle: [],
      value: renderValueSignal(valueLabel),
      sub: null,
    },
  ];
  const renderScoreTile = (stat: ScoreCard, scale: "desktop" | "mobile") => {
    const compact = scale === "mobile";
    return (
      <div
        key={stat.label}
        className={
          compact
            ? "min-w-0 h-full min-h-[6.15rem] flex flex-col items-center justify-center gap-1 overflow-hidden border border-scent-accent/22 bg-[radial-gradient(circle_at_50%_8%,rgba(212,175,55,0.12),rgba(255,255,255,0.035)_58%,rgba(255,255,255,0.02))] px-1.5 py-2.5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
            : "min-w-0 h-full flex flex-col items-center justify-center gap-1 overflow-hidden border border-scent-accent/22 bg-[radial-gradient(circle_at_50%_0%,rgba(212,175,55,0.13),rgba(255,255,255,0.04)_58%,rgba(255,255,255,0.02))] px-4 py-5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
        }
      >
        <div className="flex flex-1 flex-col items-center justify-center w-full">
          {stat.score !== null ? (
            <>
              <div className={`flex items-end justify-center ${compact ? "gap-1" : "gap-1.5"}`}>
                <span
                  className={`font-serif italic leading-none text-scent-accent tabular-nums ${
                    compact ? "text-[1.7rem]" : "text-[2.85rem]"
                  }`}
                >
                  {stat.score}
                </span>
                <span className={compact ? "pb-0.5 text-[10px] text-white/65" : "pb-1 text-base text-white/68"}>
                  /100
                </span>
              </div>
              <p
                className={
                  compact
                    ? "min-h-[2.35em] flex items-center justify-center px-0 text-[10px] leading-tight text-scent-accent/85"
                    : "min-h-[2.5em] flex items-center justify-center px-1 text-xs leading-snug text-scent-accent/85"
                }
              >
                {stat.sub ?? ""}
              </p>
            </>
          ) : (
            <>
              <p
                className={compact ? "text-[11px] text-white/55 font-serif italic" : "font-serif italic text-2xl text-white/55 leading-tight"}
                aria-hidden
              >
                --
              </p>
              <p
                className={
                  compact
                    ? "min-h-[2.35em] flex items-center justify-center px-0 text-[9px] leading-tight text-white/42"
                    : "min-h-[2.5em] flex items-center justify-center px-1 text-[10px] leading-snug text-white/42"
                }
              >
                {stat.sub ?? ""}
              </p>
            </>
          )}
        </div>
        <p
          className={
            compact
              ? "mt-auto max-w-full text-[7px] leading-tight uppercase tracking-[0.08em] text-white/58 font-bold [overflow-wrap:anywhere]"
              : "mt-auto text-[9px] uppercase tracking-[0.2em] text-white/58 font-bold"
          }
        >
          {stat.label}
        </p>
      </div>
    );
  };

  const renderMetricTile = (stat: MetricCard, scale: "desktop" | "mobile") => {
    const compact = scale === "mobile";
    const Icon = stat.icon;
    return (
      <div
        key={stat.label}
        className={
          compact
            ? "min-w-0 h-full min-h-[6.15rem] flex flex-col items-center justify-center gap-1 border border-white/15 bg-white/[0.035] px-1 py-2.5 text-center"
            : "min-w-0 h-full flex flex-col items-center justify-center gap-1 border border-white/15 bg-white/[0.035] px-4 py-5 text-center"
        }
      >
        <Icon size={compact ? 14 : 18} strokeWidth={1.6} className="text-scent-accent" />
        {stat.cycle.length > 0 ? (
          <CyclingTilePair
            parts={stat.cycle}
            primaryClass={
              compact
                ? "text-[11px] text-white/85 font-serif italic truncate max-w-full"
                : "font-serif italic text-2xl text-white leading-tight truncate max-w-full"
            }
            secondaryClass={
              compact
                ? "min-h-[2.35em] flex items-center justify-center px-0 text-[9px] leading-tight text-white/42"
                : "min-h-[2.5em] flex items-center justify-center px-1 text-[10px] leading-snug text-white/42"
            }
          />
        ) : (
          <>
            {stat.value !== null ? (
              <p
                className={
                  compact
                    ? "text-[11px] text-white/85 font-serif italic truncate max-w-full"
                    : "font-serif italic text-2xl text-white leading-tight truncate max-w-full"
                }
              >
                {stat.value}
              </p>
            ) : (
              <p
                className={compact ? "text-[11px] text-white/55 font-serif italic" : "font-serif italic text-2xl text-white/55 leading-tight"}
                aria-hidden
              >
                --
              </p>
            )}
            <p
              className={
                compact
                  ? "min-h-[2.35em] flex items-center justify-center px-0 text-[9px] leading-tight text-white/42"
                  : "min-h-[2.5em] flex items-center justify-center px-1 text-[10px] leading-snug text-white/42"
              }
            >
              {stat.sub ?? ""}
            </p>
          </>
        )}
        <p
          className={
            compact
              ? "mt-auto max-w-full text-[7px] leading-tight uppercase tracking-[0.04em] text-white/55 font-bold [overflow-wrap:anywhere]"
              : "mt-auto text-[9px] uppercase tracking-[0.2em] text-white/55 font-bold"
          }
        >
          {stat.label}
        </p>
      </div>
    );
  };

  const renderTile = (stat: StatCard, scale: "desktop" | "mobile") =>
    stat.kind === "score" ? renderScoreTile(stat, scale) : renderMetricTile(stat, scale);

  return (
    <>
      <div className="hidden sm:grid sm:grid-cols-[1.12fr_1.95fr_1fr] gap-3 sm:gap-4 items-stretch">
        {renderTile(statCards[0], "desktop")}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 items-stretch">
          {renderTile(statCards[1], "desktop")}
          {renderTile(statCards[2], "desktop")}
        </div>
        {renderTile(statCards[3], "desktop")}
      </div>

      <FragrancePanel title="Derived Intelligence" className="sm:hidden">
        <div className="px-4 py-3.5">
          <div className="grid grid-cols-2 gap-1.5">
            {statCards.map((stat) => renderTile(stat, "mobile"))}
          </div>
        </div>
      </FragrancePanel>
    </>
  );
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?.trim()
  .replace(/\/+$/, "");
const REFRESH_IMAGE_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/refresh-image`
  : "/api/refresh-image";
const REIMAGINE_IMAGE_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/reimagine-bottle-image`
  : "/api/reimagine-bottle-image";
const USAGE_TOTAL_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/usage/total`
  : "/api/usage/total";

type UsageTotalsSnapshot = {
  totalUsd: number;
  count: number;
};

function concentrationHintFromValue(
  value?: string,
): "edt" | "edp" | "parfum" | "extrait" | "elixir" | undefined {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("eau de toilette") || normalized.includes("edt")) return "edt";
  if (normalized.includes("eau de parfum") || normalized.includes("edp")) return "edp";
  if (normalized.includes("extrait") || normalized.includes("extract")) return "extrait";
  if (normalized.includes("elixir")) return "elixir";
  if (normalized.includes("parfum")) return "parfum";
  return undefined;
}

function suggestionPrimaryLine(s: WardrobeSearchSuggestion): string {
  if (s.kind === 'fragrance') return `${entryName(s.item)} — ${entryBrand(s.item)}`;
  return s.label;
}

function SuggestionTypingLabel({ text, animate }: { text: string; animate: boolean }) {
  const [n, setN] = React.useState(animate ? 0 : text.length);
  React.useEffect(() => {
    if (!animate) {
      setN(text.length);
      return;
    }
    setN(0);
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setN(Math.min(i, text.length));
      if (i >= text.length) window.clearInterval(id);
    }, 16);
    return () => window.clearInterval(id);
  }, [text, animate]);
  const slice = text.slice(0, n);
  return (
    <span className="font-sans">
      {slice}
      {animate && n < text.length ? (
        <span
          className="inline-block w-px h-[1cap] ml-px bg-white/55 animate-pulse align-middle translate-y-[-0.06em]"
          aria-hidden
        />
      ) : null}
    </span>
  );
}

function withImageVersion(url: string, version?: string | number | null): string {
  const trimmed = url.trim();
  const v = version || Date.now();
  return `${trimmed}${trimmed.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(v))}`;
}

function imageProcessingNeedsRepair(data: Record<string, any>): boolean {
  const status = typeof data.removeBgStatus === 'string' ? data.removeBgStatus : '';
  if (status === 'skipped') return false;
  return (
    status === 'fallback' ||
    status === 'failed' ||
    data.backgroundRemoved === false
  );
}

function framePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export const Wardrobe: React.FC<{
  items: Fragrance[];
  onDelete: (item: Fragrance) => void;
  /** Persist the preview image to the vault row (authenticated). */
  onPersistWardrobeImage?: (
    item: Fragrance,
    imageUrl?: string,
    imageAdjustment?: BottleImageAdjustment,
  ) => Promise<Fragrance | null>;
  featuredItem?: Fragrance | null;
  /** Restore in-memory snapshot after an automatic legacy wardrobe rebuild (this tab only). */
  onRevertWardrobe?: () => void;
  fixWardrobeBusy?: boolean;
  revertAvailable?: boolean;
  wardrobeFixHint?: string | null;
  /** Scroll to / focus the hero "Add to vault" search (used by Expand Archive). */
  onExpandArchive?: () => void;
  authToken?: string | null;
  wardrobeLoaded?: boolean;
  wardrobeError?: string | null;
  onRetryLoadWardrobe?: () => void;
}> = ({
  items,
  onDelete,
  onPersistWardrobeImage,
  featuredItem,
  onRevertWardrobe,
  fixWardrobeBusy,
  revertAvailable,
  wardrobeFixHint,
  onExpandArchive,
  authToken,
  wardrobeLoaded = true,
  wardrobeError = null,
  onRetryLoadWardrobe,
}) => {
  const [selectedItem, setSelectedItem] = React.useState<Fragrance | null>(null);

  // Re-bind the open detail modal to the latest row from `items` whenever the
  // parent state updates (e.g. background enrichment landed). Without this, the
  // modal renders a stale snapshot captured at open-time and metrics appear
  // "frozen" even after the vault row gains derived_metrics/enrichment.
  React.useEffect(() => {
    setSelectedItem((current) => {
      if (!current) return current;
      const match = items.find((candidate) =>
        current._dbId
          ? candidate._dbId === current._dbId
          : !candidate._dbId && candidate.id === current.id,
      );
      return match && match !== current ? match : current;
    });
  }, [items]);

  const prefetchReviews = React.useCallback((item: Fragrance) => {
    const rawReviews = extractDetailReviews(item.raw_engine_detail);
    if (rawReviews.length === 0) return;
    const name = entryName(item);
    const brand = entryBrand(item);
    const cacheKey = reviewSummaryCacheKey(name, brand, rawReviews);
    if (getCachedReviewSummary(cacheKey)) return;
    void summarizeReviews({ name, brand, reviews: rawReviews });
  }, []);

  const [searchQuery, setSearchQuery] = React.useState("");
  const deferredSearchQuery = React.useDeferredValue(searchQuery);
  
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [bgFallbackWarning, setBgFallbackWarning] = React.useState<string | null>(null);
  const [refreshCounts, setRefreshCounts] = React.useState<Record<string, number>>(() => {
    if (typeof sessionStorage === 'undefined') return {};
    try {
      const raw = sessionStorage.getItem(WARDROBE_REFRESH_COUNT_STORAGE_KEY);
      if (!raw) return {};
      const o = JSON.parse(raw) as unknown;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
      }
      return out;
    } catch {
      return {};
    }
  });
  const [clarifySolverId, setClarifySolverId] = React.useState<WardrobeImageSolverId | ''>('');
  const [pendingPreview, setPendingPreview] = React.useState<{ itemId: string; url: string; isFallback: boolean } | null>(null);
  const [reimaginingIds, setReimaginingIds] = React.useState<Set<string>>(() => new Set());
  const [usageTotals, setUsageTotals] = React.useState<UsageTotalsSnapshot | null>(null);

  const refreshUsageTotals = React.useCallback(async () => {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      const res = await fetch(USAGE_TOTAL_ENDPOINT, { headers });
      if (!res.ok) return;
      const data = (await res.json()) as { totalUsd?: unknown; count?: unknown };
      const totalUsd =
        typeof data.totalUsd === 'number' && Number.isFinite(data.totalUsd) ? data.totalUsd : 0;
      const count =
        typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : 0;
      setUsageTotals({ totalUsd, count });
    } catch {
      /* network noise — keep prior snapshot */
    }
  }, [authToken]);
  const [persistBusy, setPersistBusy] = React.useState(false);
  const [vaultSolverBanner, setVaultSolverBanner] = React.useState<string | null>(null);
  const [searchFocused, setSearchFocused] = React.useState(false);
  const [searchHighlightIndex, setSearchHighlightIndex] = React.useState(0);
  const [enlargeOpen, setEnlargeOpen] = React.useState(false);
  const [bottleImageToolsOpen, setBottleImageToolsOpen] = React.useState(false);
  const [deleteConfirming, setDeleteConfirming] = React.useState(false);
  const [frameDraft, setFrameDraft] = React.useState<NormalizedBottleImageAdjustment>(
    DEFAULT_BOTTLE_IMAGE_ADJUSTMENT,
  );
  const solverPrefillRef = React.useRef<WardrobeImageSolverId | null>(null);
  const searchBlurTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!bottleImageToolsOpen) return;
    void refreshUsageTotals();
  }, [bottleImageToolsOpen, refreshUsageTotals]);

  const openDetail = React.useCallback((item: Fragrance) => {
    setRefreshError(null);
    setPendingPreview(null);
    setDeleteConfirming(false);
    setFrameDraft(normalizeBottleImageAdjustment(item.imageAdjustment));
    setSelectedItem(item);
  }, []);

  const closeDetail = React.useCallback(() => {
    setRefreshError(null);
    setPendingPreview(null);
    setSelectedItem(null);
    setEnlargeOpen(false);
    setBottleImageToolsOpen(false);
    setDeleteConfirming(false);
    setFrameDraft(DEFAULT_BOTTLE_IMAGE_ADJUSTMENT);
  }, []);

  // Modal scroll lock + Escape (enlarge closes first)
  React.useEffect(() => {
    if (!selectedItem) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (enlargeOpen) {
        setEnlargeOpen(false);
        e.preventDefault();
      } else {
        closeDetail();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [selectedItem, enlargeOpen, closeDetail]);

  React.useEffect(() => {
    if (!selectedItem?.id) return;
    setFrameDraft(normalizeBottleImageAdjustment(selectedItem.imageAdjustment));
    const pre = solverPrefillRef.current;
    if (pre) {
      setClarifySolverId(pre);
      solverPrefillRef.current = null;
      setVaultSolverBanner(null);
    } else {
      setClarifySolverId('');
    }
  }, [selectedItem?.id]);

  const handleRefreshImage = async (item: Fragrance, solverId?: WardrobeImageSolverId) => {
    if (!solverId) {
      setRefreshError('Pick what looks wrong before searching for a new image.');
      return;
    }
    const prev = refreshCounts[item.id] ?? 0;
    const nextCount = prev + 1;
    setRefreshCounts((p) => {
      const next = { ...p, [item.id]: nextCount };
      try {
        sessionStorage.setItem(WARDROBE_REFRESH_COUNT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota / privacy mode */
      }
      return next;
    });

    setRefreshingId(item.id);
    setRefreshError(null);
    setBgFallbackWarning(null);
    try {
      const res = await fetch(REFRESH_IMAGE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: entryName(item),
          brand: entryBrand(item),
          concentrationHint: concentrationHintFromValue(item.concentration),
          refreshCount: nextCount,
          ...(solverId ? { solverId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Refresh failed');
      const returnedImageUrl =
        typeof data.imageUrl === 'string' ? data.imageUrl.trim() : '';
      if (!returnedImageUrl) {
        throw new Error('Image processing completed without a usable image URL.');
      }
      const nextUrl = withImageVersion(returnedImageUrl, data.imageHash || Date.now());
      const isFallback = imageProcessingNeedsRepair(data);
      setPendingPreview({ itemId: item.id, url: nextUrl, isFallback });
      if (isFallback) {
        const reason =
          typeof data.removeBgReason === 'string' && data.removeBgReason.trim()
            ? ` Reason: ${data.removeBgReason.trim()}.`
            : '';
        setBgFallbackWarning(
          `This preview still has a fallback background.${reason} Try another image fix before saving.`,
        );
      }
    } catch (err: any) {
      setRefreshError(err.message || 'Image refresh failed');
    } finally {
      setRefreshingId(null);
    }
  };

  const handleReimagine = (item: Fragrance) => {
    if (reimaginingIds.has(item.id)) return;
    const src =
      pendingPreview?.itemId === item.id ? pendingPreview.url : item.imageUrl;
    if (!src?.trim()) {
      setRefreshError('No image to reimagine — find one first.');
      return;
    }

    setReimaginingIds((prev) => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    setRefreshError(null);
    setBgFallbackWarning(null);

    // Fire-and-forget: the fetch lives at the Wardrobe level so the user can
    // close the detail modal and keep browsing. On success we auto-persist the
    // image to the vault so the new bottle simply "shows up" later — exactly
    // matching the 1–3 min latency story for gpt-image-* models.
    void (async () => {
      try {
        const res = await fetch(REIMAGINE_IMAGE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: entryName(item),
            brand: entryBrand(item),
            imageUrl: src,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Reimagine failed');
        const returnedImageUrl =
          typeof data.imageUrl === 'string' ? data.imageUrl.trim() : '';
        if (!returnedImageUrl) {
          throw new Error('Reimagine completed without a usable image URL.');
        }
        const nextUrl = withImageVersion(returnedImageUrl, data.imageHash || Date.now());

        if (onPersistWardrobeImage) {
          let merged: Fragrance | null = null;
          try {
            merged = await onPersistWardrobeImage(
              item,
              nextUrl,
              normalizeBottleImageAdjustment(item.imageAdjustment),
            );
          } catch {
            merged = null;
          }
          if (merged) {
            // If the user is still focused on this item, swap the modal in place
            // and clear any leftover preview. If they've navigated elsewhere,
            // leave their current selection alone — the items prop refresh from
            // upstream already shows the new bottle on the grid tile.
            setSelectedItem((prev) => (prev?.id === merged!.id ? merged! : prev));
            setPendingPreview((prev) => (prev?.itemId === item.id ? null : prev));
          } else {
            // Auto-save fell through — keep the reimagined image visible as a
            // pending preview so the user can save it manually next time they
            // open this bottle. Nothing is lost.
            setPendingPreview({
              itemId: item.id,
              url: nextUrl,
              isFallback: imageProcessingNeedsRepair(data),
            });
          }
        } else {
          // Unauthenticated: keep the preview-then-save flow.
          setPendingPreview({
            itemId: item.id,
            url: nextUrl,
            isFallback: imageProcessingNeedsRepair(data),
          });
        }
        void refreshUsageTotals();
      } catch (err: any) {
        setRefreshError(err?.message || 'Reimagine failed');
        void refreshUsageTotals();
      } finally {
        setReimaginingIds((prev) => {
          if (!prev.has(item.id)) return prev;
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    })();
  };

  const handleSavePreviewToVault = async () => {
    if (!selectedItem || !pendingPreview || pendingPreview.itemId !== selectedItem.id) return;
    if (pendingPreview.isFallback) {
      setRefreshError(
        'This preview still has a fallback background. Try another image fix before saving.',
      );
      return;
    }
    if (!onPersistWardrobeImage) {
      setRefreshError('Sign in to save this image to your vault.');
      return;
    }
    setPersistBusy(true);
    setRefreshError(null);
    try {
      const merged = await onPersistWardrobeImage(selectedItem, pendingPreview.url, frameDraft);
      if (!merged) throw new Error('Could not save — try again or check your connection.');
      closeDetail();
    } catch (err: any) {
      setRefreshError(err.message || 'Save failed');
    } finally {
      setPersistBusy(false);
    }
  };

  const handleSaveImageFrame = async () => {
    if (!selectedItem) return;
    if (!onPersistWardrobeImage) {
      setRefreshError('Sign in to save this bottle framing.');
      return;
    }
    setPersistBusy(true);
    setRefreshError(null);
    try {
      const previewUrl =
        pendingPreview?.itemId === selectedItem.id ? pendingPreview.url : undefined;
      const merged = await onPersistWardrobeImage(selectedItem, previewUrl, frameDraft);
      if (!merged) throw new Error('Could not save framing.');
      setSelectedItem(merged);
      setPendingPreview(null);
      setBgFallbackWarning(null);
      setBottleImageToolsOpen(false);
    } catch (err: any) {
      setRefreshError(err.message || 'Frame save failed');
    } finally {
      setPersistBusy(false);
    }
  };

  // Performance Optimization: Memoize computationally heavy filter operations
  const filteredItems = React.useMemo(() => {
    const q = deferredSearchQuery.trim();
    if (!q) return items;
    return items.filter(item => {
      const name = entryName(item);
      const brand = entryBrand(item);
      if (!name || !brand) return false;

      return matchesWardrobeQuery(item, q);
    });
  }, [items, deferredSearchQuery]);

  const searchSuggestions = React.useMemo(
    () => buildWardrobeSearchSuggestions(items, deferredSearchQuery),
    [items, deferredSearchQuery],
  );

  React.useEffect(() => {
    setSearchHighlightIndex(0);
  }, [searchQuery, searchSuggestions.length]);

  const applySearchSuggestion = React.useCallback((s: WardrobeSearchSuggestion) => {
    if (s.kind === 'fragrance') {
      const nm = entryName(s.item);
      const br = entryBrand(s.item);
      setSearchQuery(`${br} ${nm}`.trim());
      setSearchFocused(false);
      setRefreshError(null);
      setPendingPreview(null);
      setFrameDraft(normalizeBottleImageAdjustment((s.item as Fragrance).imageAdjustment));
      setSelectedItem(s.item as Fragrance);
    } else {
      solverPrefillRef.current = s.id;
      setVaultSolverBanner(`Next profile: image hint — ${s.label}`);
      setSearchQuery('');
      setSearchFocused(false);
    }
  }, []);

  // Performance Optimization: Memoize shelf chunking
  const shelves = React.useMemo(() => {
    const itemsPerShelf = 4;
    const chunked = [];
    for (let i = 0; i < filteredItems.length; i += itemsPerShelf) {
      chunked.push(filteredItems.slice(i, i + itemsPerShelf));
    }
    return chunked;
  }, [filteredItems]);

  const detailNeedsClarify =
    selectedItem !== null && (refreshCounts[selectedItem.id] ?? 0) > 2;

  const detailBottleUrl =
    selectedItem && pendingPreview?.itemId === selectedItem.id
      ? pendingPreview.url
      : selectedItem?.imageUrl ?? '';

  const selectedReimagining =
    !!selectedItem && reimaginingIds.has(selectedItem.id);

  const imageToolbarBusy =
    !!selectedItem &&
    (refreshingId === selectedItem.id || selectedReimagining || persistBusy);

  const hasPendingPreview =
    !!selectedItem && !!pendingPreview && pendingPreview.itemId === selectedItem.id;

  const frameDirty =
    !!selectedItem && !bottleImageAdjustmentsEqual(frameDraft, selectedItem.imageAdjustment);

  const updateFrameDraft = React.useCallback((patch: BottleImageAdjustment) => {
    setFrameDraft((current) => normalizeBottleImageAdjustment({ ...current, ...patch }));
  }, []);

  const selectedMetrics =
    selectedItem?.derived_metrics ?? selectedItem?.raw_engine_detail?.derived_metrics ?? null;
  const selectedCoverage =
    normalizeSourceCoverage(
      selectedItem?.source_coverage ?? selectedItem?.raw_engine_detail?.source_coverage,
      selectedMetrics,
      selectedItem?.enrichment ?? selectedItem?.raw_engine_detail?.enrichment ?? undefined,
    );
  const detailMetaRows = selectedItem
    ? [
        { label: 'Year', value: formatYear(selectedItem.year) },
        { label: 'Gender', value: stringValue(selectedItem.gender) },
        { label: 'Concentration', value: stringValue(selectedItem.concentration) },
        { label: 'Environment', value: stringValue(selectedItem.season) },
      ].filter((row): row is { label: string; value: string } => Boolean(row.value))
    : [];

  React.useEffect(() => {
    setBottleImageToolsOpen(false);
    setDeleteConfirming(false);
  }, [selectedItem?.id]);

  React.useEffect(() => {
    if (hasPendingPreview) setBottleImageToolsOpen(true);
  }, [hasPendingPreview]);

  const searchDropdownOpen =
    searchFocused && searchQuery.trim().length > 0 && searchSuggestions.length > 0;

  const cancelSearchBlur = () => {
    if (searchBlurTimerRef.current !== null) {
      window.clearTimeout(searchBlurTimerRef.current);
      searchBlurTimerRef.current = null;
    }
  };

  const scheduleSearchBlur = () => {
    cancelSearchBlur();
    searchBlurTimerRef.current = window.setTimeout(() => {
      setSearchFocused(false);
      searchBlurTimerRef.current = null;
    }, 160);
  };

  return (
    <div className="relative">
      <div className="space-y-12 sm:space-y-16 relative z-10">
        <div className="flex flex-col items-center justify-center text-center gap-7 sm:gap-8">
          <div className="space-y-3">
            <h2 className="font-serif italic text-[clamp(2.65rem,8vw,5.35rem)] text-[#fff7ec] tracking-normal leading-none">Vault of Aromas</h2>
          </div>
          <div className="flex flex-col items-center gap-6 w-full">
            {(wardrobeFixHint || revertAvailable || fixWardrobeBusy) && (
              <div className="flex flex-col items-center gap-3 w-full max-w-2xl">
                {onRevertWardrobe ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={onRevertWardrobe}
                      disabled={!revertAvailable || !!fixWardrobeBusy}
                      title="Restore the vault list from before the last automatic rebuild (this tab only)"
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 bg-white/[0.04] text-white/70 text-[10px] uppercase tracking-[0.2em] font-bold hover:bg-white/[0.08] hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Undo2 size={14} />
                      Revert
                    </button>
                  </div>
                ) : null}
                {fixWardrobeBusy ? (
                  <p className="text-[11px] text-scent-gold-100/70 font-sans text-center leading-snug max-w-xl px-2">
                    Rebuilding wardrobe…
                  </p>
                ) : null}
                {wardrobeFixHint ? (
                  <p className="text-[11px] text-white/45 font-sans text-center leading-snug max-w-xl px-2">
                    {wardrobeFixHint}
                  </p>
                ) : null}
              </div>
            )}
            <div className="relative w-full max-w-[56rem] z-20">
              <label htmlFor="wardrobe-vault-search" className="sr-only">
                Search vault fragrances and image hints
              </label>
              <Search size={23} strokeWidth={1.5} className="pointer-events-none absolute left-5 sm:left-6 top-1/2 z-10 -translate-y-1/2 text-scent-accent/82" />
              <input
                id="wardrobe-vault-search"
                type="text"
                role="combobox"
                aria-expanded={searchDropdownOpen}
                aria-controls="wardrobe-search-suggestions"
                aria-autocomplete="list"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => {
                  cancelSearchBlur();
                  setSearchFocused(true);
                }}
                onBlur={scheduleSearchBlur}
                onKeyDown={(e) => {
                  if (!searchDropdownOpen) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSearchHighlightIndex((i) =>
                      Math.min(i + 1, Math.max(0, searchSuggestions.length - 1)),
                    );
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSearchHighlightIndex((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const pick = searchSuggestions[searchHighlightIndex];
                    if (pick) applySearchSuggestion(pick);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearchFocused(false);
                  }
                }}
                placeholder="Search vault or image hint (e.g. watermark, sauvage)…"
                autoComplete="off"
                className="scent-lux-input w-full h-[58px] sm:h-[68px] pl-14 sm:pl-16 pr-14 sm:pr-16 text-center text-[#fff7ec] font-sans text-[15px] sm:text-base outline-none transition-all placeholder:text-[#d9c2a4]/58"
              />
              <AnimatePresence>
                {searchDropdownOpen ? (
                  <motion.ul
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18 }}
                    id="wardrobe-search-suggestions"
                    role="listbox"
                    className="absolute left-0 right-0 top-full mt-2 max-h-[min(320px,50vh)] overflow-y-auto rounded-[var(--radius-scent)] border border-scent-accent/32 bg-neutral-950/98 shadow-[0_24px_48px_rgba(0,0,0,0.78)] backdrop-blur-xl scrollbar-hide z-30"
                  >
                    <li className="px-3 py-2 border-b border-white/8 pointer-events-none">
                      <p className="text-[8px] uppercase tracking-[0.35em] text-white/35 font-bold font-sans">
                        Matches
                      </p>
                    </li>
                    {searchSuggestions.map((sug, idx) => {
                      const active = idx === searchHighlightIndex;
                      const primary = suggestionPrimaryLine(sug);
                      const sub =
                        sug.kind === 'solver'
                          ? 'Image search tuning — Find image uses this hint'
                          : [sug.item.family, ...(sug.item.notes ?? []).slice(0, 2)]
                              .filter(Boolean)
                              .join(' · ');
                      return (
                        <li key={`${sug.kind}-${sug.kind === 'fragrance' ? sug.item.id : sug.id}`} role="none">
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`w-full text-left px-3 py-2.5 transition-colors border-b border-white/[0.06] last:border-b-0 ${
                              active ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'
                            }`}
                            onMouseEnter={() => setSearchHighlightIndex(idx)}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              cancelSearchBlur();
                              applySearchSuggestion(sug);
                            }}
                          >
                            <div className="text-[13px] text-white/92 leading-snug">
                              <SuggestionTypingLabel text={primary} animate={active} />
                            </div>
                            {sub ? (
                              <div className="text-[10px] text-white/40 mt-0.5 font-sans truncate">{sub}</div>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </motion.ul>
                ) : null}
              </AnimatePresence>
              {vaultSolverBanner ? (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-scent-accent/35 bg-scent-accent/10 px-3 py-2.5 text-left">
                  <p className="flex-1 text-[11px] text-white/80 font-sans leading-snug">{vaultSolverBanner}</p>
                  <button
                    type="button"
                    onClick={() => setVaultSolverBanner(null)}
                    className="shrink-0 text-[10px] uppercase tracking-widest text-white/45 hover:text-white px-1"
                    aria-label="Dismiss hint"
                  >
                    ✕
                  </button>
                </div>
              ) : null}
            </div>
            <div className="scent-full-bleed w-full">
              <div className="scent-entry-count w-full font-serif italic text-xl sm:text-2xl whitespace-nowrap">
                <span>{filteredItems.length} Entries</span>
              </div>
            </div>
          </div>
        </div>

        {!searchQuery && items.length >= 10 && featuredItem && (
          <section className="space-y-16 py-24 bg-gradient-to-b from-white/[0.03] to-transparent border-y border-white/5 relative overflow-hidden">
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
            <div className="flex items-center gap-4 px-4 relative z-10">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
              <h3 className="font-serif italic text-2xl text-white/60 tracking-[0.3em] uppercase">Tactical Selection</h3>
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            </div>
            <div className="flex justify-center relative z-10">
              <div className="relative group max-w-sm w-full">
                <div className="pedestal p-1">
                  <motion.div
                    initial={{ scale: 0.98, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                    className="glass-acrylic glass-acrylic-animate rounded-scent p-20 aspect-[3/4] flex flex-col items-center relative overflow-hidden cursor-pointer"
                    onClick={() => openDetail(featuredItem)}
                    onMouseEnter={() => prefetchReviews(featuredItem)}
                  >
                    <div className="absolute top-10 left-10 text-[9px] uppercase tracking-[0.6em] text-white/30 font-bold z-20 pointer-events-none">Recommended Manifest</div>
                    <div className={bottleFeaturedSlotClass()}>
                      <BottleImage
                        variant="featured"
                        src={featuredItem.imageUrl}
                        alt={entryName(featuredItem)}
                        adjustment={featuredItem.imageAdjustment}
                        className="min-h-0 w-full flex-1"
                        imgClassName="group-hover:scale-105 transition-transform duration-1000 brightness-[1.15]"
                        loading="eager"
                        fetchPriority="high"
                      />
                    </div>
                    <div className="text-center mt-4 mb-2 space-y-3 shrink-0 px-2">
                      <p className="text-[10px] uppercase text-white/50 tracking-[0.5em] font-bold font-sans">{entryBrand(featuredItem)}</p>
                      <h4 className="font-serif italic text-3xl sm:text-5xl text-white tracking-tighter">{entryName(featuredItem)}</h4>
                    </div>
                  </motion.div>
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="space-y-8 pb-28 sm:pb-36">
          {wardrobeError ? (
            <div className="py-24 px-4 text-center border border-white/10 bg-white/[0.02] rounded-scent flex flex-col items-center justify-center gap-6">
              <div className="space-y-2">
                <p className="font-serif italic text-3xl text-white/90">Olfactory Vault Synchronization Offline</p>
                <p className="text-sm text-scent-muted max-w-md mx-auto">{wardrobeError}</p>
              </div>
              {onRetryLoadWardrobe && (
                <button
                  type="button"
                  onClick={onRetryLoadWardrobe}
                  className="scent-primary-button px-8 py-3 rounded-scent font-serif italic text-lg"
                >
                  Retry Load
                </button>
              )}
            </div>
          ) : !wardrobeLoaded ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 lg:gap-5">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="scent-fragrance-card w-full min-h-[32rem] relative overflow-hidden flex flex-col">
                  <div className="scent-card-frame" aria-hidden />
                  <div className="relative z-[1] flex h-full flex-col items-center px-6 sm:px-8 pt-7 sm:pt-9 pb-6 sm:pb-7">
                    <div className="h-4 w-2/3 bg-white/10 rounded animate-pulse mt-2" />
                    <div className="relative flex-1 w-full mt-4 sm:mt-5 mb-5 sm:mb-6 min-h-0 flex items-center justify-center">
                      <div className="w-24 h-48 bg-white/5 rounded-full animate-pulse opacity-50" />
                    </div>
                    <div className="h-6 w-3/4 bg-white/10 rounded animate-pulse shrink-0 mb-2" />
                  </div>
                </div>
              ))}
            </div>
          ) : shelves.length > 0 ? (
            shelves.map((shelfItems, shelfIndex) => (
              <div key={shelfIndex} className="relative group/shelf">
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 lg:gap-5 mb-1">
                  {shelfItems.map((item, i) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }} transition={{ delay: i * 0.08, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                      className="group cursor-pointer relative h-full min-w-0"
                      onClick={() => openDetail(item)}
                      onMouseEnter={() => prefetchReviews(item)}
                    >
                      <div className="scent-fragrance-card w-full h-full min-h-[26rem] transition-[transform,border-color,box-shadow] duration-500 motion-reduce:transition-none group-hover:-translate-y-1.5 motion-reduce:group-hover:translate-y-0 relative overflow-hidden flex flex-col">
                        <div className="scent-card-frame" aria-hidden />
                        <div className="relative z-[1] flex h-full flex-col items-center px-6 sm:px-8 pt-5 sm:pt-6 pb-4 sm:pb-5">
                          <p
                            className="scent-card-brand w-full mt-1 sm:mt-1.5"
                            data-len={brandLengthBucket(entryBrand(item))}
                            title={entryBrand(item)}
                          >
                            <span className="scent-brand-gold-shimmer">{entryBrand(item)}</span>
                          </p>
                          <div className="relative flex-1 w-full mt-3 sm:mt-4 mb-3 sm:mb-4 min-h-0">
                            <BottleImage
                              variant="grid"
                              src={item.imageUrl}
                              alt={entryName(item)}
                              adjustment={item.imageAdjustment}
                              className="absolute inset-0 z-10"
                              imgClassName="brightness-[1.1] group-hover:scale-[1.035] motion-reduce:group-hover:scale-100 transition-transform duration-[900ms] motion-reduce:transition-none"
                              loading={shelfIndex === 0 ? 'eager' : 'lazy'}
                              fetchPriority={shelfIndex === 0 ? 'high' : undefined}
                            />
                          </div>
                          <div className="scent-card-title-row shrink-0">
                            <h3 className="scent-card-title" title={entryName(item)}>{entryName(item)}</h3>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                  {shelfIndex === shelves.length - 1 && shelfItems.length < 4 && (
                    <button
                      type="button"
                      onClick={() => onExpandArchive?.()}
                      aria-label="Expand archive — go to add fragrance search"
                      className="scent-fragrance-card min-h-[28rem] flex flex-col items-center justify-center p-8 text-center group cursor-pointer border-dashed border-scent-accent/26 hover:bg-white/5 transition-all w-full"
                    >
                      <div className="w-12 h-12 border border-dashed border-scent-accent/35 flex items-center justify-center group-hover:rotate-90 transition-transform mb-4 rounded-full">
                        <span className="text-scent-accent/55 text-3xl">+</span>
                      </div>
                      <p className="font-serif italic text-scent-accent/45 text-2xl tracking-tighter uppercase">Expand Archive</p>
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : !searchQuery && (
            <div className="py-40 text-center border border-dashed border-white/5 rounded-scent">
              <p className="font-serif italic text-4xl text-white/10">The vault is currently vacant</p>
            </div>
          )}
        </div>
      </div>

      {typeof document !== 'undefined' ? createPortal(
      <AnimatePresence>
        {selectedItem && (
          <div 
            className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fragrance-detail-title"
          >
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeDetail} className="absolute inset-0 bg-black/95 backdrop-blur-3xl" />
            <motion.div
              className="relative w-full h-full sm:h-[94dvh] sm:max-w-[100rem] sm:mx-4 bg-[#030303] shadow-2xl overflow-hidden flex flex-col border-0 sm:border border-white/8"
            >
              <div
                className="flex-1 overflow-y-auto scrollbar-hide px-4 sm:px-7 lg:px-10 pb-4"
                style={
                  {
                    WebkitOverflowScrolling: 'touch',
                    paddingTop: 'max(1.25rem, env(safe-area-inset-top))',
                  } as React.CSSProperties
                }
              >
                <div className="mx-auto max-w-[92rem] space-y-4 sm:space-y-5 py-5 sm:py-7">
                  <header className="mx-auto max-w-3xl text-center">
                    <div className="space-y-2">
                      <h2
                        id="fragrance-detail-title"
                        className="font-serif italic text-5xl sm:text-7xl lg:text-8xl leading-[0.92] text-[#fff7ec] tracking-normal uppercase"
                      >
                        {entryName(selectedItem)}
                      </h2>
                      <p className="font-serif text-lg sm:text-2xl uppercase tracking-[0.28em] text-white/84">
                        <span className="scent-brand-gold-shimmer">{entryBrand(selectedItem)}</span>
                      </p>
                    </div>
                  </header>

                  <ProfileScorePanel
                    section="tiles"
                    metrics={selectedMetrics}
                    coverage={selectedCoverage}
                    legacyPerformance={selectedItem.performance}
                  />

                  <div className="grid grid-cols-1 items-stretch gap-3 sm:gap-4 lg:grid-cols-[1.12fr_1.95fr_1fr]">
                    <div className="space-y-3 sm:space-y-4 lg:h-full">
                      <ScentNotesInfographic
                        derivedMetrics={selectedMetrics}
                        legacyPyramid={selectedItem.pyramid}
                        scentAxesFallback={selectedItem.scent_vector ?? null}
                        variant="accords"
                        className="lg:h-full lg:min-h-[21.25rem]"
                      />
                    </div>

                    <div className="space-y-3 sm:space-y-4 lg:h-full">
                      <ScentNotesInfographic
                        derivedMetrics={selectedMetrics}
                        legacyPyramid={selectedItem.pyramid}
                        variant="notes"
                        className="lg:h-full lg:min-h-[21.25rem]"
                      />
                    </div>

                    <div className="space-y-3 sm:space-y-4 lg:h-full">
                      <FragrancePanel
                        title="About This Fragrance"
                        className="lg:h-full lg:min-h-[21.25rem]"
                        titleSuffix={
                          <button
                            type="button"
                            onClick={() => setBottleImageToolsOpen((o) => !o)}
                            className={`p-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/45 hover:text-white hover:bg-white/[0.08] transition-all flex items-center justify-center ${
                              bottleImageToolsOpen ? 'text-scent-accent border-scent-accent/30 bg-scent-accent/5' : ''
                            }`}
                            title="Adjust bottle image and settings"
                            aria-label="Toggle bottle image controls"
                            aria-expanded={bottleImageToolsOpen}
                          >
                            <HelpCircle size={13} />
                          </button>
                        }
                      >
                        <div className="flex flex-col p-4 space-y-3">
                          <div 
                            className="relative h-56 sm:h-72 lg:h-64 min-h-0 w-full shrink-0 overflow-hidden cursor-pointer rounded-lg border border-white/5 bg-white/[0.01]"
                            onClick={() => detailBottleUrl && setEnlargeOpen(true)}
                          >
                            <BottleImage
                              key={detailBottleUrl || 'missing-image'}
                              variant="detail"
                              src={detailBottleUrl}
                              alt={entryName(selectedItem)}
                              adjustment={frameDraft}
                              showFrameGuide={bottleImageToolsOpen}
                              className="absolute inset-0"
                              imgClassName="transition-all duration-300"
                            />
                          </div>

                          {detailBottleUrl && !bottleImageToolsOpen ? (
                            <div className="flex w-full shrink-0 justify-center">
                              <button
                                type="button"
                                onClick={() => setEnlargeOpen(true)}
                                className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.04] px-3.5 py-1.5 text-[9px] uppercase tracking-[0.2em] font-bold text-white/62 transition-colors hover:border-scent-accent/35 hover:bg-scent-accent/[0.08] hover:text-scent-accent"
                                aria-label="Enlarge bottle image"
                              >
                                <Maximize2 size={13} strokeWidth={2} />
                                Enlarge
                              </button>
                            </div>
                          ) : null}

                          {!bottleImageToolsOpen && detailMetaRows.length > 0 ? (
                            <div className="border-t border-white/[0.06] pt-3">
                              <div className="grid grid-cols-2 gap-px">
                                {detailMetaRows.map(({ label, value }) => (
                                  <div key={label} className="flex flex-col items-center gap-1 py-2 text-center">
                                    <p className="text-[8px] font-semibold uppercase tracking-[0.2em] text-white/35">{label}</p>
                                    <p className="text-[11px] font-medium leading-snug text-white/72">{value}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {bottleImageToolsOpen ? (
                            <div
                              id="wardrobe-bottle-tools-panel"
                              role="region"
                              className="space-y-3 pt-2 border-t border-white/5"
                            >
                              <p className="text-center text-[10px] text-white/40 leading-snug font-sans">
                                Pick what looks wrong, then search — or reimagine the current bottle. Save when it looks right.
                              </p>

                              <div className="space-y-3">
                                <label htmlFor="wardrobe-clarify-solver" className="sr-only">
                                  Search tuning for bottle image
                                </label>
                                <select
                                  id="wardrobe-clarify-solver"
                                  value={clarifySolverId}
                                  onChange={(e) =>
                                    setClarifySolverId((e.target.value || '') as WardrobeImageSolverId | '')
                                  }
                                  disabled={imageToolbarBusy}
                                  className="w-full bg-black/45 border border-white/12 text-white text-[11px] py-2 px-2 rounded-lg font-sans outline-none focus:border-scent-accent/50 disabled:opacity-40"
                                >
                                  <option value="">Choose what looks wrong…</option>
                                  {WARDROBE_CLARIFY_SOLVERS.map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {s.label}
                                    </option>
                                  ))}
                                </select>

                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleRefreshImage(selectedItem, clarifySolverId || undefined)
                                    }
                                    disabled={imageToolbarBusy || !clarifySolverId}
                                    title={
                                      !clarifySolverId ? 'Select an issue first' : undefined
                                    }
                                    className="flex-1 min-h-[38px] py-2 bg-white text-black uppercase tracking-[0.22em] text-[9px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed rounded-lg"
                                  >
                                    {refreshingId === selectedItem.id ? (
                                      <>
                                        <RefreshCw size={11} className="animate-spin" /> Searching…
                                      </>
                                    ) : (
                                      <>
                                        <RefreshCw size={11} /> Find image
                                      </>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleReimagine(selectedItem)}
                                    disabled={
                                      imageToolbarBusy || !detailBottleUrl?.trim()
                                    }
                                    title={
                                      !detailBottleUrl?.trim()
                                        ? 'Need an image first'
                                        : 'Reimagine this bottle on a transparent background (1–3 min)'
                                    }
                                    className="flex-1 min-h-[38px] py-2 bg-white/[0.06] text-white uppercase tracking-[0.18em] text-[9px] font-bold border border-white/15 hover:bg-white/[0.1] active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-35 disabled:cursor-not-allowed rounded-lg"
                                  >
                                    {selectedReimagining ? (
                                      <>
                                        <RefreshCw size={11} className="animate-spin" /> Reimagining…
                                      </>
                                    ) : (
                                      <>
                                        <Sparkles size={11} /> Reimagine
                                      </>
                                    )}
                                  </button>
                                </div>

                                {selectedReimagining ? (
                                  <div className="rounded-lg border border-white/15 bg-white/[0.04] px-2.5 py-2.5 text-center space-y-1">
                                    <p className="text-[8px] uppercase tracking-[0.28em] text-white/70 font-bold">
                                      Reimagining your bottle
                                    </p>
                                    <p className="text-[9px] leading-snug text-white/55 font-sans">
                                      This usually takes 1–3 minutes. You can close this panel and
                                      keep browsing — the new bottle will save to your vault
                                      automatically when it&apos;s ready.
                                    </p>
                                  </div>
                                ) : null}

                                {usageTotals ? (
                                  <p className="text-center text-[8px] uppercase tracking-[0.22em] text-white/35 font-sans">
                                    Reimagine spend so far ·{' '}
                                    <span className="tabular-nums text-white/55">
                                      ${usageTotals.totalUsd.toFixed(3)}
                                    </span>{' '}
                                    across {usageTotals.count} call{usageTotals.count === 1 ? '' : 's'}
                                  </p>
                                ) : null}

                                <div className="rounded-lg border border-white/10 bg-black/22 p-2.5 space-y-2.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-[8px] uppercase tracking-[0.25em] text-white/45 font-bold">
                                      Frame
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => setFrameDraft(DEFAULT_BOTTLE_IMAGE_ADJUSTMENT)}
                                      disabled={imageToolbarBusy}
                                      title="Reset frame"
                                      aria-label="Reset bottle frame"
                                      className="p-1 rounded-md border border-white/10 bg-white/[0.04] text-white/45 hover:text-white hover:bg-white/[0.08] disabled:opacity-30"
                                    >
                                      <RotateCcw size={11} />
                                    </button>
                                  </div>

                                  <div className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-1.5">
                                    <label className="flex items-center gap-1 text-[8px] uppercase tracking-[0.14em] text-white/42 font-bold">
                                      <ZoomIn size={10} /> Size
                                    </label>
                                    <input
                                      type="range"
                                      min="0.7"
                                      max="1.45"
                                      step="0.01"
                                      value={frameDraft.scale}
                                      onChange={(e) => updateFrameDraft({ scale: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Bottle image size"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[9px] tabular-nums text-white/42">
                                      {framePercent(frameDraft.scale)}
                                    </span>

                                    <label className="flex items-center gap-1 text-[8px] uppercase tracking-[0.14em] text-white/42 font-bold">
                                      <MoveHorizontal size={10} /> X
                                    </label>
                                    <input
                                      type="range"
                                      min="-18"
                                      max="18"
                                      step="0.5"
                                      value={frameDraft.x}
                                      onChange={(e) => updateFrameDraft({ x: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Bottle horizontal position"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[9px] tabular-nums text-white/42">
                                      {Math.round(frameDraft.x)}
                                    </span>

                                    <label className="flex items-center gap-1 text-[8px] uppercase tracking-[0.14em] text-white/42 font-bold">
                                      <MoveVertical size={10} /> Y
                                    </label>
                                    <input
                                      type="range"
                                      min="-18"
                                      max="18"
                                      step="0.5"
                                      value={frameDraft.y}
                                      onChange={(e) => updateFrameDraft({ y: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Bottle vertical position"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[9px] tabular-nums text-white/42">
                                      {Math.round(frameDraft.y)}
                                    </span>

                                    <label className="flex items-center gap-1 text-[8px] uppercase tracking-[0.14em] text-white/42 font-bold">
                                      <ArrowUp size={10} /> Top
                                    </label>
                                    <input
                                      type="range"
                                      min="0"
                                      max={BOTTLE_CROP_STORED_MAX}
                                      step="0.5"
                                      value={frameDraft.cropTop}
                                      onChange={(e) => updateFrameDraft({ cropTop: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Crop from top of bottle image"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[9px] tabular-nums text-white/42">
                                      {Math.round(frameDraft.cropTop)}
                                    </span>

                                    <label className="flex items-center gap-1 text-[8px] uppercase tracking-[0.14em] text-white/42 font-bold">
                                      <ArrowRight size={10} /> Right
                                    </label>
                                    <input
                                      type="range"
                                      min="0"
                                      max={BOTTLE_CROP_STORED_MAX}
                                      step="0.5"
                                      value={frameDraft.cropRight}
                                      onChange={(e) => updateFrameDraft({ cropRight: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Crop from right of bottle image"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[9px] tabular-nums text-white/42">
                                      {Math.round(frameDraft.cropRight)}
                                    </span>

                                    <label className="flex items-center gap-1 text-[8px] uppercase tracking-[0.14em] text-white/42 font-bold">
                                      <ArrowDown size={10} /> Bottom
                                    </label>
                                    <input
                                      type="range"
                                      min="0"
                                      max={BOTTLE_CROP_STORED_MAX}
                                      step="0.5"
                                      value={frameDraft.cropBottom}
                                      onChange={(e) => updateFrameDraft({ cropBottom: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Crop from bottom of bottle image"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[9px] tabular-nums text-white/42">
                                      {Math.round(frameDraft.cropBottom)}
                                    </span>

                                    <label className="flex items-center gap-1 text-[8px] uppercase tracking-[0.14em] text-white/42 font-bold">
                                      <ArrowLeft size={10} /> Left
                                    </label>
                                    <input
                                      type="range"
                                      min="0"
                                      max={BOTTLE_CROP_STORED_MAX}
                                      step="0.5"
                                      value={frameDraft.cropLeft}
                                      onChange={(e) => updateFrameDraft({ cropLeft: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Crop from left of bottle image"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[9px] tabular-nums text-white/42">
                                      {Math.round(frameDraft.cropLeft)}
                                    </span>
                                  </div>

                                  <div className="grid grid-cols-2 gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => updateFrameDraft({ scale: frameDraft.scale - 0.1 })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      className="min-h-[30px] rounded-md border border-white/10 bg-white/[0.035] text-[8px] uppercase tracking-[0.13em] text-white/52 font-bold flex items-center justify-center gap-1.5 disabled:opacity-30 hover:bg-white/[0.06] hover:text-white"
                                    >
                                      <ZoomOut size={10} /> 10%
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => updateFrameDraft({ scale: frameDraft.scale + 0.1 })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      className="min-h-[30px] rounded-md border border-white/10 bg-white/[0.035] text-[8px] uppercase tracking-[0.13em] text-white/52 font-bold flex items-center justify-center gap-1.5 disabled:opacity-30 hover:bg-white/[0.06] hover:text-white"
                                    >
                                      <ZoomIn size={10} /> 10%
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => updateFrameDraft({ x: 0, y: 0 })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      className="min-h-[30px] rounded-md border border-white/10 bg-white/[0.035] text-[8px] uppercase tracking-[0.13em] text-white/52 font-bold flex items-center justify-center gap-1.5 disabled:opacity-30 hover:bg-white/[0.06] hover:text-white"
                                    >
                                      <MoveHorizontal size={10} /> Center
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateFrameDraft({
                                          cropTop: Math.max(
                                            frameDraft.cropTop,
                                            Math.round(BOTTLE_CROP_STORED_MAX * 0.3),
                                          ),
                                          cropRight: Math.max(
                                            frameDraft.cropRight,
                                            Math.round(BOTTLE_CROP_STORED_MAX * 0.3),
                                          ),
                                          cropBottom: Math.max(
                                            frameDraft.cropBottom,
                                            Math.round(BOTTLE_CROP_STORED_MAX * 0.12),
                                          ),
                                          cropLeft: Math.max(
                                            frameDraft.cropLeft,
                                            Math.round(BOTTLE_CROP_STORED_MAX * 0.3),
                                          ),
                                          scale: Math.max(frameDraft.scale, 1.08),
                                        })
                                      }
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      className="min-h-[30px] rounded-md border border-white/10 bg-white/[0.035] text-[8px] uppercase tracking-[0.13em] text-white/52 font-bold flex items-center justify-center gap-1.5 disabled:opacity-30 hover:bg-white/[0.06] hover:text-white"
                                    >
                                      <Crop size={10} /> Tight
                                    </button>
                                  </div>

                                  {frameDirty && !hasPendingPreview ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleSaveImageFrame()}
                                      disabled={imageToolbarBusy || !onPersistWardrobeImage}
                                      className="w-full min-h-[36px] rounded-lg bg-scent-accent text-black uppercase tracking-[0.2em] text-[9px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                      {persistBusy ? (
                                        <>
                                          <RefreshCw size={11} className="animate-spin" /> Saving...
                                        </>
                                      ) : (
                                        <>
                                          <Save size={11} /> Save framing
                                        </>
                                      )}
                                    </button>
                                  ) : null}
                                </div>

                                {hasPendingPreview && (
                                  <div className="flex flex-col gap-2 pt-2 border-t border-white/8">
                                    {!onPersistWardrobeImage ? (
                                      <p className="text-[9px] text-scent-gold-200/75 text-center font-sans leading-snug px-1">
                                        Sign in to save this preview to your vault.
                                      </p>
                                    ) : null}
                                    {pendingPreview?.isFallback ? (
                                      <p className="text-[9px] text-scent-gold-200/85 text-center font-sans leading-snug px-1">
                                        This preview still has a fallback background. Try another image fix before saving.
                                      </p>
                                    ) : null}
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={() => void handleSavePreviewToVault()}
                                        disabled={
                                          persistBusy ||
                                          !onPersistWardrobeImage ||
                                          !!pendingPreview?.isFallback
                                        }
                                        title={
                                          !onPersistWardrobeImage
                                            ? 'Sign in to save to your vault'
                                            : pendingPreview?.isFallback
                                              ? 'This preview used a fallback background — try another fix first'
                                              : undefined
                                        }
                                        className="flex-1 min-h-[38px] py-2 bg-scent-accent text-black uppercase tracking-[0.2em] text-[9px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg"
                                      >
                                        {persistBusy ? (
                                          <>
                                            <RefreshCw size={11} className="animate-spin" /> Saving…
                                          </>
                                        ) : (
                                          <>
                                            <Check size={11} /> Save to vault
                                          </>
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setPendingPreview(null)}
                                        disabled={persistBusy}
                                        className="flex-1 min-h-[38px] py-2 bg-transparent text-white/50 uppercase tracking-[0.18em] text-[9px] font-bold border border-white/12 hover:bg-white/[0.05] hover:text-white/80 rounded-lg disabled:opacity-30"
                                      >
                                        Discard preview
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </FragrancePanel>
                    </div>
                  </div>

                  <ReviewsPanel
                    name={entryName(selectedItem)}
                    brand={entryBrand(selectedItem)}
                    reviews={extractDetailReviews(selectedItem.raw_engine_detail)}
                  />

                </div>
              </div>

              {/* Pinned footer — bottle tools + delete */}
              <div
                className="px-5 pt-3 shrink-0 border-t border-white/5 flex flex-col gap-3"
                style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
              >
                {refreshError && (
                  <p className="text-[9px] text-red-400/80 text-center leading-snug px-2 py-1">{refreshError}</p>
                )}
                {!refreshError && bgFallbackWarning && (
                  <p className="text-[9px] text-yellow-400/70 text-center leading-snug px-2 py-1">{bgFallbackWarning}</p>
                )}



                <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
                  <button
                    type="button"
                    onClick={() => {
                      if (deleteConfirming) {
                        setDeleteConfirming(false);
                        return;
                      }
                      closeDetail();
                    }}
                    className="min-h-[46px] border-r border-white/10 px-3 py-3 text-[10px] font-bold uppercase tracking-[0.26em] text-white/52 transition-colors hover:bg-white/[0.05] hover:text-white"
                  >
                    {deleteConfirming ? 'Go back' : 'Close'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!deleteConfirming) {
                        setDeleteConfirming(true);
                        return;
                      }
                      onDelete(selectedItem);
                      closeDetail();
                    }}
                    disabled={imageToolbarBusy}
                    aria-label={deleteConfirming ? "Confirm delete from vault" : "Delete from vault"}
                    className={`group flex min-h-[46px] items-center justify-center gap-2 px-3 py-3 text-[10px] font-bold uppercase tracking-[0.24em] transition-all disabled:cursor-not-allowed disabled:opacity-25 ${
                      deleteConfirming
                        ? 'bg-red-500/12 text-red-300 hover:bg-red-500/18 hover:text-red-200'
                        : 'text-white/35 hover:bg-red-500/[0.06] hover:text-red-400'
                    }`}
                  >
                    <Trash2 size={14} className={deleteConfirming ? '' : 'group-hover:animate-bounce'} />
                    <span className="hidden sm:inline">
                      {deleteConfirming ? 'Confirm delete' : 'Delete from vault'}
                    </span>
                    <span className="sm:hidden">{deleteConfirming ? 'Confirm' : 'Delete'}</span>
                  </button>
                </div>
              </div>
            </motion.div>
            <AnimatePresence>
              {enlargeOpen && detailBottleUrl ? (
                <motion.div
                  key="bottle-enlarge"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Enlarged bottle image"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="fixed inset-0 z-[130] flex flex-col items-center justify-center bg-black/93 px-4 py-12"
                  onClick={() => setEnlargeOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => setEnlargeOpen(false)}
                    className="absolute top-4 right-4 z-10 p-2 rounded-full border border-white/15 bg-white/10 text-white hover:bg-white/20 transition-colors"
                    aria-label="Close enlarged view"
                  >
                    <X size={22} />
                  </button>
                  <div
                    className="relative w-full max-w-[min(100%,28rem)] aspect-[3/4] max-h-[78dvh] min-h-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <BottleImage
                      variant="detail"
                      src={detailBottleUrl}
                      alt={entryName(selectedItem)}
                      adjustment={frameDraft}
                      className="absolute inset-0"
                      imgClassName="brightness-[1.08] scale-[1.02]"
                      loading="eager"
                    />
                  </div>
                  <p className="mt-5 text-[10px] uppercase tracking-[0.35em] text-white/35 font-bold font-sans">
                    Tap outside or Esc to close
                  </p>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        )}
      </AnimatePresence>,
      document.body,
      ) : null}
    </div>
  );
};
