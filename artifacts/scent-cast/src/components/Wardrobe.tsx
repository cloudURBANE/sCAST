import React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  X,
  Trash2,
  CalendarDays,
  Activity,
  CircleDollarSign,
  RefreshCw,
  Undo2,
  HelpCircle,
  AlertCircle,
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
  Upload,
  Link2,
} from 'lucide-react';
import { ReviewsPanel } from './ReviewsPanel';
import { CyclingTilePair, type CyclingPart } from './CyclingTilePair';
import { bottleFeaturedSlotClass } from '@/lib/bottleImageFrame';

import {
  BOTTLE_CROP_STORED_MAX,
  BOTTLE_FRAME_LIMITS,
  DEFAULT_BOTTLE_IMAGE_ADJUSTMENT,
  bottleImageAdjustmentsEqual,
  normalizeBottleImageAdjustment,
  type BottleImageAdjustment,
  type NormalizedBottleImageAdjustment,
} from '@/lib/bottleImageAdjustment';
import { BottleImage } from '@/components/BottleImage';
import { betaVideoUrlForFragrance } from '@/lib/bottleVideoBeta';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import { VaultGridModeToggle } from '@/components/VaultGridModeToggle';
import { ScentNotesInfographic } from '@/components/ScentNotesInfographic';
import { useModalBehavior } from '@/hooks/use-modal-behavior';
import { useRenderBudget } from '@/hooks/useRenderBudget';
import { useVaultGridPreference } from '@/hooks/useVaultGridPreference';
import { crumb, domSnapshot } from '@/lib/crashTrace';
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
        <p className="scent-type-label">
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

// Decorative price-signal shimmer plays a couple of times then settles, matching
// the rest of the app's bounded-loop convention (cf. NotePyramid's
// DECORATIVE_REPEAT_COUNT). An unbounded `repeat: Infinity` here meant every `$`
// on every catalog card ran a perpetual rAF loop — multiplied across the grid
// that is a real per-frame load on the iPad PWA, and it ignored the OS
// reduced-motion preference entirely.
const PRICE_SIGNAL_REPEAT_COUNT = 2;

