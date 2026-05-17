import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  CalendarDays,
  CircleDollarSign,
  Info,
  Maximize2,
  ShoppingBag,
  ThumbsUp,
  Wind,
  X,
} from 'lucide-react';
import { LavaBackground } from './LavaBackground';
import { BottleImage } from '@/components/BottleImage';
import type { BottleImageAdjustment } from '@/lib/bottleImageAdjustment';
import { APP_BRAND_MARK } from '@/lib/appBrand';
import { ScentNotesInfographic } from '@/components/ScentNotesInfographic';
import {
  collectMainAccordDisplayRows,
  isDerivedMetricsCompleteFlag,
  normalizeSourceCoverage,
  type DerivedMetrics,
  type FragranceDetail,
  type SourceCoverage,
} from '@/lib/fragranceApi';

interface ScentVector {
  freshness: number;
  sweetness: number;
  woodiness: number;
  spice: number;
  warmth: number;
  musk: number;
}

interface Fragrance {
  id: string;
  _dbId?: string;
  name: string;
  brand: string;
  product?: { name?: string; brand?: string; perfumer?: string };
  house?: string;
  year?: number | null;
  gender?: string | null;
  imageUrl: string;
  imageAdjustment?: BottleImageAdjustment | null;
  season?: string;
  notes?: string[];
  concentration?: string;
  scent_vector?: ScentVector;
  family?: string;
  performance?: { sillage: number; longevity: number };
  pyramid?: { top: string[]; heart: string[]; base: string[] };
  source_coverage?: SourceCoverage;
  derived_metrics?: DerivedMetrics | null;
  enrichment?: FragranceDetail["enrichment"];
  raw_engine_detail?: FragranceDetail | null;
}

interface ShareData {
  fragrances: Fragrance[];
  hideImages: boolean;
}

interface BuyLink {
  buyUrl: string | null;
  provider: string;
  status: string;
}

function entryName(item: Fragrance): string {
  return item.name || item.product?.name || "";
}

function entryBrand(item: Fragrance): string {
  return item.brand || item.product?.brand || "";
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

function formatYear(value: unknown): string | null {
  return isFiniteNumber(value) ? String(Math.round(value)) : null;
}

function joinDisplayParts(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return cleaned.length > 0 ? cleaned.join(" · ") : null;
}

function formatNoteList(values?: string[]): string | null {
  const cleaned = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return cleaned.length > 0 ? cleaned.join(", ") : null;
}

function formatWearProfile(wear?: DerivedMetrics["wear_profile"] | null): string | null {
  if (!wear) return null;
  const seasons = wear.primary_seasons?.filter(Boolean) ?? [];
  const seasonOrder = ["Winter", "Spring", "Summer", "Autumn", "Autumn/Fall", "Fall"];
  const rank = (season: string) => {
    const index = seasonOrder.indexOf(season);
    return index === -1 ? seasonOrder.length : index;
  };
  const seasonLabel = [...seasons].sort((a, b) => rank(a) - rank(b)).join("/");
  const time = wear.primary_time?.trim() || null;
  if (seasonLabel && time) return `${seasonLabel} · ${time}`;
  return seasonLabel || time;
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
  if (notes && notes.length > 0) return notes.join(" · ");
  const pyramidNotes = [
    ...(item.pyramid?.top ?? []),
    ...(item.pyramid?.heart ?? []),
    ...(item.pyramid?.base ?? []),
  ].filter(Boolean);
  if (pyramidNotes.length > 0) return pyramidNotes.slice(0, 8).join(" · ");

  const accordLabels = collectMainAccordDisplayRows(dm?.main_accords)
    .slice(0, 6)
    .map((row) => row.label);
  if (accordLabels.length > 0) return accordLabels.join(" · ");

  return "Notes unavailable for this fragrance.";
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
      collectMainAccordDisplayRows(metrics.main_accords).length > 0 ||
      hasDerivedMetricNotes(metrics),
  );
}

function brandLengthBucket(brand: string): "short" | "medium" | "long" | "xlong" {
  const len = brand.trim().length;
  if (len <= 10) return "short";
  if (len <= 16) return "medium";
  if (len <= 24) return "long";
  return "xlong";
}

