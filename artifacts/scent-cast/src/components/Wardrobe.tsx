import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Trash2,
  ShieldCheck,
  Wind,
  RefreshCw,
  Undo2,
  HelpCircle,
  Eraser,
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
import { bottleFeaturedSlotClass } from '@/lib/bottleImageFrame';
import {
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
  isDerivedMetricsCompleteFlag,
  normalizeSourceCoverage,
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

function hasLegacyPyramidNotes(item: Fragrance): boolean {
  return Boolean(
    item.pyramid?.top?.some(Boolean) ||
      item.pyramid?.heart?.some(Boolean) ||
      item.pyramid?.base?.some(Boolean),
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
    <div className="space-y-3 border border-white/10 bg-white/[0.025] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[9px] uppercase tracking-[0.35em] text-white/35 font-bold">
          Source Status
        </p>
        {hasCoverage ? (
          <span className={`shrink-0 text-[8px] uppercase tracking-[0.22em] font-bold px-2 py-1 border ${
            complete
              ? 'border-scent-accent/40 text-scent-accent/85 bg-scent-accent/10'
              : 'border-white/12 text-white/45 bg-white/[0.04]'
          }`}>
            {complete ? "Complete" : "Partial"}
          </span>
        ) : null}
      </div>
      <p className="text-sm italic text-white/62 font-serif leading-relaxed">
        {hasCoverage ? coverageSummary : enrichmentMessage}
      </p>
      {hasCoverage && enrichmentMessage && enrichmentMessage !== coverageSummary ? (
        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35 font-bold">
          {enrichmentMessage}
        </p>
      ) : null}
      {badges.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {badges.map((badge) => (
            <span
              key={badge}
              className="border border-white/10 bg-black/20 px-2 py-1 text-[8px] uppercase tracking-[0.16em] text-white/38 font-bold"
            >
              {badge}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DerivedMetricsPanel({
  metrics,
  coverage,
}: {
  metrics?: DerivedMetrics | null;
  coverage?: SourceCoverage;
}) {
  const headline = metrics?.headline ?? null;
  const performance = metrics?.performance_score ?? null;
  const value = metrics?.value_score ?? null;
  const mainAccords = metrics?.main_accords ?? null;
  const notes = metrics?.notes ?? null;
  const accordItems = collectMainAccordDisplayRows(mainAccords).slice(0, 8);
  const rows = [
    {
      label: "Crowd Consensus",
      value: joinDisplayParts([
        formatScore100(headline?.crowd_consensus_score),
        headline?.label,
      ]),
    },
    {
      label: "Performance",
      value: joinDisplayParts([
        formatScore100(performance?.score),
        performance?.longevity_label ? `${performance.longevity_label} longevity` : null,
        performance?.sillage_label ? `${performance.sillage_label} sillage` : null,
      ]),
    },
    {
      label: "Value",
      value: joinDisplayParts([
        value?.dominant_label,
        formatScore100(value?.score),
      ]),
    },
    {
      label: "Wear",
      value: formatWearProfile(metrics?.wear_profile),
    },
    {
      label: "Community",
      value: formatScore100(metrics?.community_interest_score?.score),
    },
    {
      label: "Main Profile",
      value: mainAccords?.accord_summary?.trim() || null,
    },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));
  const noteGroups = [
    { label: "Top", value: formatNoteList(notes?.top) },
    { label: "Heart", value: formatNoteList(notes?.heart) },
    { label: "Base", value: formatNoteList(notes?.base) },
    { label: "Notes", value: formatNoteList(notes?.flat) },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));
  const summary = headline?.summary?.trim() || null;
  const hasContent =
    rows.length > 0 || noteGroups.length > 0 || accordItems.length > 0 || Boolean(summary);

  if (!metrics || !hasContent) {
    if (!coverage) return null;

    return (
      <div className="border-y border-white/5 py-5">
        <p className="text-[9px] uppercase tracking-[0.35em] text-scent-accent font-bold mb-2">
          Derived Intelligence
        </p>
        <p className="text-sm italic text-white/45 font-serif">
          {coverage.complete === false
            ? "Enhanced metrics pending."
            : "Derived fragrance intelligence unavailable."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 border-y border-white/5 py-5">
      <div className="flex items-center gap-3">
        <ShieldCheck size={14} className="text-scent-accent/70 shrink-0" />
        <p className="text-[10px] uppercase tracking-[0.4em] text-scent-accent/85 font-bold">
          Derived Intelligence
        </p>
        <div className="flex-1 h-px bg-white/5" />
      </div>

      {summary ? (
        <p className="font-serif italic text-lg sm:text-2xl leading-snug text-white/82">
          {summary}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {rows.map((row) => (
            <div key={row.label} className="border-l border-scent-accent/25 pl-3">
              <p className="text-[9px] uppercase tracking-widest text-white/25 font-bold mb-1">
                {row.label}
              </p>
              <p className="font-serif italic text-lg sm:text-2xl text-white">
                {row.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {accordItems.length > 0 ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {accordItems.map((accord) => {
            const label = accord.label?.trim() ?? "";
            const value = formatPercent(accord.pct) ?? formatScore100(accord.score);
            return (
              <span
                key={`${label}-${value ?? "accord"}`}
                className="border border-scent-accent/20 bg-scent-accent/[0.06] px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-white/65 font-bold"
              >
                {value ? `${label} ${value}` : label}
              </span>
            );
          })}
        </div>
      ) : null}

      {noteGroups.length > 0 ? (
        <div className="space-y-3 pt-1">
          {noteGroups.map((group) => (
            <div key={group.label} className="flex gap-4 items-start">
              <p className="w-12 text-[9px] uppercase tracking-[0.25em] text-scent-accent font-bold pt-1 shrink-0">
                {group.label}
              </p>
              <p className="text-sm sm:text-base italic text-white/72 font-serif leading-relaxed">
                {group.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?.trim()
  .replace(/\/+$/, "");
const REFRESH_IMAGE_ENDPOINT = API_BASE_URL
  ? `${API_BASE_URL}/api/refresh-image`
  : "/api/refresh-image";

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
}> = ({
  items,
  onDelete,
  onPersistWardrobeImage,
  featuredItem,
  onRevertWardrobe,
  fixWardrobeBusy,
  revertAvailable,
  wardrobeFixHint,
}) => {
  const [selectedItem, setSelectedItem] = React.useState<Fragrance | null>(null);
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
  const [stripBgBusy, setStripBgBusy] = React.useState(false);
  const [persistBusy, setPersistBusy] = React.useState(false);
  const [vaultSolverBanner, setVaultSolverBanner] = React.useState<string | null>(null);
  const [searchFocused, setSearchFocused] = React.useState(false);
  const [searchHighlightIndex, setSearchHighlightIndex] = React.useState(0);
  const [enlargeOpen, setEnlargeOpen] = React.useState(false);
  const [bottleImageToolsOpen, setBottleImageToolsOpen] = React.useState(false);
  const [frameDraft, setFrameDraft] = React.useState<NormalizedBottleImageAdjustment>(
    DEFAULT_BOTTLE_IMAGE_ADJUSTMENT,
  );
  const solverPrefillRef = React.useRef<WardrobeImageSolverId | null>(null);
  const searchBlurTimerRef = React.useRef<number | null>(null);

  const openDetail = React.useCallback((item: Fragrance) => {
    setRefreshError(null);
    setPendingPreview(null);
    setFrameDraft(normalizeBottleImageAdjustment(item.imageAdjustment));
    setSelectedItem(item);
  }, []);

  const closeDetail = React.useCallback(() => {
    setRefreshError(null);
    setPendingPreview(null);
    setSelectedItem(null);
    setEnlargeOpen(false);
    setBottleImageToolsOpen(false);
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
    const prev = refreshCounts[item.id] ?? 0;
    if (!solverId && prev > 2) {
      setRefreshError('Too many automatic tries. Choose what looks wrong, then search with a fix.');
      return;
    }
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

  const handleStripBackground = async (item: Fragrance) => {
    const src =
      pendingPreview?.itemId === item.id ? pendingPreview.url : item.imageUrl;
    if (!src?.trim()) {
      setRefreshError('No image to process.');
      return;
    }
    setStripBgBusy(true);
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
          stripBgOnly: true,
          imageUrl: src,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Background removal failed');
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
      setRefreshError(err.message || 'Background removal failed');
    } finally {
      setStripBgBusy(false);
    }
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

  const imageToolbarBusy =
    !!selectedItem &&
    (refreshingId === selectedItem.id || stripBgBusy || persistBusy);

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
  const selectedEnrichment =
    selectedItem?.enrichment ?? selectedItem?.raw_engine_detail?.enrichment ?? undefined;

  const selectedHasDerivedMetrics = hasDerivedMetricsContent(selectedMetrics);
  const selectedHasDerivedNotes = hasDerivedMetricNotes(selectedMetrics);
  const selectedHasDerivedPerformance = Boolean(selectedMetrics?.performance_score);
  const detailMetaRows = selectedItem
    ? [
        { label: 'Year', value: formatYear(selectedItem.year) },
        { label: 'Gender', value: stringValue(selectedItem.gender) },
        { label: 'Concentration', value: stringValue(selectedItem.concentration) },
        { label: 'Environment', value: stringValue(selectedItem.season) },
        ...(!selectedHasDerivedPerformance
          ? [
              {
                label: 'Projection',
                value: formatLegacyTenPointScore(selectedItem.performance?.sillage),
              },
              {
                label: 'Chronos',
                value: formatLegacyTenPointScore(selectedItem.performance?.longevity),
              },
            ]
          : []),
      ].filter((row): row is { label: string; value: string } => Boolean(row.value))
    : [];

  React.useEffect(() => {
    setBottleImageToolsOpen(false);
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
                  <p className="text-[11px] text-amber-100/70 font-sans text-center leading-snug max-w-xl px-2">
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
          {shelves.length > 0 ? shelves.map((shelfItems, shelfIndex) => (
            <div key={shelfIndex} className="relative group/shelf">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 lg:gap-6 mb-1">
                {shelfItems.map((item, i) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }} transition={{ delay: i * 0.08, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                    className="group cursor-pointer relative h-full"
                    onClick={() => openDetail(item)}
                  >
                    <div className="scent-fragrance-card h-full min-h-[31rem] transition-[transform,border-color,box-shadow] duration-500 motion-reduce:transition-none group-hover:-translate-y-1.5 motion-reduce:group-hover:translate-y-0 relative overflow-hidden p-5 sm:p-7 flex flex-col">
                      <div className="aspect-[1.04/1] relative mb-6 sm:mb-7 shrink-0 overflow-hidden rounded-[calc(var(--radius-scent)-6px)] ring-1 ring-white/[0.05] shadow-[inset_0_1px_0_rgba(255,244,219,0.04)]">
                        <div className="scent-bottle-stage absolute inset-0 pointer-events-none" />
                        <BottleImage
                          variant="grid"
                          src={item.imageUrl}
                          alt={entryName(item)}
                          adjustment={item.imageAdjustment}
                          className="absolute inset-0 z-10"
                          imgClassName="brightness-[1.08] group-hover:scale-[1.04] motion-reduce:group-hover:scale-100 transition-transform duration-[900ms] motion-reduce:transition-none"
                        />
                      </div>
                      <div className="flex flex-1 flex-col items-center justify-start text-center gap-4 px-1 pb-1 min-h-0 min-w-0">
                        <p className="scent-card-brand">{entryBrand(item)}</p>
                        <h3 className="scent-card-title break-words">{entryName(item)}</h3>
                        <span className="scent-card-notes-rule" aria-hidden />
                        <p className="scent-card-notes" lang="en">{entryNotesCardLine(item)}</p>
                      </div>
                    </div>
                  </motion.div>
                ))}
                {shelfIndex === shelves.length - 1 && shelfItems.length < 4 && (
                  <div className="scent-fragrance-card min-h-[28rem] flex flex-col items-center justify-center p-8 text-center group cursor-pointer border-dashed border-scent-accent/26 hover:bg-white/5 transition-all">
                    <div className="w-12 h-12 border border-dashed border-scent-accent/35 flex items-center justify-center group-hover:rotate-90 transition-transform mb-4 rounded-full">
                      <span className="text-scent-accent/55 text-3xl">+</span>
                    </div>
                    <p className="font-serif italic text-scent-accent/45 text-2xl tracking-tighter uppercase">Expand Archive</p>
                  </div>
                )}
              </div>
            </div>
          )) : !searchQuery && (
            <div className="py-40 text-center border border-dashed border-white/5 rounded-scent">
              <p className="font-serif italic text-4xl text-white/10">The vault is currently vacant</p>
            </div>
          )}
        </div>
      </div>

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
              className="relative w-full h-full sm:h-auto sm:max-h-[88dvh] sm:max-w-4xl sm:mx-6 bg-neutral-900 shadow-2xl sm:rounded-[2rem] overflow-hidden flex flex-col border-0 sm:border border-white/5"
            >
              {/* Pinned header — always visible */}
              <div
                className="flex items-center justify-between px-5 pb-3 shrink-0 border-b border-white/5"
                style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-scent-accent animate-pulse shrink-0" />
                  <p className="text-[9px] uppercase tracking-[0.4em] text-scent-accent font-bold truncate">Intelligence Profile</p>
                </div>
                <button 
                  onClick={closeDetail} 
                  aria-label="Close profile"
                  className="ml-3 shrink-0 p-2 bg-white/5 hover:bg-white/10 transition-all rounded-full border border-white/10 text-white group"
                >
                  <X size={18} className="group-hover:rotate-90 transition-transform duration-300" />
                </button>
              </div>

              {/* Fragrance name — pinned, always readable */}
              <div className="px-5 pt-4 pb-3 shrink-0">
                <h2 id="fragrance-detail-title" className="font-serif italic text-3xl sm:text-6xl leading-tight text-white tracking-tighter uppercase">{entryName(selectedItem)}</h2>
                <p className="text-base text-white/40 font-serif italic mt-1">{entryBrand(selectedItem)}</p>
              </div>

              {/* Scrollable detail body */}
              <div
                className="flex-1 overflow-y-auto scrollbar-hide px-5 pb-4"
                style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
              >
                <div className="space-y-6 sm:space-y-10 pt-2">
                  <SourceStatusPanel
                    coverage={selectedCoverage}
                    enrichment={selectedEnrichment}
                  />
                  <DerivedMetricsPanel
                    metrics={selectedMetrics}
                    coverage={selectedCoverage}
                  />

                  <ScentNotesInfographic
                    derivedMetrics={selectedMetrics}
                    legacyPyramid={selectedItem.pyramid}
                  />

                  <div className="border border-white/10 bg-white/[0.02] p-4 sm:p-6">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <p className="text-[9px] uppercase tracking-[0.35em] text-white/30 font-bold">Bottle Visual</p>
                      {detailBottleUrl ? (
                        <button
                          type="button"
                          onClick={() => setEnlargeOpen(true)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-white/12 bg-white/[0.06] text-[9px] uppercase tracking-[0.2em] font-bold text-white/65 hover:bg-white/[0.1] hover:text-white transition-colors"
                          aria-label="Enlarge bottle image"
                        >
                          <Maximize2 size={13} strokeWidth={2} />
                          Enlarge
                        </button>
                      ) : null}
                    </div>
                    <div className="relative h-48 sm:h-64 overflow-hidden rounded-sm">
                      <BottleImage
                        key={detailBottleUrl || 'missing-image'}
                        variant="detail"
                        src={detailBottleUrl}
                        alt={entryName(selectedItem)}
                        adjustment={frameDraft}
                        className="absolute inset-0"
                        imgClassName="transition-all duration-300"
                      />
                    </div>
                  </div>

                  {detailMetaRows.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-8 py-5 border-y border-white/5">
                      {detailMetaRows.map(({ label, value }) => (
                        <div key={label}>
                          <p className="text-[9px] uppercase tracking-widest text-white/20 font-bold mb-1">{label}</p>
                          <p className="font-serif italic text-lg sm:text-2xl text-white">{value}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {!selectedHasDerivedNotes && hasLegacyPyramidNotes(selectedItem) ? (
                    <div className="space-y-5">
                      <div className="flex items-center gap-3">
                        <Wind size={14} className="text-white/20 shrink-0" />
                        <p className="text-[10px] uppercase tracking-[0.4em] text-white/40 font-bold">Molecular Hierarchy</p>
                        <div className="flex-1 h-px bg-white/5" />
                      </div>
                      <div className="space-y-4">
                        {(['top', 'heart', 'base'] as const).map((level) => {
                          const notes = selectedItem.pyramid?.[level]?.filter(Boolean) || [];
                          if (notes.length === 0) return null;
                          return (
                            <div key={level} className="flex gap-4 items-start">
                              <p className="w-10 text-[9px] uppercase tracking-[0.3em] text-scent-accent font-bold pt-1 shrink-0">{level}</p>
                              <div className="flex flex-wrap gap-x-4 gap-y-2 flex-1">
                                {notes.map(note => (
                                  <span key={note} className="text-base sm:text-2xl italic text-white/80 font-serif">{note}</span>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {!selectedHasDerivedMetrics && selectedItem.scent_vector && (
                    <div className="space-y-5">
                      <div className="flex items-center gap-3">
                        <ShieldCheck size={14} className="text-white/20 shrink-0" />
                        <p className="text-[10px] uppercase tracking-[0.4em] text-white/40 font-bold">Vector Signature</p>
                        <div className="flex-1 h-px bg-white/5" />
                      </div>
                      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                        {Object.entries(selectedItem.scent_vector).map(([key, value]) => (
                          <div key={key}>
                            <div className="flex justify-between text-[9px] uppercase tracking-widest text-white/20 mb-1.5 font-bold">
                              <span>{key}</span>
                              <span className="text-scent-accent font-mono">{value}/10</span>
                            </div>
                            <div className="h-0.5 bg-white/5 w-full relative overflow-hidden">
                              <motion.div
                                initial={{ x: '-100%' }} animate={{ x: `${-100 + (value as number) * 10}%` }}
                                transition={{ duration: 1, ease: "circOut" }}
                                className="h-full bg-scent-accent absolute inset-0"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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

                <div
                  className={`rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 ${bottleImageToolsOpen ? 'space-y-3' : ''}`}
                >
                  <button
                    type="button"
                    id="wardrobe-bottle-tools-trigger"
                    aria-expanded={bottleImageToolsOpen}
                    aria-controls="wardrobe-bottle-tools-panel"
                    onClick={() => setBottleImageToolsOpen((o) => !o)}
                    className="w-full flex items-start gap-2 text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-white/[0.04] transition-colors"
                  >
                    <HelpCircle size={14} className="text-white/35 shrink-0 mt-0.5" aria-hidden />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-[9px] uppercase tracking-[0.28em] text-white/45 font-bold">Bottle image</p>
                      {!bottleImageToolsOpen ? (
                        <p
                          className={`text-[10px] leading-snug font-sans ${
                            detailNeedsClarify ? 'text-amber-200/75' : 'text-white/40'
                          }`}
                        >
                          {detailNeedsClarify
                            ? 'Automatic search paused — expand to pick a hint or strip the background.'
                            : 'Expand to find a new image, remove background, or save a preview.'}
                        </p>
                      ) : null}
                    </div>
                    <ChevronDown
                      size={16}
                      className={`text-white/35 shrink-0 mt-0.5 transition-transform duration-200 ${
                        bottleImageToolsOpen ? 'rotate-180' : ''
                      }`}
                      aria-hidden
                    />
                  </button>

                  {bottleImageToolsOpen ? (
                    <div
                      id="wardrobe-bottle-tools-panel"
                      role="region"
                      aria-labelledby="wardrobe-bottle-tools-trigger"
                      className="space-y-3"
                    >
                      {detailNeedsClarify ? (
                        <p className="text-[10px] text-amber-200/75 leading-snug font-sans">
                          Automatic search paused after several tries — pick what looks wrong, then search again or strip the background.
                        </p>
                      ) : (
                        <p className="text-[10px] text-white/40 leading-snug font-sans">
                          Search with an optional issue hint; remove background on the preview; save when it looks right.
                        </p>
                      )}

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
                        className="w-full bg-black/45 border border-white/12 text-white text-[11px] py-2.5 px-2 rounded-lg font-sans outline-none focus:border-scent-accent/50 disabled:opacity-40"
                      >
                        {!detailNeedsClarify ? (
                          <option value="">Automatic search</option>
                        ) : (
                          <option value="">Choose what looks wrong…</option>
                        )}
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
                          disabled={
                            imageToolbarBusy ||
                            (detailNeedsClarify && !clarifySolverId)
                          }
                          title={
                            detailNeedsClarify && !clarifySolverId
                              ? 'Select an issue first'
                              : undefined
                          }
                          className="flex-1 min-h-[44px] py-3 bg-white text-black uppercase tracking-[0.22em] text-[10px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-45 disabled:cursor-not-allowed rounded-lg"
                        >
                          {refreshingId === selectedItem.id ? (
                            <>
                              <RefreshCw size={12} className="animate-spin" /> Searching…
                            </>
                          ) : (
                            <>
                              <RefreshCw size={12} /> Find image
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleStripBackground(selectedItem)}
                          disabled={
                            imageToolbarBusy || !detailBottleUrl?.trim()
                          }
                          title={
                            !detailBottleUrl?.trim()
                              ? 'Need an image first'
                              : 'Run AI background removal on the preview'
                          }
                          className="flex-1 min-h-[44px] py-3 bg-white/[0.06] text-white uppercase tracking-[0.18em] text-[10px] font-bold border border-white/15 hover:bg-white/[0.1] active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-35 disabled:cursor-not-allowed rounded-lg"
                        >
                          {stripBgBusy ? (
                            <>
                              <RefreshCw size={12} className="animate-spin" /> Stripping…
                            </>
                          ) : (
                            <>
                              <Eraser size={12} /> Remove BG
                            </>
                          )}
                        </button>
                      </div>

                      <div className="rounded-lg border border-white/10 bg-black/22 p-3 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[9px] uppercase tracking-[0.25em] text-white/45 font-bold">
                            Frame
                          </p>
                          <button
                            type="button"
                            onClick={() => setFrameDraft(DEFAULT_BOTTLE_IMAGE_ADJUSTMENT)}
                            disabled={imageToolbarBusy}
                            title="Reset frame"
                            aria-label="Reset bottle frame"
                            className="p-1.5 rounded-md border border-white/10 bg-white/[0.04] text-white/45 hover:text-white hover:bg-white/[0.08] disabled:opacity-30"
                          >
                            <RotateCcw size={13} />
                          </button>
                        </div>

                        <div className="grid grid-cols-[5.75rem_1fr_3.1rem] items-center gap-2">
                          <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-white/42 font-bold">
                            <ZoomIn size={12} /> Size
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
                          />
                          <span className="text-right text-[10px] tabular-nums text-white/42">
                            {framePercent(frameDraft.scale)}
                          </span>

                          <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-white/42 font-bold">
                            <MoveHorizontal size={12} /> X
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
                          />
                          <span className="text-right text-[10px] tabular-nums text-white/42">
                            {Math.round(frameDraft.x)}
                          </span>

                          <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-white/42 font-bold">
                            <MoveVertical size={12} /> Y
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
                          />
                          <span className="text-right text-[10px] tabular-nums text-white/42">
                            {Math.round(frameDraft.y)}
                          </span>

                          <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-white/42 font-bold">
                            <ArrowUp size={12} /> Top
                          </label>
                          <input
                            type="range"
                            min="0"
                            max="20"
                            step="0.5"
                            value={frameDraft.cropTop}
                            onChange={(e) => updateFrameDraft({ cropTop: Number(e.target.value) })}
                            disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                            aria-label="Crop from top of bottle image"
                          />
                          <span className="text-right text-[10px] tabular-nums text-white/42">
                            {Math.round(frameDraft.cropTop)}
                          </span>

                          <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-white/42 font-bold">
                            <ArrowRight size={12} /> Right
                          </label>
                          <input
                            type="range"
                            min="0"
                            max="20"
                            step="0.5"
                            value={frameDraft.cropRight}
                            onChange={(e) => updateFrameDraft({ cropRight: Number(e.target.value) })}
                            disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                            aria-label="Crop from right of bottle image"
                          />
                          <span className="text-right text-[10px] tabular-nums text-white/42">
                            {Math.round(frameDraft.cropRight)}
                          </span>

                          <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-white/42 font-bold">
                            <ArrowDown size={12} /> Bottom
                          </label>
                          <input
                            type="range"
                            min="0"
                            max="20"
                            step="0.5"
                            value={frameDraft.cropBottom}
                            onChange={(e) => updateFrameDraft({ cropBottom: Number(e.target.value) })}
                            disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                            aria-label="Crop from bottom of bottle image"
                          />
                          <span className="text-right text-[10px] tabular-nums text-white/42">
                            {Math.round(frameDraft.cropBottom)}
                          </span>

                          <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-white/42 font-bold">
                            <ArrowLeft size={12} /> Left
                          </label>
                          <input
                            type="range"
                            min="0"
                            max="20"
                            step="0.5"
                            value={frameDraft.cropLeft}
                            onChange={(e) => updateFrameDraft({ cropLeft: Number(e.target.value) })}
                            disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                            aria-label="Crop from left of bottle image"
                          />
                          <span className="text-right text-[10px] tabular-nums text-white/42">
                            {Math.round(frameDraft.cropLeft)}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <button
                            type="button"
                            onClick={() => updateFrameDraft({ scale: frameDraft.scale - 0.1 })}
                            disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                            className="min-h-[34px] rounded-md border border-white/10 bg-white/[0.035] text-[9px] uppercase tracking-[0.13em] text-white/52 font-bold flex items-center justify-center gap-1.5 disabled:opacity-30"
                          >
                            <ZoomOut size={12} /> 10%
                          </button>
                          <button
                            type="button"
                            onClick={() => updateFrameDraft({ scale: frameDraft.scale + 0.1 })}
                            disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                            className="min-h-[34px] rounded-md border border-white/10 bg-white/[0.035] text-[9px] uppercase tracking-[0.13em] text-white/52 font-bold flex items-center justify-center gap-1.5 disabled:opacity-30"
                          >
                            <ZoomIn size={12} /> 10%
                          </button>
                          <button
                            type="button"
                            onClick={() => updateFrameDraft({ x: 0, y: 0 })}
                            disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                            className="min-h-[34px] rounded-md border border-white/10 bg-white/[0.035] text-[9px] uppercase tracking-[0.13em] text-white/52 font-bold flex items-center justify-center gap-1.5 disabled:opacity-30"
                          >
                            <MoveHorizontal size={12} /> Center
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateFrameDraft({
                                cropTop: Math.max(frameDraft.cropTop, 6),
                                cropRight: Math.max(frameDraft.cropRight, 6),
                                cropBottom: Math.max(frameDraft.cropBottom, 6),
                                cropLeft: Math.max(frameDraft.cropLeft, 6),
                                scale: Math.max(frameDraft.scale, 1.08),
                              })
                            }
                            disabled={imageToolbarBusy || !detailBottleUrl?.trim()}
                            className="min-h-[34px] rounded-md border border-white/10 bg-white/[0.035] text-[9px] uppercase tracking-[0.13em] text-white/52 font-bold flex items-center justify-center gap-1.5 disabled:opacity-30"
                          >
                            <Crop size={12} /> Tight
                          </button>
                        </div>

                        {frameDirty && !hasPendingPreview ? (
                          <button
                            type="button"
                            onClick={() => void handleSaveImageFrame()}
                            disabled={imageToolbarBusy || !onPersistWardrobeImage}
                            className="w-full min-h-[40px] rounded-lg bg-scent-accent text-black uppercase tracking-[0.2em] text-[10px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {persistBusy ? (
                              <>
                                <RefreshCw size={12} className="animate-spin" /> Saving...
                              </>
                            ) : (
                              <>
                                <Save size={12} /> Save framing
                              </>
                            )}
                          </button>
                        ) : null}
                      </div>

                      {hasPendingPreview && (
                        <div className="flex flex-col gap-2 pt-1 border-t border-white/8">
                          {!onPersistWardrobeImage ? (
                            <p className="text-[10px] text-amber-200/75 text-center font-sans leading-snug px-1">
                              Sign in to save this preview to your vault.
                            </p>
                          ) : null}
                          {pendingPreview?.isFallback ? (
                            <p className="text-[10px] text-amber-200/85 text-center font-sans leading-snug px-1">
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
                              className="flex-1 min-h-[44px] py-3 bg-scent-accent text-black uppercase tracking-[0.2em] text-[10px] font-bold hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg"
                            >
                              {persistBusy ? (
                                <>
                                  <RefreshCw size={12} className="animate-spin" /> Saving…
                                </>
                              ) : (
                                <>
                                  <Check size={12} /> Save to vault
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingPreview(null)}
                              disabled={persistBusy}
                              className="flex-1 min-h-[44px] py-3 bg-transparent text-white/50 uppercase tracking-[0.18em] text-[10px] font-bold border border-white/12 hover:bg-white/[0.05] hover:text-white/80 rounded-lg disabled:opacity-30"
                            >
                              Discard preview
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    onDelete(selectedItem);
                    closeDetail();
                  }}
                  disabled={imageToolbarBusy}
                  aria-label="Delete from vault"
                  className="w-full py-3.5 bg-transparent border border-white/10 text-white/35 uppercase tracking-[0.28em] text-[10px] font-bold hover:border-red-500/45 hover:text-red-400 transition-all flex items-center justify-center gap-2 group disabled:opacity-25 disabled:cursor-not-allowed rounded-lg"
                >
                  <Trash2 size={14} className="group-hover:animate-bounce" />
                  Delete from vault
                </button>
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
                      variant="grid"
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
      </AnimatePresence>
    </div>
  );
};