function PriceValueSignal({
  symbols,
  label,
  tone = "standard",
}: {
  symbols: string;
  label: string;
  tone?: PriceSignalTone;
}) {
  const reduceMotion = useReducedMotion();
  const intensity = symbols.length;
  const baseClass =
    tone === "accent"
      ? "inline-flex font-serif italic text-scent-accent font-bold drop-shadow-[0_0_10px_rgba(212,175,55,0.7)] whitespace-nowrap"
      : "inline-flex font-serif italic text-white/90 whitespace-nowrap";
  const animate = reduceMotion
    ? undefined
    : intensity >= 4
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
          transition={
            reduceMotion
              ? undefined
              : {
                  duration,
                  delay: index * 0.11,
                  repeat: PRICE_SIGNAL_REPEAT_COUNT,
                  repeatType: "mirror",
                  ease: "easeInOut",
                }
          }
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
 * The score and supporting metrics stay compact, so the detail view has one
 * clear hierarchy on every screen size.
 */
function ProfileScorePanel({
  metrics,
  coverage,
  legacyPerformance,
  compactOnly = false,
}: {
  metrics?: DerivedMetrics | null;
  coverage?: SourceCoverage;
  legacyPerformance?: Fragrance["performance"];
  compactOnly?: boolean;
}) {
  const headline = metrics?.headline ?? null;
  const performance = metrics?.performance_score ?? null;
  const value = metrics?.value_score ?? null;
  const consensusScore = scoreNumber(headline?.crowd_consensus_score);
  const wearProfile = formatWearProfile(metrics?.wear_profile);

  if (!metrics || !hasDerivedMetricsContent(metrics)) {
    if (!coverage) return null;

    return (
      <FragrancePanel title="Derived Intelligence">
        <div className="px-4 py-5 text-center">
          <p className="text-sm italic text-white/55 font-serif">
            {coverage.complete === false
              ? "Awaiting Source Data"
              : "Derived fragrance intelligence unavailable."}
          </p>
          {coverage.complete === false ? (
            <p className="mt-1.5 scent-type-label">
              Derived intelligence not available yet
            </p>
          ) : null}
        </div>
      </FragrancePanel>
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
            ? "min-w-0 h-full min-h-[6.15rem] flex flex-col items-center justify-center gap-1 overflow-hidden border border-scent-accent/22 bg-white/[0.035] px-1.5 py-2.5 text-center"
            : "min-w-0 h-full flex flex-col items-center justify-center gap-1 overflow-hidden border border-scent-accent/22 bg-white/[0.035] px-4 py-5 text-center"
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
                <span className={compact ? "pb-0.5 text-[13px] text-scent-text-muted" : "pb-1 text-base text-white/68"}>
                  /100
                </span>
              </div>
              <p
                className={
                  compact
                    ? "min-h-[2.35em] flex items-center justify-center px-0 text-[13px] leading-tight text-scent-accent"
                    : "min-h-[2.5em] flex items-center justify-center px-1 text-[13px] leading-snug text-scent-accent"
                }
              >
                {stat.sub ?? ""}
              </p>
            </>
          ) : (
            <>
              <p
                className={compact ? "text-[13px] text-scent-text-subtle font-serif italic" : "font-serif italic text-2xl text-white/55 leading-tight"}
                aria-hidden
              >
                --
              </p>
              <p
                className={
                  compact
                    ? "min-h-[2.35em] flex items-center justify-center px-0 text-[13px] leading-tight text-scent-text-subtle"
                    : "min-h-[2.5em] flex items-center justify-center px-1 text-[13px] leading-snug text-scent-text-subtle"
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
              ? "mt-auto max-w-full scent-type-chip leading-tight [overflow-wrap:anywhere]"
              : "mt-auto scent-type-chip"
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
        <Icon size={compact ? 14 : 18} strokeWidth={1.75} className="text-scent-accent" />
        {stat.cycle.length > 0 ? (
          <CyclingTilePair
            parts={stat.cycle}
            primaryClass={
              compact
                ? "text-[13px] text-[#fff7ec] font-serif italic truncate max-w-full"
                : "font-serif italic text-2xl text-white leading-tight truncate max-w-full"
            }
            secondaryClass={
              compact
                ? "min-h-[2.35em] flex items-center justify-center px-0 text-[13px] leading-tight text-scent-text-subtle"
                : "min-h-[2.5em] flex items-center justify-center px-1 text-[13px] leading-snug text-scent-text-subtle"
            }
          />
        ) : (
          <>
            {stat.value !== null ? (
              <p
                className={
                  compact
                    ? "text-[13px] text-[#fff7ec] font-serif italic truncate max-w-full"
                    : "font-serif italic text-2xl text-white leading-tight truncate max-w-full"
                }
              >
                {stat.value}
              </p>
            ) : (
              <p
                className={compact ? "text-[13px] text-scent-text-subtle font-serif italic" : "font-serif italic text-2xl text-white/55 leading-tight"}
                aria-hidden
              >
                --
              </p>
            )}
            <p
              className={
                compact
                  ? "min-h-[2.35em] flex items-center justify-center px-0 text-[13px] leading-tight text-scent-text-subtle"
                  : "min-h-[2.5em] flex items-center justify-center px-1 text-[13px] leading-snug text-scent-text-subtle"
              }
            >
              {stat.sub ?? ""}
            </p>
          </>
        )}
        <p
          className={
            compact
              ? "mt-auto max-w-full scent-type-chip leading-tight [overflow-wrap:anywhere]"
              : "mt-auto scent-type-chip"
          }
        >
          {stat.label}
        </p>
      </div>
    );
  };

  const renderTile = (stat: StatCard, scale: "desktop" | "mobile") =>
    stat.kind === "score" ? renderScoreTile(stat, scale) : renderMetricTile(stat, scale);

  if (compactOnly) {
    return (
      <FragrancePanel title="Derived Intelligence">
        <div className="px-4 py-3.5">
          <div className="grid grid-cols-2 gap-1.5">
            {statCards.map((stat) => renderTile(stat, "mobile"))}
          </div>
        </div>
      </FragrancePanel>
    );
  }

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
  return `${entryName(s.item)} — ${entryBrand(s.item)}`;
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

const EMPTY_VAULT_STEPS = [
  {
    icon: Search,
    title: 'Search your first bottle',
    description: 'Use the vault search to find any fragrance you own, wear, or want to compare.',
  },
  {
    icon: Check,
    title: 'Build a three-scent signal',
    description: 'Three saved fragrances give the matcher enough taste context to recommend well.',
  },
  {
    icon: Sparkles,
    title: 'Unlock daily discovery',
    description: 'Your vault becomes the source for practical, weather-aware scent picks.',
  },
] as const;

const VaultEmptyEmblem: React.FC = () => (
  <svg
    viewBox="0 0 112 112"
    role="img"
    aria-label="Empty fragrance vault"
    className="h-28 w-28 text-scent-accent sm:h-32 sm:w-32"
  >
    <defs>
      <linearGradient id="vault-empty-gold" x1="24" y1="9" x2="88" y2="100" gradientUnits="userSpaceOnUse">
        <stop stopColor="#fff2bd" />
        <stop offset="0.46" stopColor="#d4af37" />
        <stop offset="1" stopColor="#8a5a18" />
      </linearGradient>
      <radialGradient id="vault-empty-glow" cx="0" cy="0" r="1" gradientTransform="matrix(0 44 -44 0 56 46)" gradientUnits="userSpaceOnUse">
        <stop stopColor="#fff2bd" stopOpacity="0.2" />
        <stop offset="1" stopColor="#d4af37" stopOpacity="0" />
      </radialGradient>
    </defs>
    <circle cx="56" cy="56" r="48" fill="url(#vault-empty-glow)" />
    <path
      d="M31 47c0-16.7 10.2-29 25-29s25 12.3 25 29"
      fill="none"
      stroke="url(#vault-empty-gold)"
      strokeWidth="3.2"
      strokeLinecap="round"
    />
    <path
      d="M21 44h70c4.4 0 8 3.6 8 8v31c0 5-4 9-9 9H22c-5 0-9-4-9-9V52c0-4.4 3.6-8 8-8Z"
      fill="rgba(212,175,55,0.07)"
      stroke="url(#vault-empty-gold)"
      strokeWidth="2.7"
    />
    <path
      d="M28 58h56M28 78h56"
      fill="none"
      stroke="currentColor"
      strokeOpacity="0.22"
      strokeWidth="2.2"
      strokeLinecap="round"
    />
    <path
      d="M36 75V61c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4v14M52 75V55c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4v20M68 75V62c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4v13"
      fill="rgba(255,247,236,0.045)"
      stroke="currentColor"
      strokeOpacity="0.5"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M56 28v27" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" strokeLinecap="round" />
    <circle cx="81" cy="78" r="8" fill="rgba(0,0,0,0.72)" stroke="currentColor" strokeOpacity="0.62" strokeWidth="2" />
    <path d="M81 73v10M76 78h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const Wardrobe: React.FC<{
  items: Fragrance[];
  onDelete: (item: Fragrance) => void;
  /** Persist the preview image to the vault row (authenticated). */
  onPersistWardrobeImage?: (
    item: Fragrance,
    imageUrl?: string,
    imageAdjustment?: BottleImageAdjustment,
  ) => Promise<Fragrance | null>;
  /** True when the signed-in user is an admin; gates the bottle-image uploader. */
  isAdmin?: boolean;
  /** Admin-only: re-host an uploaded file/URL and return a persistable image URL. */
  onUploadBottleImage?: (input: {
    brand: string;
    name: string;
    fragranceId?: string | null;
    file?: File;
    imageUrl?: string;
    sourcePageUrl?: string;
    removeBackground: boolean;
  }) => Promise<{ imageUrl: string; imageHash?: string; backgroundRemoved: boolean }>;
  featuredItem?: Fragrance | null;
  /** Restore in-memory snapshot after an automatic legacy wardrobe rebuild (this tab only). */
  onRevertWardrobe?: () => void;
  fixWardrobeBusy?: boolean;
  revertAvailable?: boolean;
  wardrobeFixHint?: string | null;
  /** Scroll to / focus an add/search surface (used by Expand Archive). */
  onExpandArchive?: (options?: { target?: 'hero' | 'vault' }) => void;
  authToken?: string | null;
  wardrobeLoaded?: boolean;
  wardrobeError?: string | null;
  onRetryLoadWardrobe?: () => void;
  /** True while a freshly-added imageless tile is actively backfilling its image. */
  isImageSyncing?: (item: Pick<Fragrance, 'id' | '_dbId'>) => boolean;
}> = ({
  items,
  onDelete,
  onPersistWardrobeImage,
  isAdmin = false,
  onUploadBottleImage,
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
  isImageSyncing,
}) => {
  const [selectedItem, setSelectedItem] = React.useState<Fragrance | null>(null);
  const { gridMode, setGridMode, isCompactGrid } = useVaultGridPreference();
  const { lowMotionRenderMode, isIpad } = useRenderBudget();
  const constrainedDetailMode = lowMotionRenderMode;
  // iPad keeps the constrained-mode performance optimizations (deferred render,
  // lighter motion, full-screen modal) but must retain the original three-column
  // detail layout (accords | note pyramid | bottle). Only true mobile/phone
  // surfaces collapse into the stacked, reordered single column.
  const stackedDetailMode = constrainedDetailMode && !isIpad;
  const [detailDeferredContentReady, setDetailDeferredContentReady] = React.useState(false);
  const [detailExitInProgress, setDetailExitInProgress] = React.useState(false);

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

  React.useEffect(() => {
    if (!selectedItem) {
      setDetailDeferredContentReady(false);
      return;
    }

    if (typeof window === 'undefined') {
      setDetailDeferredContentReady(true);
      return;
    }

    setDetailDeferredContentReady(false);
    let firstFrame = 0;
    let secondFrame = 0;
    let readyTimer: number | null = null;
    let idleHandle: number | null = null;
    const readyDelayMs = constrainedDetailMode ? 180 : 80;
    const idleTimeoutMs = constrainedDetailMode ? 700 : 320;

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const markReady = () => {
          crumb(`detail:deferred-ready#${detailOpenCountRef.current}`);
          setDetailDeferredContentReady(true);
        };
        if (typeof window.requestIdleCallback === 'function') {
          idleHandle = window.requestIdleCallback(markReady, { timeout: idleTimeoutMs });
        } else {
          readyTimer = window.setTimeout(markReady, readyDelayMs);
        }
      });
    });

    return () => {
      if (firstFrame) window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      if (idleHandle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle);
      }
      if (readyTimer) window.clearTimeout(readyTimer);
    };
  }, [constrainedDetailMode, selectedItem?.id]);

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
  // `source` distinguishes a raw web-scrape preview (refresh) from a
  // model-generated reimagine packshot. A refresh preview that still carries a
  // fallback background is junk and must not be saved; a reimagine preview is a
  // finished studio packshot and stays savable even when the second background
  // pass fell back (e.g. Poof out of credits), so a good reimagine is never
  // stranded as unsavable.
  const [pendingPreview, setPendingPreview] = React.useState<{ itemId: string; url: string; isFallback: boolean; source?: 'refresh' | 'reimagine' | 'upload' } | null>(null);
  // Admin-only bottle-image uploader (drag/drop + click + paste-URL).
  const [uploadDragActive, setUploadDragActive] = React.useState(false);
  const [uploadUrlInput, setUploadUrlInput] = React.useState('');
  const [sourceUrlInput, setSourceUrlInput] = React.useState('');
  const [uploadRemoveBg, setUploadRemoveBg] = React.useState(false);
  const [uploadBusy, setUploadBusy] = React.useState(false);
  const uploadFileInputRef = React.useRef<HTMLInputElement | null>(null);
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
  const [searchFocused, setSearchFocused] = React.useState(false);
  const [searchHighlightIndex, setSearchHighlightIndex] = React.useState(0);
  const [enlargeOpen, setEnlargeOpen] = React.useState(false);
  const [bottleImageToolsOpen, setBottleImageToolsOpen] = React.useState(false);
  const [deleteConfirming, setDeleteConfirming] = React.useState(false);
  const detailModalRef = React.useRef<HTMLDivElement | null>(null);
  const detailOpenCountRef = React.useRef(0);
  const detailCloseButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const enlargeModalRef = React.useRef<HTMLDivElement | null>(null);
  const enlargeCloseButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [frameDraft, setFrameDraft] = React.useState<NormalizedBottleImageAdjustment>(
    DEFAULT_BOTTLE_IMAGE_ADJUSTMENT,
  );
  const searchBlurTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!bottleImageToolsOpen) return;
    void refreshUsageTotals();
  }, [bottleImageToolsOpen, refreshUsageTotals]);

  const openDetail = React.useCallback((item: Fragrance) => {
    detailOpenCountRef.current += 1;
    crumb(`detail:open#${detailOpenCountRef.current} ${domSnapshot()}`);
    setDetailExitInProgress(false);
    setRefreshError(null);
    setPendingPreview(null);
    setDeleteConfirming(false);
    setFrameDraft(normalizeBottleImageAdjustment(item.imageAdjustment));
    setSelectedItem(item);
  }, []);

  const closeDetail = React.useCallback(() => {
    crumb(`detail:close#${detailOpenCountRef.current} ${domSnapshot()}`);
    // Crash-tracer: settle marker ~1s after close. If the trail shows
    // exit-complete#N but NO post-close#N, the kill is in the async
    // grid-repaint window right after teardown (not a later/cumulative point).
    {
      const n = detailOpenCountRef.current;
      window.setTimeout(() => crumb(`detail:post-close#${n} ${domSnapshot()}`), 1000);
    }
    // iPad/desktop keep the body scroll locked through the brief exit animation
    // so the page behind doesn't jump while the modal fades. Phone-class WebKit
    // (iPhone / Android) must NOT hold a `position: fixed` body while a fresh
    // full-screen portal is torn down: if `onExitComplete` fails to fire the
    // lock is stranded, and across repeat open/close cycles that strands layers
    // the content process can't reclaim — the documented "A problem repeatedly
    // occurred" crash. On phones release the lock immediately instead.
    if (selectedItem && !stackedDetailMode) {
      setDetailExitInProgress(true);
    }
    setRefreshError(null);
    setPendingPreview(null);
    setSelectedItem(null);
    setEnlargeOpen(false);
    setBottleImageToolsOpen(false);
    setDeleteConfirming(false);
    setFrameDraft(DEFAULT_BOTTLE_IMAGE_ADJUSTMENT);
  }, [selectedItem, stackedDetailMode]);

  const closeEnlargedBottle = React.useCallback(() => {
    setEnlargeOpen(false);
  }, []);

  // Safety net for the scroll lock. AnimatePresence's `onExitComplete` can fail
  // to fire on iOS (e.g. a presence child re-keyed by a rapid reopen), which
  // would otherwise leave `detailExitInProgress` — and therefore the body lock
  // in useModalBehavior — stuck on. Force-clear it just past the longest exit
  // so a missed callback can never strand `position: fixed`.
  React.useEffect(() => {
    if (!detailExitInProgress) return;
    const timer = window.setTimeout(() => setDetailExitInProgress(false), 300);
    return () => window.clearTimeout(timer);
  }, [detailExitInProgress]);

  // Crash-tracer: bracket the heavy detail subtree's mount/unmount so a kill
  // mid-cycle leaves a breadcrumb naming the phase. Invisible; temporary.
  React.useEffect(() => {
    if (!selectedItem) return;
    crumb(`detail:mounted#${detailOpenCountRef.current}`);
    return () => crumb(`detail:unmounted#${detailOpenCountRef.current}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem?.id]);

  useModalBehavior({
    isOpen: Boolean(selectedItem) || detailExitInProgress,
    containerRef: detailModalRef,
    initialFocusRef: detailCloseButtonRef,
    onDismiss: closeDetail,
    // Phone (stackedDetailMode): do NOT lock body scroll. The detail modal is a
    // full-screen OPAQUE portal with its own scroll container, so the page
    // behind is never visible and never needs locking. The scroll-lock applies
    // `position: fixed` to <body> on open and removes it on close — and toggling
    // `position: fixed` on a long page forces iOS to re-tile/re-rasterize the
    // entire wardrobe grid every cycle. The crash trail shows the WebContent
    // kill lands right after close, idle on the grid (not in the modal), which
    // is exactly that per-cycle grid re-tile compounding until iOS reclaims the
    // tab. iPad/desktop keep the lock (panel is not full-screen there).
    lockScroll: !stackedDetailMode,
  });

  useModalBehavior({
    isOpen: Boolean(selectedItem && enlargeOpen),
    containerRef: enlargeModalRef,
    initialFocusRef: enlargeCloseButtonRef,
    onDismiss: closeEnlargedBottle,
    lockScroll: false,
  });

  React.useEffect(() => {
    if (!selectedItem?.id) return;
    setFrameDraft(normalizeBottleImageAdjustment(selectedItem.imageAdjustment));
    setClarifySolverId('');
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
      setPendingPreview({ itemId: item.id, url: nextUrl, isFallback, source: 'refresh' });
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
    // Global lock: one reimagine at a time across the whole wardrobe, not just
    // per bottle. The backend runs jobs sequentially to protect itself from
    // OOM, so firing a second concurrent request can never finish faster — it
    // only queues server-side or gets refused with a 429.
    if (reimaginingIds.size > 0) return;
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
            // open this bottle. Nothing is lost. Marked source: 'reimagine' so
            // the manual save is never blocked by the fallback-background gate
            // (a reimagine packshot is authoritative even if the second bg pass
            // fell back).
            setPendingPreview({
              itemId: item.id,
              url: nextUrl,
              isFallback: imageProcessingNeedsRepair(data),
              source: 'reimagine',
            });
          }
        } else {
          // Unauthenticated: keep the preview-then-save flow.
          setPendingPreview({
            itemId: item.id,
            url: nextUrl,
            isFallback: imageProcessingNeedsRepair(data),
            source: 'reimagine',
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
    // Reimagine previews are finished model packshots and stay savable; only a
    // refresh preview that still has a fallback (junk) background is blocked.
    if (pendingPreview.isFallback && pendingPreview.source !== 'reimagine') {
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

  // Admin-only: re-host an uploaded file / pasted URL, then show it as a pending
  // preview so the admin can frame it and Save through the normal vault path.
  const runAdminBottleUpload = async (source: { file?: File; imageUrl?: string; sourcePageUrl?: string }) => {
    if (!selectedItem || !onUploadBottleImage) return;
    if (source.file && !source.file.type.startsWith('image/')) {
      setRefreshError('That file is not an image. Choose a PNG, JPG, or WebP.');
      return;
    }
    setUploadBusy(true);
    setRefreshError(null);
    setBgFallbackWarning(null);
    try {
      const result = await onUploadBottleImage({
        brand: entryBrand(selectedItem),
        name: entryName(selectedItem),
        fragranceId: selectedItem._dbId ?? selectedItem.id,
        file: source.file,
        imageUrl: source.imageUrl,
        sourcePageUrl: source.sourcePageUrl,
        removeBackground: uploadRemoveBg,
      });
      const nextUrl = withImageVersion(result.imageUrl, result.imageHash || Date.now());
      setPendingPreview({ itemId: selectedItem.id, url: nextUrl, isFallback: false, source: 'upload' });
      setUploadUrlInput('');
      setSourceUrlInput('');
    } catch (err: any) {
      setRefreshError(err?.message || 'Image upload failed');
    } finally {
      setUploadBusy(false);
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
    const nm = entryName(s.item);
    const br = entryBrand(s.item);
    setSearchQuery(`${br} ${nm}`.trim());
    setSearchFocused(false);
    setRefreshError(null);
    setPendingPreview(null);
    setFrameDraft(normalizeBottleImageAdjustment((s.item as Fragrance).imageAdjustment));
    setSelectedItem(s.item as Fragrance);
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

  // Global reimagine lock: the backend processes reimagine jobs one at a time
  // to protect itself from OOM, so while ANY bottle is reimagining the button
  // is blocked everywhere — parallel clicks would only queue server-side (or
  // get a 429), never run faster.
  const anyReimagining = reimaginingIds.size > 0;

  const imageToolbarBusy =
    !!selectedItem &&
    (refreshingId === selectedItem.id || selectedReimagining || persistBusy || uploadBusy);

  const hasPendingPreview =
    !!selectedItem && !!pendingPreview && pendingPreview.itemId === selectedItem.id;

  // Only a raw-scrape (refresh) preview with a fallback background blocks
  // saving. A reimagine preview is a finished model packshot and is always
  // savable, so it is never gated by the fallback-background check.
  const previewBlocked =
    !!pendingPreview?.isFallback && pendingPreview.source !== 'reimagine';

  const frameDirty =
    !!selectedItem && !bottleImageAdjustmentsEqual(frameDraft, selectedItem.imageAdjustment);

  const updateFrameDraft = React.useCallback((patch: BottleImageAdjustment) => {
    setFrameDraft((current) => normalizeBottleImageAdjustment({ ...current, ...patch }));
  }, []);

  const selectedMetrics =
    selectedItem?.raw_engine_detail?.derived_metrics ?? selectedItem?.derived_metrics ?? null;
  const selectedCoverage =
    normalizeSourceCoverage(
      selectedItem?.source_coverage ?? selectedItem?.raw_engine_detail?.source_coverage,
      selectedMetrics,
      selectedItem?.enrichment ?? selectedItem?.raw_engine_detail?.enrichment ?? undefined,
    );
  const detailShowDeferredContent = !constrainedDetailMode || detailDeferredContentReady;
  const detailPanelClassName = constrainedDetailMode
    // Constrained surfaces (iPhone/Android) render the panel full-screen and
    // fully opaque, so its drop shadow is entirely behind the panel and never
    // visible — but `shadow-2xl` still makes the compositor allocate a large
    // offscreen surface for the blurred shadow on every open. Drop it here: it
    // is invisible cost on exactly the devices that hit the memory-pressure
    // crash. Desktop keeps the floating panel (h-[94dvh], mx-4) where the
    // shadow is actually seen.
    ? "relative w-full h-full bg-[#030303] overflow-hidden flex flex-col border-0"
    : "relative w-full h-full sm:h-[94dvh] sm:max-w-[100rem] sm:mx-4 bg-[#030303] shadow-2xl overflow-hidden flex flex-col border-0 sm:border border-white/8";
  const detailScrollClassName = constrainedDetailMode
    ? "flex-1 overflow-y-auto scrollbar-hide px-4 sm:px-5 pb-4"
    : "flex-1 overflow-y-auto scrollbar-hide px-4 sm:px-7 lg:px-10 pb-4";
  const detailTitleClassName = constrainedDetailMode
    ? "font-serif italic text-4xl sm:text-5xl leading-[0.95] text-[#fff7ec] tracking-normal uppercase"
    : "font-serif italic text-5xl sm:text-7xl lg:text-8xl leading-[0.92] text-[#fff7ec] tracking-normal uppercase";
  const detailGridClassName = stackedDetailMode
    ? "grid grid-cols-1 items-stretch gap-3 sm:gap-4"
    : "grid grid-cols-1 items-stretch gap-3 sm:gap-4 lg:grid-cols-[1.12fr_1.95fr_1fr]";
  const detailVisualPanelClassName = stackedDetailMode
    ? "min-h-[16rem]"
    : "lg:h-full lg:min-h-[21.25rem]";
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
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 bg-white/[0.04] scent-type-chip text-scent-text-muted hover:bg-white/[0.08] hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Undo2 size={14} strokeWidth={1.75} />
                      Revert
                    </button>
                  </div>
                ) : null}
                {fixWardrobeBusy ? (
                  <p className="text-sm text-scent-gold-100 font-sans text-center leading-snug max-w-xl px-2">
                    Rebuilding wardrobe…
                  </p>
                ) : null}
                {wardrobeFixHint ? (
                  <p className="text-sm text-scent-text-muted font-sans text-center leading-snug max-w-xl px-2">
                    {wardrobeFixHint}
                  </p>
                ) : null}
              </div>
            )}
            <div className="relative w-full max-w-[56rem] z-20">
              <label htmlFor="wardrobe-vault-search" className="sr-only">
                Search vault fragrances and image hints
              </label>
              <Search size={23} strokeWidth={1.75} className="pointer-events-none absolute right-5 top-1/2 z-10 -translate-y-1/2 text-scent-accent sm:right-6" />
              <input
                id="wardrobe-vault-search"
                type="search"
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
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
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelSearchBlur();
                    setSearchFocused(false);
                    e.currentTarget.blur();
                    return;
                  }
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
                  }
                }}
                placeholder="Search vault (e.g. sauvage)..."
                autoComplete="off"
                className="scent-lux-input scent-vault-search-input w-full h-[58px] px-14 text-center text-[#fff7ec] font-sans text-[15px] outline-none transition-all placeholder:text-scent-text-subtle sm:h-[68px] sm:px-16 sm:text-base"
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
                    className="absolute left-0 right-0 top-full mt-2 max-h-[min(320px,50vh)] overflow-y-auto rounded-[var(--radius-scent)] border border-scent-accent/32 bg-neutral-950/98 shadow-[0_24px_48px_rgba(0,0,0,0.78)] scrollbar-hide z-30"
                  >
                    <li className="px-3 py-2 border-b border-white/8 pointer-events-none">
                      <p className="scent-type-label font-sans">
                        Matches
                      </p>
                    </li>
                    {searchSuggestions.map((sug, idx) => {
                      const active = idx === searchHighlightIndex;
                      const primary = suggestionPrimaryLine(sug);
                      const sub = [sug.item.family, ...(sug.item.notes ?? []).slice(0, 2)]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <li key={`fragrance-${sug.item.id}`} role="none">
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`w-full text-left px-3 py-2.5 transition-colors border-b border-white/[0.06] last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-scent-accent/55 ${
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
                              <div className="text-[13px] text-scent-text-muted mt-0.5 font-sans truncate">{sub}</div>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </motion.ul>
                ) : null}
              </AnimatePresence>

            </div>
            <VaultGridModeToggle
              mode={gridMode}
              onChange={setGridMode}
              className="sm:hidden"
            />
            <div className="scent-full-bleed w-full">
              <div
                className="scent-entry-count w-full font-serif italic text-xl sm:text-2xl whitespace-nowrap"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
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
                    <div className="absolute top-10 left-10 scent-type-label text-scent-text-muted z-20 pointer-events-none">Recommended Manifest</div>
                    <div className={bottleFeaturedSlotClass()}>
                      <BottleImage
                        variant="featured"
                        src={featuredItem.imageUrl}
                        alt={entryName(featuredItem)}
                        adjustment={featuredItem.imageAdjustment}
                        isSyncing={isImageSyncing?.(featuredItem)}
                        className="min-h-0 w-full flex-1"
                        imgClassName="scent-hover-scale transition-transform duration-1000 brightness-[1.15]"
                        loading="eager"
                        fetchPriority="high"
                      />
                    </div>
                    <div className="text-center mt-4 mb-2 space-y-3 shrink-0 px-2">
                      <p className="scent-type-label font-sans">{entryBrand(featuredItem)}</p>
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
                  className="scent-primary-button px-8 py-3 rounded-scent font-serif italic text-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
                >
                  Retry Load
                </button>
              )}
            </div>
          ) : !wardrobeLoaded ? (
            <div
              className={`scent-vault-grid grid ${
                isCompactGrid ? 'grid-cols-2 gap-2' : 'grid-cols-1 gap-3'
              } sm:grid-cols-2 sm:gap-4 lg:gap-5 xl:grid-cols-4`}
              data-compact={isCompactGrid ? 'true' : 'false'}
            >
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className={`scent-fragrance-card w-full ${
                    isCompactGrid ? 'min-h-[18rem]' : 'min-h-[32rem]'
                  } sm:min-h-[32rem] relative overflow-hidden flex flex-col`}
                >
                  <div className="scent-card-frame" aria-hidden />
                  <div className={`relative z-[1] flex h-full flex-col items-center ${
                    isCompactGrid ? 'px-3 py-4' : 'px-6 py-7'
                  } sm:px-8 sm:py-9`}>
                    <div className="h-4 w-2/3 bg-white/10 rounded animate-pulse mt-2" />
                    <div className={`relative flex-1 w-full ${
                      isCompactGrid ? 'my-3' : 'my-5'
                    } sm:my-6 min-h-0 flex items-center justify-center`}>
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
                <div
                  className={`scent-vault-grid grid ${
                    isCompactGrid ? 'grid-cols-2 gap-2' : 'grid-cols-1 gap-3'
                  } sm:grid-cols-2 sm:gap-4 lg:gap-5 xl:grid-cols-4 mb-1`}
                  data-compact={isCompactGrid ? 'true' : 'false'}
                >
                  {shelfItems.map((item) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true, margin: '0px 0px 15% 0px' }} transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                      className="group cursor-pointer relative h-full min-w-0"
                      onClick={() => openDetail(item)}
                      onMouseEnter={() => prefetchReviews(item)}
                    >
                      <div className={`scent-fragrance-card scent-hover-lift w-full h-full ${
                        isCompactGrid ? 'min-h-[17.5rem]' : 'min-h-[26rem]'
                      } sm:min-h-[26rem] transition-[transform,border-color,box-shadow] duration-500 motion-reduce:transition-none relative overflow-hidden flex flex-col`}>
                        <div className="scent-card-frame" aria-hidden />
                        <div className={`relative z-[1] flex h-full flex-col items-center ${
                          isCompactGrid ? 'px-3 py-4' : 'px-6 py-5'
                        } sm:px-8 sm:py-6`}>
                          <BrandGoldLabel
                            brand={entryBrand(item)}
                            className="scent-card-brand w-full mt-1 sm:mt-1.5"
                          />
                          <div className={`relative flex-1 w-full ${
                            isCompactGrid ? 'mt-2 mb-2' : 'mt-3 mb-3'
                          } min-h-0 sm:mt-4 sm:mb-4`}>
                            <BottleImage
                              variant="grid"
                              src={item.imageUrl}
                              videoSrc={betaVideoUrlForFragrance(item)}
                              alt={entryName(item)}
                              adjustment={item.imageAdjustment}
                              isSyncing={isImageSyncing?.(item)}
                              className="absolute inset-0 z-10"
                              imgClassName="scent-hover-scale brightness-[1.1] transition-transform duration-[900ms] motion-reduce:transition-none"
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
                      onClick={() => onExpandArchive?.({ target: 'vault' })}
                      aria-label="Add a fragrance to your vault"
                      title="Add a fragrance to your vault"
                      className={`scent-fragrance-card ${
                        isCompactGrid ? 'min-h-[17.5rem] p-4' : 'min-h-[28rem] p-8'
                        } sm:min-h-[28rem] sm:p-8 flex flex-col items-center justify-center text-center group cursor-pointer border-dashed border-scent-accent/26 hover:bg-white/5 transition-all w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50`}
                    >
                      <div className="w-12 h-12 border border-dashed border-scent-accent/35 flex items-center justify-center group-hover:rotate-90 transition-transform mb-4 rounded-full">
                        <span className="text-scent-accent text-3xl">+</span>
                      </div>
                      <p className="font-serif italic text-scent-accent text-2xl tracking-tighter uppercase">Add Fragrance</p>
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : !searchQuery && (
            <div className="relative overflow-hidden rounded-[var(--radius-scent)] border border-scent-accent/26 bg-[linear-gradient(180deg,rgba(255,247,236,0.05),rgba(255,247,236,0.014)_38%,rgba(0,0,0,0.34))] px-5 py-10 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.1),0_30px_78px_-56px_rgba(212,175,55,0.55)] sm:px-8 sm:py-14 lg:px-12">
              <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-scent-accent/50 to-transparent" aria-hidden />
              <div className="pointer-events-none absolute inset-x-10 bottom-0 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent" aria-hidden />
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(212,175,55,0.13),transparent_34%),radial-gradient(circle_at_12%_88%,rgba(255,247,236,0.04),transparent_26%)]" aria-hidden />
              <div className="relative z-[1] mx-auto grid max-w-6xl gap-8 text-left lg:grid-cols-[minmax(0,1.08fr)_minmax(20rem,0.92fr)] lg:items-center">
                <div className="flex min-w-0 flex-col items-center text-center lg:items-start lg:text-left">
                  <div className="mb-5 flex h-32 w-32 items-center justify-center rounded-[calc(var(--radius-scent)+10px)] border border-scent-accent/24 bg-black/38 shadow-[inset_0_1px_0_rgba(255,236,183,0.1),0_24px_54px_-34px_rgba(212,175,55,0.68)] sm:h-36 sm:w-36" aria-hidden>
                    <VaultEmptyEmblem />
                  </div>
                  <p className="scent-type-label text-scent-accent/85">Collection Vault</p>
                  <h3 className="mt-3 max-w-[34rem] font-serif italic text-4xl leading-none text-[#fff7ec] sm:text-5xl">Start with the bottles you actually wear</h3>
                  <p className="mt-4 max-w-[38rem] text-[15px] leading-relaxed text-scent-text-muted sm:text-base">
                    Add three fragrances to turn an empty shelf into a usable taste profile. Once the vault has enough signal, ScentBeam can recommend what fits the day instead of guessing from a blank slate.
                  </p>
                  <div className="mt-6 w-full max-w-[28rem] rounded-[calc(var(--radius-scent)-8px)] border border-scent-accent/16 bg-black/30 p-3 shadow-[inset_0_1px_0_rgba(255,236,183,0.06)]">
                    <div className="mb-2 flex items-center justify-between gap-4">
                      <span className="scent-type-label text-scent-accent/80">Discovery signal</span>
                      <span className="font-mono text-[11px] font-semibold tabular-nums text-scent-accent">0/3</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={0} aria-label="Fragrances added toward discovery">
                      {[0, 1, 2].map((slot) => (
                        <span key={slot} className="h-2 rounded-full bg-white/12" />
                      ))}
                    </div>
                  </div>
                  {onExpandArchive && (
                    <button
                      type="button"
                      onClick={() => onExpandArchive({ target: 'vault' })}
                      className="scent-vault-outline-button mt-6 inline-flex min-h-[54px] items-center gap-2.5 px-7 py-3.5 transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
                    >
                      <Search size={16} strokeWidth={1.75} className="text-scent-accent" aria-hidden />
                      <span className="scent-vault-outline-button-label font-serif italic text-lg">Add your first fragrance</span>
                    </button>
                  )}
                </div>

                <div className="relative rounded-[calc(var(--radius-scent)-4px)] border border-white/10 bg-black/34 p-4 shadow-[inset_0_1px_0_rgba(255,236,183,0.07)] sm:p-5">
                  <div className="mb-5 flex items-center justify-between gap-4">
                    <div>
                      <p className="scent-type-label text-scent-accent/85">How it becomes useful</p>
                      <p className="mt-1 text-sm leading-relaxed text-scent-text-subtle">A simple path from empty vault to daily recommendation.</p>
                    </div>
                    <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-full border border-scent-accent/22 bg-scent-accent/[0.06] text-scent-accent sm:flex" aria-hidden>
                      <Sparkles size={18} strokeWidth={1.75} />
                    </div>
                  </div>
                  <div className="space-y-3">
                    {EMPTY_VAULT_STEPS.map(({ icon: Icon, title, description }, index) => (
                      <div key={title} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3 rounded-[calc(var(--radius-scent)-10px)] border border-white/8 bg-white/[0.025] p-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-scent-accent/24 bg-black/34 text-scent-accent">
                          <Icon size={16} strokeWidth={1.75} aria-hidden />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] font-semibold tabular-nums text-scent-accent/72">0{index + 1}</span>
                            <p className="font-serif italic text-xl leading-tight text-[#fff7ec]">{title}</p>
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-scent-text-muted">{description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {typeof document !== 'undefined' ? createPortal(
      <AnimatePresence onExitComplete={() => { crumb(`detail:exit-complete#${detailOpenCountRef.current}`); setDetailExitInProgress(false); }}>
        {selectedItem && (
          <div
            key="wardrobe-detail-modal"
            ref={detailModalRef}
            className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fragrance-detail-title"
          >
            <motion.div
              initial={constrainedDetailMode ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={constrainedDetailMode ? { opacity: 0 } : { opacity: 0 }}
              transition={{ duration: stackedDetailMode ? 0 : constrainedDetailMode ? 0.08 : 0.2 }}
              onClick={closeDetail}
              className="absolute inset-0 bg-black/95"
            />
            <motion.div
              initial={constrainedDetailMode ? false : { opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={constrainedDetailMode ? { opacity: 0 } : { opacity: 0, scale: 0.99 }}
              transition={{ duration: stackedDetailMode ? 0 : constrainedDetailMode ? 0.08 : 0.24, ease: [0.22, 1, 0.36, 1] }}
              className={detailPanelClassName}
            >
              <div
                className={detailScrollClassName}
                style={
                  {
                    // NOTE: `-webkit-overflow-scrolling: touch` deliberately omitted.
                    // On iOS it forces a dedicated, *content-sized* momentum-scroll
                    // compositing layer (an offscreen IOSurface) for this — the
                    // tallest scroll area in the app — allocated fresh on every
                    // detail-modal open. Across repeat open/close that GPU memory
                    // accumulates and trips the WebContent memory-pressure kill
                    // ("A problem repeatedly occurred"). Momentum scrolling is the
                    // default on iOS 13+, so the property is pure cost with no gain.
                    paddingTop: 'max(1.25rem, env(safe-area-inset-top))',
                  } as React.CSSProperties
                }
              >
                <div className="mx-auto max-w-[92rem] space-y-4 sm:space-y-5 py-5 sm:py-7">
                  <header className="mx-auto max-w-3xl text-center">
                    <div className="space-y-2">
                      <h2
                        id="fragrance-detail-title"
                        className={detailTitleClassName}
                      >
                        {entryName(selectedItem)}
                      </h2>
                      <BrandGoldLabel
                        brand={entryBrand(selectedItem)}
                        className="font-serif text-lg sm:text-2xl uppercase tracking-[0.28em] text-white/84"
                      />
                    </div>
                  </header>

                  <ProfileScorePanel
                    metrics={selectedMetrics}
                    coverage={selectedCoverage}
                    legacyPerformance={selectedItem.performance}
                    compactOnly={stackedDetailMode}
                  />

                  <div className={detailGridClassName}>
                    <div className={`space-y-3 sm:space-y-4 lg:h-full ${stackedDetailMode ? 'order-2' : ''}`}>
                      {detailShowDeferredContent ? (
                        <ScentNotesInfographic
                          derivedMetrics={selectedMetrics}
                          legacyPyramid={selectedItem.pyramid}
                          scentAxesFallback={selectedItem.scent_vector ?? null}
                          variant="accords"
                          className={detailVisualPanelClassName}
                        />
                      ) : null}
                    </div>

                    <div className={`space-y-3 sm:space-y-4 lg:h-full ${stackedDetailMode ? 'order-3' : ''}`}>
                      {detailShowDeferredContent ? (
                        <ScentNotesInfographic
                          derivedMetrics={selectedMetrics}
                          legacyPyramid={selectedItem.pyramid}
                          variant="notes"
                          className={detailVisualPanelClassName}
                        />
                      ) : null}
                    </div>

                    <div className={`space-y-3 sm:space-y-4 lg:h-full ${stackedDetailMode ? 'order-1' : ''}`}>
                      <FragrancePanel
                        title="About This Fragrance"
                        className={detailVisualPanelClassName}
                        titleSuffix={
                          <button
                            type="button"
                            onClick={() => setBottleImageToolsOpen((o) => !o)}
                            className={`p-1.5 rounded-md border border-white/10 bg-white/[0.04] text-scent-text-muted hover:text-white hover:bg-white/[0.08] transition-all flex items-center justify-center ${
                              bottleImageToolsOpen ? 'text-scent-accent border-scent-accent/30 bg-scent-accent/5' : ''
                            }`}
                            title="Adjust bottle image and settings"
                            aria-label="Toggle bottle image controls"
                            aria-expanded={bottleImageToolsOpen}
                          >
                            <HelpCircle size={13} strokeWidth={1.75} />
                          </button>
                        }
                      >
                        <div className="flex flex-col p-4 space-y-3">
                          <div 
                            className={`relative h-56 ${stackedDetailMode ? 'sm:h-60' : 'sm:h-72 lg:h-64'} min-h-0 w-full shrink-0 overflow-hidden cursor-pointer rounded-lg border border-white/5 bg-white/[0.01]`}
                            onClick={() => detailBottleUrl && setEnlargeOpen(true)}
                          >
                            <BottleImage
                              key={detailBottleUrl || 'missing-image'}
                              variant="detail"
                              src={detailBottleUrl}
                              alt={entryName(selectedItem)}
                              adjustment={frameDraft}
                              showFrameGuide={bottleImageToolsOpen}
                              isSyncing={isImageSyncing?.(selectedItem)}
                              className="absolute inset-0"
                              imgClassName={constrainedDetailMode ? "" : "transition-all duration-300"}
                            />
                          </div>

                          {detailBottleUrl && !bottleImageToolsOpen ? (
                            <div className="flex w-full shrink-0 justify-center">
                              <button
                                type="button"
                                onClick={() => setEnlargeOpen(true)}
                                className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.04] px-3.5 py-1.5 scent-type-chip text-scent-text-muted transition-colors hover:border-scent-accent/35 hover:bg-scent-accent/[0.08] hover:text-scent-accent"
                                aria-label="Enlarge bottle image"
                              >
                                <Maximize2 size={13} strokeWidth={1.75} />
                                Enlarge
                              </button>
                            </div>
                          ) : null}

                          {!bottleImageToolsOpen && detailMetaRows.length > 0 ? (
                            <div className="border-t border-white/[0.06] pt-3">
                              <div className="grid grid-cols-2 gap-px">
                                {detailMetaRows.map(({ label, value }) => (
                                  <div key={label} className="flex flex-col items-center gap-1 py-2 text-center">
                                    <p className="scent-type-label">{label}</p>
                                    <p className="text-sm font-medium leading-snug text-scent-text-muted">{value}</p>
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
                              <p className="text-center text-sm text-scent-text-muted leading-snug font-sans">
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
                                  className="w-full bg-black/45 border border-white/12 text-white text-sm py-2 px-2 rounded-lg font-sans outline-none focus:border-scent-accent/50 disabled:opacity-40"
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
                                    className="flex-1 min-h-[38px] py-2 bg-white text-black scent-type-chip hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed rounded-lg"
                                  >
                                    {refreshingId === selectedItem.id ? (
                                      <>
                                        <RefreshCw size={11} strokeWidth={1.75} className="animate-spin" /> Searching…
                                      </>
                                    ) : (
                                      <>
                                        <RefreshCw size={11} strokeWidth={1.75} /> Find image
                                      </>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleReimagine(selectedItem)}
                                    disabled={
                                      imageToolbarBusy || anyReimagining || !detailBottleUrl?.trim()
                                    }
                                    title={
                                      !detailBottleUrl?.trim()
                                        ? 'Need an image first'
                                        : anyReimagining && !selectedReimagining
                                          ? 'Another bottle is being reimagined — wait for it to finish'
                                          : 'Reimagine this bottle on a transparent background (1–3 min)'
                                    }
                                    className="flex-1 min-h-[38px] py-2 bg-white/[0.06] text-white scent-type-chip border border-white/15 hover:bg-white/[0.1] active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-35 disabled:cursor-not-allowed rounded-lg"
                                  >
                                    {selectedReimagining ? (
                                      <>
                                        <RefreshCw size={11} strokeWidth={1.75} className="animate-spin" /> Reimagining…
                                      </>
                                    ) : (
                                      <>
                                        <Sparkles size={11} strokeWidth={1.75} /> Reimagine
                                      </>
                                    )}
                                  </button>
                                </div>

                                {isAdmin && onUploadBottleImage ? (
                                  <div className="rounded-lg border border-scent-accent/20 bg-scent-accent/[0.04] p-2.5 space-y-2.5">
                                    <p className="scent-type-label text-scent-accent">
                                      Admin · Replace image
                                    </p>

                                    <input
                                      ref={uploadFileInputRef}
                                      type="file"
                                      accept="image/png,image/jpeg,image/webp"
                                      className="hidden"
                                      onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        e.target.value = '';
                                        if (file) void runAdminBottleUpload({ file });
                                      }}
                                    />

                                    <button
                                      type="button"
                                      onClick={() => uploadFileInputRef.current?.click()}
                                      onDragOver={(e) => {
                                        e.preventDefault();
                                        if (!uploadDragActive) setUploadDragActive(true);
                                      }}
                                      onDragLeave={() => setUploadDragActive(false)}
                                      onDrop={(e) => {
                                        e.preventDefault();
                                        setUploadDragActive(false);
                                        const file = e.dataTransfer.files?.[0];
                                        if (file) void runAdminBottleUpload({ file });
                                      }}
                                      disabled={imageToolbarBusy}
                                      className={`w-full min-h-[64px] rounded-lg border border-dashed flex flex-col items-center justify-center gap-1 px-3 py-3 text-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                        uploadDragActive
                                          ? 'border-scent-accent/70 bg-scent-accent/[0.1]'
                                          : 'border-white/18 bg-black/25 hover:border-scent-accent/45 hover:bg-white/[0.04]'
                                      }`}
                                    >
                                      {uploadBusy ? (
                                        <RefreshCw size={14} className="animate-spin text-scent-accent" />
                                      ) : (
                                        <Upload size={14} className="text-white/55" />
                                      )}
                                      <span className="scent-type-chip font-sans">
                                        {uploadBusy ? 'Uploading…' : 'Drop image or click to upload'}
                                      </span>
                                    </button>

                                    <div className="flex gap-1.5">
                                      <div className="relative flex-1">
                                        <Link2
                                          size={11}
                                          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-scent-text-subtle"
                                        />
                                        <input
                                          type="url"
                                          inputMode="url"
                                          placeholder="…or paste image URL"
                                          value={uploadUrlInput}
                                          onChange={(e) => setUploadUrlInput(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' && uploadUrlInput.trim() && !imageToolbarBusy) {
                                              e.preventDefault();
                                              void runAdminBottleUpload({ imageUrl: uploadUrlInput.trim() });
                                            }
                                          }}
                                          disabled={imageToolbarBusy}
                                          aria-label="Image URL to upload"
                                          className="w-full bg-black/45 border border-white/12 text-white text-sm py-2 pl-7 pr-2 rounded-lg font-sans outline-none focus:border-scent-accent/50 disabled:opacity-40"
                                        />
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (uploadUrlInput.trim()) {
                                            void runAdminBottleUpload({ imageUrl: uploadUrlInput.trim() });
                                          }
                                        }}
                                        disabled={imageToolbarBusy || !uploadUrlInput.trim()}
                                        className="shrink-0 min-h-[36px] px-3 rounded-lg bg-white/[0.06] text-white scent-type-chip border border-white/15 hover:bg-white/[0.1] disabled:opacity-35 disabled:cursor-not-allowed"
                                      >
                                        Add
                                      </button>
                                    </div>

                                    <div className="flex gap-1.5">
                                      <div className="relative flex-1">
                                        <Link2
                                          size={11}
                                          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-scent-text-subtle"
                                        />
                                        <input
                                          type="url"
                                          inputMode="url"
                                          placeholder="…or paste FG/Parfumo URL"
                                          value={sourceUrlInput}
                                          onChange={(e) => setSourceUrlInput(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' && sourceUrlInput.trim() && !imageToolbarBusy) {
                                              e.preventDefault();
                                              void runAdminBottleUpload({ sourcePageUrl: sourceUrlInput.trim() });
                                            }
                                          }}
                                          disabled={imageToolbarBusy}
                                          aria-label="Source page URL to extract image from"
                                          className="w-full bg-black/45 border border-white/12 text-white text-sm py-2 pl-7 pr-2 rounded-lg font-sans outline-none focus:border-scent-accent/50 disabled:opacity-40"
                                        />
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (sourceUrlInput.trim()) {
                                            void runAdminBottleUpload({ sourcePageUrl: sourceUrlInput.trim() });
                                          }
                                        }}
                                        disabled={imageToolbarBusy || !sourceUrlInput.trim()}
                                        className="shrink-0 min-h-[36px] px-3 rounded-lg bg-white/[0.06] text-white scent-type-chip border border-white/15 hover:bg-white/[0.1] disabled:opacity-35 disabled:cursor-not-allowed"
                                      >
                                        Fetch
                                      </button>
                                    </div>

                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                      <input
                                        type="checkbox"
                                        checked={uploadRemoveBg}
                                        onChange={(e) => setUploadRemoveBg(e.target.checked)}
                                        disabled={imageToolbarBusy}
                                        className="h-3.5 w-3.5 accent-scent-accent disabled:opacity-40"
                                      />
                                      <span className="scent-type-chip font-sans">
                                        Remove background
                                      </span>
                                    </label>
                                  </div>
                                ) : null}

                                {/* Action-adjacent status: an error or fallback warning is
                                    shown right under the buttons the user just tapped, so a
                                    failed reimagine/refresh never collapses silently and reads
                                    as a phantom modal reset. The pinned-footer copy below stays
                                    as the fallback for when this tools panel is closed (e.g. a
                                    background reimagine that fails after the user navigates away). */}
                                {!selectedReimagining && refreshError ? (
                                  <div
                                    role="alert"
                                    className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/[0.08] px-3 py-2.5"
                                  >
                                    <AlertCircle size={13} className="mt-px shrink-0 text-red-300/90" />
                                    <p className="text-sm leading-snug text-red-100 font-sans">
                                      {refreshError}
                                    </p>
                                  </div>
                                ) : null}

                                {!selectedReimagining && !refreshError && bgFallbackWarning ? (
                                  <div
                                    role="status"
                                    className="flex items-start gap-2 rounded-lg border border-yellow-400/25 bg-yellow-500/[0.07] px-3 py-2.5"
                                  >
                                    <AlertCircle size={13} className="mt-px shrink-0 text-yellow-300/80" />
                                    <p className="text-sm leading-snug text-yellow-100 font-sans">
                                      {bgFallbackWarning}
                                    </p>
                                  </div>
                                ) : null}

                                {selectedReimagining ? (
                                  <div className="rounded-lg border border-white/15 bg-white/[0.04] px-2.5 py-2.5 text-center space-y-1">
                                    <p className="scent-type-label">
                                      Reimagining your bottle
                                    </p>
                                    <p className="text-sm leading-snug text-scent-text-muted font-sans">
                                      This usually takes 1–3 minutes. You can close this panel and
                                      keep browsing — the new bottle will save to your vault
                                      automatically when it&apos;s ready.
                                    </p>
                                  </div>
                                ) : null}

                                {usageTotals ? (
                                  <p className="text-center scent-type-label font-sans">
                                    Reimagine spend so far ·{' '}
                                    <span className="tabular-nums text-white/55">
                                      ${usageTotals.totalUsd.toFixed(3)}
                                    </span>{' '}
                                    across {usageTotals.count} call{usageTotals.count === 1 ? '' : 's'}
                                  </p>
                                ) : null}

                                <div className="rounded-lg border border-white/10 bg-black/22 p-2.5 space-y-2.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="scent-type-label">
                                      Frame
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => setFrameDraft(DEFAULT_BOTTLE_IMAGE_ADJUSTMENT)}
                                      disabled={imageToolbarBusy}
                                      title="Reset frame"
                                      aria-label="Reset bottle frame"
                                      className="p-1 rounded-md border border-white/10 bg-white/[0.04] text-scent-text-muted hover:text-white hover:bg-white/[0.08] disabled:opacity-30"
                                    >
                                      <RotateCcw size={11} strokeWidth={1.75} />
                                    </button>
                                  </div>

                                  <div className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-1.5">
                                    <label className="flex items-center gap-1 scent-type-label">
                                      <ZoomIn size={10} strokeWidth={1.75} /> Size
                                    </label>
                                    <input
                                      type="range"
                                      min={BOTTLE_FRAME_LIMITS.scale.min}
                                      max={BOTTLE_FRAME_LIMITS.scale.max}
                                      step="0.01"
                                      value={frameDraft.scale}
                                      onChange={(e) => updateFrameDraft({ scale: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Bottle image size"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[13px] tabular-nums text-scent-text-muted">
                                      {framePercent(frameDraft.scale)}
                                    </span>

                                    <label className="flex items-center gap-1 scent-type-label">
                                      <MoveHorizontal size={10} strokeWidth={1.75} /> X
                                    </label>
                                    <input
                                      type="range"
                                      min={BOTTLE_FRAME_LIMITS.x.min}
                                      max={BOTTLE_FRAME_LIMITS.x.max}
                                      step="0.5"
                                      value={frameDraft.x}
                                      onChange={(e) => updateFrameDraft({ x: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Bottle horizontal position"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[13px] tabular-nums text-scent-text-muted">
                                      {Math.round(frameDraft.x)}
                                    </span>

                                    <label className="flex items-center gap-1 scent-type-label">
                                      <MoveVertical size={10} strokeWidth={1.75} /> Y
                                    </label>
                                    <input
                                      type="range"
                                      min={BOTTLE_FRAME_LIMITS.y.min}
                                      max={BOTTLE_FRAME_LIMITS.y.max}
                                      step="0.5"
                                      value={frameDraft.y}
                                      onChange={(e) => updateFrameDraft({ y: Number(e.target.value) })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      aria-label="Bottle vertical position"
                                      className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
                                    />
                                    <span className="text-right text-[13px] tabular-nums text-scent-text-muted">
                                      {Math.round(frameDraft.y)}
                                    </span>

                                    <label className="flex items-center gap-1 scent-type-label">
                                      <ArrowUp size={10} strokeWidth={1.75} /> Top
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
                                    <span className="text-right text-[13px] tabular-nums text-scent-text-muted">
                                      {Math.round(frameDraft.cropTop)}
                                    </span>

                                    <label className="flex items-center gap-1 scent-type-label">
                                      <ArrowRight size={10} strokeWidth={1.75} /> Right
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
                                    <span className="text-right text-[13px] tabular-nums text-scent-text-muted">
                                      {Math.round(frameDraft.cropRight)}
                                    </span>

                                    <label className="flex items-center gap-1 scent-type-label">
                                      <ArrowDown size={10} strokeWidth={1.75} /> Bottom
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
                                    <span className="text-right text-[13px] tabular-nums text-scent-text-muted">
                                      {Math.round(frameDraft.cropBottom)}
                                    </span>

                                    <label className="flex items-center gap-1 scent-type-label">
                                      <ArrowLeft size={10} strokeWidth={1.75} /> Left
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
                                    <span className="text-right text-[13px] tabular-nums text-scent-text-muted">
                                      {Math.round(frameDraft.cropLeft)}
                                    </span>
                                  </div>

                                  <div className="grid grid-cols-2 gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => updateFrameDraft({ scale: frameDraft.scale - 0.1 })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      className="min-h-[30px] rounded-md border border-white/10 bg-white/[0.035] scent-type-chip text-scent-text-muted flex items-center justify-center gap-1.5 disabled:opacity-30 hover:bg-white/[0.06] hover:text-white"
                                    >
                                      <ZoomOut size={10} strokeWidth={1.75} /> 10%
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => updateFrameDraft({ scale: frameDraft.scale + 0.1 })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      className="min-h-[30px] rounded-md border border-white/10 bg-white/[0.035] scent-type-chip text-scent-text-muted flex items-center justify-center gap-1.5 disabled:opacity-30 hover:bg-white/[0.06] hover:text-white"
                                    >
                                      <ZoomIn size={10} strokeWidth={1.75} /> 10%
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => updateFrameDraft({ x: 0, y: 0 })}
                                      disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                                      className="min-h-[30px] rounded-md border border-white/10 bg-white/[0.035] scent-type-chip text-scent-text-muted flex items-center justify-center gap-1.5 disabled:opacity-30 hover:bg-white/[0.06] hover:text-white"
                                    >
                                      <MoveHorizontal size={10} strokeWidth={1.75} /> Center
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
                                      className="min-h-[30px] rounded-md border border-white/10 bg-white/[0.035] scent-type-chip text-scent-text-muted flex items-center justify-center gap-1.5 disabled:opacity-30 hover:bg-white/[0.06] hover:text-white"
                                    >
                                      <Crop size={10} strokeWidth={1.75} /> Tight
                                    </button>
                                  </div>

                                  {frameDirty && !hasPendingPreview ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleSaveImageFrame()}
                                      disabled={imageToolbarBusy || !onPersistWardrobeImage}
                                      className="w-full min-h-[36px] rounded-lg bg-scent-accent text-black scent-type-chip hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                      {persistBusy ? (
                                        <>
                                          <RefreshCw size={11} strokeWidth={1.75} className="animate-spin" /> Saving...
                                        </>
                                      ) : (
                                        <>
                                          <Save size={11} strokeWidth={1.75} /> Save framing
                                        </>
                                      )}
                                    </button>
                                  ) : null}
                                </div>

                                {hasPendingPreview && (
                                  <div className="flex flex-col gap-2 pt-2 border-t border-white/8">
                                    {!onPersistWardrobeImage ? (
                                      <p className="text-sm text-scent-gold-200 text-center font-sans leading-snug px-1">
                                        Sign in to save this preview to your vault.
                                      </p>
                                    ) : null}
                                    {previewBlocked ? (
                                      <p className="text-sm text-scent-gold-200 text-center font-sans leading-snug px-1">
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
                                          previewBlocked
                                        }
                                        title={
                                          !onPersistWardrobeImage
                                            ? 'Sign in to save to your vault'
                                            : previewBlocked
                                              ? 'This preview used a fallback background — try another fix first'
                                              : undefined
                                        }
                                        className="flex-1 min-h-[38px] py-2 bg-scent-accent text-black scent-type-chip hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg"
                                      >
                                        {persistBusy ? (
                                          <>
                                            <RefreshCw size={11} strokeWidth={1.75} className="animate-spin" /> Saving…
                                          </>
                                        ) : (
                                          <>
                                            <Check size={11} strokeWidth={1.75} /> Save to vault
                                          </>
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setPendingPreview(null)}
                                        disabled={persistBusy}
                                        className="flex-1 min-h-[38px] py-2 bg-transparent text-white/50 scent-type-chip border border-white/12 hover:bg-white/[0.05] hover:text-white/80 rounded-lg disabled:opacity-30"
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

                  {detailShowDeferredContent ? (
                    <ReviewsPanel
                      name={entryName(selectedItem)}
                      brand={entryBrand(selectedItem)}
                      reviews={extractDetailReviews(selectedItem.raw_engine_detail)}
                    />
                  ) : null}

                </div>
              </div>

              {/* Pinned footer — bottle tools + delete */}
              <div
                className="px-5 pt-3 shrink-0 border-t border-white/5 flex flex-col gap-3"
                style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
              >
                {/* Footer fallback only — when the bottle tools panel is open the
                    same message is shown inline beside the action buttons above, so
                    avoid rendering it twice. This keeps errors reachable for actions
                    that complete after the panel is closed (e.g. a background reimagine). */}
                {!bottleImageToolsOpen && refreshError && (
                  <p className="text-sm text-red-100 text-center leading-snug px-2 py-1">{refreshError}</p>
                )}
                {!bottleImageToolsOpen && !refreshError && bgFallbackWarning && (
                  <p className="text-sm text-yellow-100 text-center leading-snug px-2 py-1">{bgFallbackWarning}</p>
                )}



                <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
                  <button
                    ref={detailCloseButtonRef}
                    type="button"
                    onClick={() => {
                      if (deleteConfirming) {
                        setDeleteConfirming(false);
                        return;
                      }
                      closeDetail();
                    }}
                    className="min-h-[46px] border-r border-white/10 px-3 py-3 scent-type-chip text-scent-text-muted transition-colors hover:bg-white/[0.05] hover:text-white"
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
                    className={`group flex min-h-[46px] items-center justify-center gap-2 px-3 py-3 scent-type-chip transition-all disabled:cursor-not-allowed disabled:opacity-25 ${
                      deleteConfirming
                        ? 'bg-red-500/12 text-red-300 hover:bg-red-500/18 hover:text-red-200'
                        : 'text-scent-text-muted hover:bg-red-500/[0.06] hover:text-red-300'
                    }`}
                  >
                    <Trash2 size={14} strokeWidth={1.75} className={deleteConfirming ? '' : 'group-hover:animate-bounce'} />
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
                  ref={enlargeModalRef}
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
                    ref={enlargeCloseButtonRef}
                    type="button"
                    onClick={() => setEnlargeOpen(false)}
                    className="absolute top-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white hover:bg-white/20 transition-colors"
                    aria-label="Close enlarged view"
                  >
                    <X size={22} strokeWidth={1.75} />
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
                  <p className="mt-5 scent-type-label font-sans">
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