function FragrancePanel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-white/10 bg-white/[0.025] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] ${className}`}>
      <div className="border-b border-white/[0.07] px-4 py-3 text-center">
        <p className="text-[10px] uppercase tracking-[0.34em] text-white/70 font-bold">
          {title}
        </p>
      </div>
      {children}
    </section>
  );
}

const ENRICHMENT_STATUS_COPY: Record<string, string> = {
  not_needed: "Full fragrance intelligence available.",
  pending: "Enhanced metrics queued.",
  processing: "Enhanced metrics are being prepared.",
  completed: "Enhanced metrics available.",
  failed: "Enhanced metrics unavailable right now.",
  ignored: "Enhancement not scheduled for this fragrance.",
};

function enrichmentCopy(enrichment?: FragranceDetail["enrichment"]): string | null {
  const message = enrichment?.message?.trim();
  if (message) return message;
  const status = enrichment?.status?.trim().toLowerCase();
  return status ? ENRICHMENT_STATUS_COPY[status] ?? null : null;
}

function SourceStatusPanel({
  coverage,
  enrichment,
}: {
  coverage?: SourceCoverage;
  enrichment?: FragranceDetail["enrichment"];
}) {
  const hasCoverage = Boolean(coverage && Object.keys(coverage).length > 0);
  const enrichmentMessage = enrichmentCopy(enrichment);

  if (!hasCoverage && !enrichmentMessage) return null;

  const complete =
    coverage?.complete === true || isDerivedMetricsCompleteFlag(coverage?.derived_metrics);
  const coverageSummary = complete
    ? "Full fragrance intelligence available."
    : "Baseline profile available. Enhanced metrics pending.";
  const fragranticaStatus =
    coverage?.fragrantica === true
      ? coverage.fragrantica_cached
        ? "Fragrantica cached"
        : "Fragrantica available"
      : coverage?.fragrantica === false
        ? coverage.fragrantica_linked
          ? "Fragrantica metrics pending"
          : "Fragrantica unavailable"
        : null;
  const derivedStatus =
    typeof coverage?.derived_metrics === 'string' && coverage.derived_metrics.trim()
      ? `Metrics ${coverage.derived_metrics}`
      : null;
  const badges = [
    coverage?.basenotes === true
      ? "Basenotes available"
      : coverage?.basenotes === false
        ? "Basenotes unavailable"
        : null,
    fragranticaStatus,
    derivedStatus,
  ].filter((badge): badge is string => Boolean(badge));

  return (
    <FragrancePanel title="Source Status" className="overflow-hidden">
      <div className="space-y-3 px-4 py-4">
        <div className="flex items-center justify-center gap-3">
          {hasCoverage ? (
            <span className={`shrink-0 text-[8px] uppercase tracking-[0.24em] font-bold px-2.5 py-1 border ${
              complete
                ? 'border-scent-accent/45 text-scent-accent bg-scent-accent/10'
                : 'border-white/12 text-white/50 bg-white/[0.04]'
            }`}>
              {complete ? "Complete" : "Partial"}
            </span>
          ) : null}
          <p className="text-center text-sm italic text-white/62 font-serif leading-relaxed">
            {hasCoverage ? coverageSummary : enrichmentMessage}
          </p>
        </div>
        {hasCoverage && enrichmentMessage && enrichmentMessage !== coverageSummary ? (
          <p className="text-center text-[10px] uppercase tracking-[0.18em] text-white/38 font-bold leading-relaxed">
            {enrichmentMessage}
          </p>
        ) : null}
        {badges.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-2">
            {badges.map((badge) => (
              <span
                key={badge}
                className="border border-white/10 bg-black/22 px-2.5 py-1 text-[8px] uppercase tracking-[0.16em] text-white/45 font-bold"
              >
                {badge}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </FragrancePanel>
  );
}

function DetailMetaStrip({ rows }: { rows: Array<{ label: string; value: string }> }) {
  if (rows.length === 0) return null;

  return (
    <div className="w-full max-w-4xl border border-white/[0.08] bg-black/22 px-3 py-2 sm:px-4 sm:py-2.5">
      <div className="flex min-w-0 flex-col divide-y divide-white/[0.08] sm:flex-row sm:divide-x sm:divide-y-0">
        {rows.map(({ label, value }) => (
          <div
            key={label}
            className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 py-3 text-center sm:min-h-[3.125rem] sm:px-2.5"
          >
            <p className="text-[8px] font-semibold uppercase tracking-[0.2em] text-white/40">{label}</p>
            <p
              className="max-w-full text-balance break-words text-[11px] font-medium leading-snug text-white/[0.82] sm:text-[12px]"
              title={value}
            >
              {value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function performanceMetricPercent(
  performance: DerivedMetrics["performance_score"] | null | undefined,
  metric: "sillage" | "longevity",
): number | null {
  if (!performance) return null;

  const keys =
    metric === "sillage"
      ? ["sillage_percent", "sillage_pct", "sillage_score", "sillage_score_raw"]
      : ["longevity_percent", "longevity_pct", "longevity_score", "longevity_score_raw"];
  const record = performance as Record<string, unknown>;

  for (const key of keys) {
    const percent = percentFromMetricValue(record[key]);
    if (percent !== null) return percent;
  }

  return null;
}

function performanceSignalLine({
  label,
  metric,
  percent,
}: {
  label: string | null;
  metric: "sillage" | "longevity";
  percent: number | null;
}): string | null {
  if (percent === null && !label) return null;
  const cleanLabel = label?.trim().toLowerCase() ?? null;
  if (percent !== null && cleanLabel) return `${percent}% ${cleanLabel} ${metric}`;
  if (percent !== null) return `${percent}% ${metric}`;
  return cleanLabel ? `${cleanLabel} ${metric}` : null;
}

function PerformanceStatSubtitle({
  performance,
  legacyPerformance,
}: {
  performance?: DerivedMetrics["performance_score"] | null;
  legacyPerformance?: Fragrance["performance"];
}) {
  const longevity = performance?.longevity_label?.trim() || null;
  const sillage = performance?.sillage_label?.trim() || null;
  const overallPerformancePercent = scoreNumber(performance?.score);
  const longevityLine = performanceSignalLine({
    label: longevity,
    metric: "longevity",
    percent:
      performanceMetricPercent(performance, "longevity") ??
      percentFromTenPoint(legacyPerformance?.longevity) ??
      overallPerformancePercent,
  });
  const sillageLine = performanceSignalLine({
    label: sillage,
    metric: "sillage",
    percent:
      performanceMetricPercent(performance, "sillage") ??
      percentFromTenPoint(legacyPerformance?.sillage) ??
      overallPerformancePercent,
  });
  const both = Boolean(longevityLine && sillageLine);
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!both) return;
    const id = window.setInterval(() => setPhase((p) => (p + 1) % 2), 4500);
    return () => window.clearInterval(id);
  }, [both]);
  const text =
    longevityLine && sillageLine
      ? phase === 0
        ? sillageLine
        : longevityLine
      : joinDisplayParts([longevityLine, sillageLine]) ?? "Signal";

  return (
    <p className="text-[10px] text-white/42 min-h-[2.5em] flex items-center justify-center px-1 leading-snug">
      <motion.span
        key={text}
        initial={{ opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="block leading-snug"
      >
        {text}
      </motion.span>
    </p>
  );
}

function ProfileScorePanel({
  metrics,
  coverage,
  legacyPerformance,
}: {
  metrics?: DerivedMetrics | null;
  coverage?: SourceCoverage;
  legacyPerformance?: Fragrance["performance"];
}) {
  const headline = metrics?.headline ?? null;
  const performance = metrics?.performance_score ?? null;
  const value = metrics?.value_score ?? null;
  const consensusScore = scoreNumber(headline?.crowd_consensus_score);
  const communityScore = scoreNumber(metrics?.community_interest_score?.score);
  const wearProfile = formatWearProfile(metrics?.wear_profile);

  if (!metrics || !hasDerivedMetricsContent(metrics)) {
    if (!coverage) return null;
    return (
      <FragrancePanel title="Derived Intelligence">
        <div className="px-4 py-5 text-center">
          <p className="text-sm italic text-white/45 font-serif">
            {coverage.complete === false
              ? "Enhanced metrics pending."
              : "Derived fragrance intelligence unavailable."}
          </p>
        </div>
      </FragrancePanel>
    );
  }

  const statCards = [
    {
      icon: CalendarDays,
      label: "Wear Profile",
      value: wearProfile ?? "Universal",
      sub: "Season / time",
    },
    {
      icon: Activity,
      label: "Performance",
      value: null,
    },
    {
      icon: ThumbsUp,
      label: "Community",
      value: communityScore !== null ? `${communityScore}/100` : "Pending",
      sub: "Interest",
    },
    {
      icon: CircleDollarSign,
      label: "Value",
      value: value?.dominant_label ?? "Pending",
      sub: "Assessment",
    },
  ];

  return (
    <div className="space-y-3 sm:space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-[1.15fr_repeat(4,1fr)] border-y border-white/8">
        <div className="col-span-2 lg:col-span-1 flex flex-col items-center justify-center px-4 py-5 border-b lg:border-b-0 lg:border-r border-white/8 text-center">
          <p className="text-[10px] uppercase tracking-[0.28em] text-white/64 font-bold">Profile Score</p>
          <div className="mt-1 flex items-end justify-center gap-2">
            <span className="font-serif italic text-6xl leading-none text-scent-accent">
              {consensusScore ?? "--"}
            </span>
            <span className="pb-2 text-xl text-white/76">/100</span>
          </div>
          <p className="mt-1 text-sm text-scent-accent/90">{headline?.label ?? "Intelligence profile"}</p>
        </div>
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="flex flex-col items-center justify-center gap-1 border-r border-b lg:border-b-0 border-white/8 px-4 py-5 text-center last:border-r-0"
            >
              <Icon size={18} strokeWidth={1.6} className="text-scent-accent" />
              {stat.value !== null ? (
                <p className="font-serif italic text-2xl text-white leading-tight">{stat.value}</p>
              ) : (
                <div className="min-h-[1.75rem] sm:min-h-8 shrink-0" aria-hidden />
              )}
              {stat.label === "Performance" ? (
                <PerformanceStatSubtitle
                  performance={performance}
                  legacyPerformance={legacyPerformance}
                />
              ) : (
                <p className="min-h-[2.5em] flex items-center justify-center px-1 text-[10px] leading-snug text-white/42">
                  {stat.sub}
                </p>
              )}
              <p className="text-[9px] uppercase tracking-[0.2em] text-white/40 font-bold">{stat.label}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const SharePage: React.FC<{ userId: string }> = ({ userId }) => {
  const [data, setData] = useState<ShareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [enlargeOpen, setEnlargeOpen] = useState(false);
  const [buyLinks, setBuyLinks] = useState<Record<string, BuyLink>>({});

  const selectedItem = useMemo(() => {
    if (!data || !selectedItemId) return null;
    return data.fragrances.find((item) => (item._dbId ?? item.id) === selectedItemId) ?? null;
  }, [data, selectedItemId]);

  const selectedMetrics = selectedItem?.derived_metrics ?? selectedItem?.raw_engine_detail?.derived_metrics ?? null;
  const selectedCoverage = normalizeSourceCoverage(
    selectedItem?.source_coverage ?? selectedItem?.raw_engine_detail?.source_coverage,
    selectedMetrics,
    selectedItem?.enrichment ?? selectedItem?.raw_engine_detail?.enrichment ?? undefined,
  );
  const selectedEnrichment =
    selectedItem?.enrichment ?? selectedItem?.raw_engine_detail?.enrichment ?? undefined;
  const selectedBuyLink = selectedItem ? buyLinks[selectedItem._dbId ?? selectedItem.id] : undefined;
  const selectedBuyUrl = selectedBuyLink?.status === 'active' ? selectedBuyLink.buyUrl : null;
  const selectedDetailMetaRows = selectedItem
    ? [
        { label: 'Year', value: formatYear(selectedItem.year) },
        { label: 'Gender', value: stringValue(selectedItem.gender) },
        { label: 'Concentration', value: stringValue(selectedItem.concentration) },
        { label: 'Environment', value: stringValue(selectedItem.season) },
      ].filter((row): row is { label: string; value: string } => Boolean(row.value))
    : [];

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setSelectedItemId(null);
    setEnlargeOpen(false);
    setBuyLinks({});
    fetch(`/api/share/${userId}`)
      .then(async (r) => {
        return r.json();
      })
      .then(d => {
        if (d.error) throw new Error(d.error);
        setData(d);

        const fragranceIds = Array.isArray(d.fragrances)
          ? d.fragrances.map((item: Fragrance) => item._dbId ?? item.id).filter(Boolean)
          : [];

        if (fragranceIds.length) {
          Promise.all(
            fragranceIds.map(async (fragranceId: string) => {
              try {
                const response = await fetch(`/api/fragrances/${encodeURIComponent(fragranceId)}/buy-link`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const buyLink = await response.json();
                return [fragranceId, buyLink] as const;
              } catch {
                return [fragranceId, { provider: 'cj', buyUrl: null, status: 'unavailable' }] as const;
              }
            })
          ).then(entries => {
            setBuyLinks(Object.fromEntries(entries));
          }).catch(() => {});
        } else {
          setBuyLinks({});
        }
      })
      .catch(e => {
        setError(e.message || 'Failed to load vault');
      })
      .finally(() => setLoading(false));
  }, [userId]);

  return (
    <div className="min-h-[100svh] bg-black text-white relative overflow-x-hidden">
      <LavaBackground />

      <nav className="fixed top-0 left-0 right-0 h-16 sm:h-[72px] border-b border-white/5 bg-black/40 backdrop-blur-2xl z-50 px-4 sm:px-8">
        <div className="max-w-[1400px] mx-auto h-full flex items-center justify-center">
          <a
            href="/"
            aria-label="Back to dashboard"
            className="flex items-center gap-2 text-white hover:opacity-85 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-white/30 rounded-sm"
          >
            <Wind size={22} strokeWidth={1.25} className="text-scent-accent shrink-0" aria-hidden />
            <span className="font-serif text-xl sm:text-2xl tracking-[0.14em] uppercase">{APP_BRAND_MARK}</span>
          </a>
        </div>
      </nav>

      <div className="pt-16 sm:pt-[72px]" />

      <main className="relative z-10 px-4 sm:px-8 max-w-[1760px] mx-auto py-16 sm:py-20">
        {loading && (
          <div className="flex items-center justify-center py-40">
            <p className="font-serif italic text-white/30 text-3xl animate-pulse">Loading vault...</p>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center py-40">
            <p className="font-serif italic text-red-400/60 text-2xl">{error}</p>
          </div>
        )}

        {data && (
          <div className="space-y-14 sm:space-y-16">
            <div className="text-center space-y-7 sm:space-y-8">
              <div className="space-y-3">
                <p className="text-[10px] uppercase tracking-[0.6em] text-white/40 font-bold">Shared Vault</p>
                <h2 className="font-serif italic text-[clamp(2.65rem,8vw,5.35rem)] text-[#fff7ec] tracking-normal leading-none">Vault of Aromas</h2>
              </div>
              <div className="scent-full-bleed w-full">
                <div className="scent-entry-count w-full font-serif italic text-xl sm:text-2xl whitespace-nowrap">
                  <span>{data.fragrances.length} Entries</span>
                </div>
              </div>
              {data.hideImages ? (
                <p className="text-[10px] uppercase tracking-[0.3em] text-amber-200/65 font-bold">
                  Owner currently hides bottle images on public view
                </p>
              ) : null}
            </div>

            {data.fragrances.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 lg:gap-5 pb-24">
              {data.fragrances.map((item, i) => {
                const fragranceId = item._dbId ?? item.id;
                const name = entryName(item);
                const brand = entryBrand(item);

                return (
                  <motion.div
                    key={fragranceId}
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="group cursor-pointer relative h-full min-w-0"
                    onClick={() => setSelectedItemId(fragranceId)}
                  >
                    <div className="scent-fragrance-card w-full h-full min-h-[32rem] transition-[transform,border-color,box-shadow] duration-500 motion-reduce:transition-none group-hover:-translate-y-1.5 motion-reduce:group-hover:translate-y-0 relative overflow-hidden flex flex-col">
                      <div className="scent-card-frame" aria-hidden />
                      <div className="relative z-[1] flex h-full flex-col items-center px-6 sm:px-8 pt-7 sm:pt-9 pb-6 sm:pb-7">
                        <p
                          className="scent-card-brand w-full"
                          data-len={brandLengthBucket(brand)}
                          title={brand}
                        >
                          {brand}
                        </p>
                        <div className="relative flex-1 w-full mt-4 sm:mt-5 mb-5 sm:mb-6 min-h-0">
                          {!data.hideImages ? (
                          <BottleImage
                            variant="grid"
                            src={item.imageUrl}
                            alt={name}
                            adjustment={item.imageAdjustment}
                            className="absolute inset-0 z-10"
                            imgClassName="brightness-[1.1] group-hover:scale-[1.035] motion-reduce:group-hover:scale-100 transition-transform duration-[900ms] motion-reduce:transition-none"
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
                            <div>
                              <p className="text-[9px] uppercase tracking-[0.5em] text-white/20 font-bold">{brand}</p>
                              <p className="font-serif italic text-2xl text-white leading-tight">{name}</p>
                            </div>
                          </div>
                        )}
                        </div>
                        <div className="scent-card-title-row shrink-0">
                          <h3 className="scent-card-title" title={name}>{name}</h3>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
            ) : (
              <div className="py-40 text-center border border-dashed border-white/5 rounded-scent">
                <p className="font-serif italic text-4xl text-white/10">The vault is currently vacant</p>
              </div>
            )}

            <div className="text-center pt-16 border-t border-white/5">
              <p className="text-[9px] uppercase tracking-[0.4em] text-white/20 font-bold mb-3">Powered by</p>
              <div className="flex items-center justify-center gap-2 text-white/30">
                <Wind size={16} strokeWidth={1} />
                <span className="font-serif italic text-lg tracking-tighter uppercase">{APP_BRAND_MARK}</span>
              </div>
            </div>
          </div>
        )}
      </main>

      <AnimatePresence>
        {selectedItem ? (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-fragrance-detail-title"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setSelectedItemId(null);
                setEnlargeOpen(false);
              }}
              className="absolute inset-0 bg-black/95 backdrop-blur-3xl"
            />
            <motion.div
              initial={{ opacity: 0, y: 18, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.99 }}
              transition={{ duration: 0.24 }}
              className="relative w-full h-full sm:h-[94dvh] sm:max-w-[100rem] sm:mx-4 bg-[#030303] shadow-2xl overflow-hidden flex flex-col border-0 sm:border border-white/8"
            >
              <div
                className="flex items-center justify-between px-5 sm:px-8 pb-3 shrink-0 border-b border-white/[0.06] bg-black/35"
                style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelectedItemId(null);
                    setEnlargeOpen(false);
                  }}
                  className="text-[10px] uppercase tracking-[0.22em] text-white/58 hover:text-white transition-colors"
                >
                  Close
                </button>
                <div className="flex items-center gap-3 text-white/92">
                  <div className="h-3 w-5 border-y border-scent-accent relative before:absolute before:left-1 before:right-1 before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-scent-accent" />
                  <p className="font-serif text-sm sm:text-xl uppercase tracking-[0.42em]">Scentbeam</p>
                </div>
                <button
                  onClick={() => {
                    setSelectedItemId(null);
                    setEnlargeOpen(false);
                  }}
                  aria-label="Close profile"
                  className="shrink-0 p-2 bg-white/5 hover:bg-white/10 transition-all rounded-full border border-white/10 text-white group"
                >
                  <X size={18} className="group-hover:rotate-90 transition-transform duration-300" />
                </button>
              </div>

              <div
                className="flex-1 overflow-y-auto scrollbar-hide px-4 sm:px-7 lg:px-10 pb-4"
                style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
              >
                <div className="mx-auto max-w-[92rem] space-y-4 sm:space-y-5 py-5 sm:py-7">
                  <header className="mx-auto max-w-3xl grid text-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-10">
                    <p className="text-[10px] uppercase tracking-[0.36em] text-scent-accent font-bold order-1 sm:order-2 sm:col-start-2 sm:row-start-1 sm:self-center sm:text-right sm:max-w-[14rem] sm:pl-2">
                      Intelligence Profile
                    </p>
                    <div className="order-2 sm:order-1 sm:col-start-1 sm:row-start-1 space-y-2">
                      <h2
                        id="share-fragrance-detail-title"
                        className="font-serif italic text-5xl sm:text-7xl lg:text-8xl leading-[0.92] text-[#fff7ec] tracking-normal uppercase"
                      >
                        {entryName(selectedItem)}
                      </h2>
                      <p className="font-serif text-lg sm:text-2xl uppercase tracking-[0.28em] text-white/84">
                        {entryBrand(selectedItem)}
                      </p>
                    </div>
                  </header>

                  <ProfileScorePanel
                    metrics={selectedMetrics}
                    coverage={selectedCoverage}
                    legacyPerformance={selectedItem.performance}
                  />

                  <div className="grid grid-cols-1 lg:grid-cols-[1.12fr_1.95fr_1fr] gap-3 sm:gap-4">
                    <div className="space-y-3 sm:space-y-4">
                      <ScentNotesInfographic
                        derivedMetrics={selectedMetrics}
                        legacyPyramid={selectedItem.pyramid}
                        variant="accords"
                      />
                    </div>

                    <div className="space-y-3 sm:space-y-4">
                      <ScentNotesInfographic
                        derivedMetrics={selectedMetrics}
                        legacyPyramid={selectedItem.pyramid}
                        variant="notes"
                      />
                    </div>

                    <div className="space-y-3 sm:space-y-4">
                      <FragrancePanel title="Bottle Visual">
                        <div className="p-4">
                          <div className="mb-3 flex justify-end">
                            {!data?.hideImages && selectedItem.imageUrl ? (
                              <button
                                type="button"
                                onClick={() => setEnlargeOpen(true)}
                                className="inline-flex items-center gap-1.5 border border-white/12 bg-white/[0.05] px-2.5 py-1 text-[9px] uppercase tracking-[0.18em] font-bold text-white/62 hover:bg-white/[0.1] hover:text-white transition-colors"
                                aria-label="Enlarge bottle image"
                              >
                                <Maximize2 size={13} strokeWidth={2} />
                                Enlarge
                              </button>
                            ) : null}
                          </div>
                          <div className="relative h-56 sm:h-72 lg:h-64 overflow-hidden">
                            {!data?.hideImages ? (
                              <BottleImage
                                key={selectedItem.imageUrl || 'missing-image'}
                                variant="detail"
                                src={selectedItem.imageUrl}
                                alt={entryName(selectedItem)}
                                adjustment={selectedItem.imageAdjustment}
                                className="absolute inset-0"
                                imgClassName="transition-all duration-300"
                                loading="eager"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center border border-dashed border-white/10 bg-white/[0.025] px-5 text-center">
                                <p className="font-serif italic text-2xl leading-tight text-white/72">
                                  Bottle image hidden by owner.
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      </FragrancePanel>
                    </div>
                  </div>

                  <FragrancePanel title="About This Fragrance">
                    <div className="flex flex-col items-center justify-center gap-3 px-4 py-4 text-center">
                      <Info size={18} className="shrink-0 text-white/55" />
                      <p className="mx-auto max-w-3xl text-sm leading-relaxed text-white/56">
                        {selectedMetrics?.main_accords?.accord_summary?.trim() ??
                          entryNotes(selectedItem)}
                      </p>
                      <DetailMetaStrip rows={selectedDetailMetaRows} />
                    </div>
                  </FragrancePanel>

                </div>
              </div>

              <div
                className="px-5 pt-3 shrink-0 border-t border-white/5"
                style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
              >
                {selectedBuyUrl ? (
                  <a
                    href={selectedBuyUrl}
                    target="_blank"
                    rel="nofollow sponsored noopener"
                    className="flex items-center justify-center gap-2 w-full py-3.5 bg-scent-accent text-black uppercase tracking-[0.28em] text-[10px] font-bold hover:opacity-90 transition-opacity active:scale-[0.98]"
                  >
                    <ShoppingBag size={13} />
                    Buy Now
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="flex items-center justify-center gap-2 w-full py-3.5 bg-white/[0.02] border border-white/8 text-[10px] uppercase tracking-[0.22em] text-white/28 font-bold cursor-not-allowed"
                  >
                    <ShoppingBag size={13} />
                    Buying options unavailable
                  </button>
                )}
                <p className="mt-2 text-center text-[9px] leading-relaxed text-white/25 font-sans">
                  {APP_BRAND_MARK} may earn a commission from purchases made through this link.
                </p>
              </div>
            </motion.div>

            <AnimatePresence>
              {enlargeOpen && selectedItem.imageUrl && !data?.hideImages ? (
                <motion.div
                  key="share-bottle-enlarge"
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
                      variant="grid"
                      src={selectedItem.imageUrl}
                      alt={entryName(selectedItem)}
                      adjustment={selectedItem.imageAdjustment}
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
        ) : null}
      </AnimatePresence>
    </div>
  );
};
