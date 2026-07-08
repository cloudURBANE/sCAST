import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  Sparkles,
  Sun,
} from 'lucide-react';
import { BottleImage } from '@/components/BottleImage';
import type { Fragrance } from '@/components/Wardrobe';
import type { WeatherData, WeatherForecastDay } from '@/context/WeatherContext';
import { planWeeklyScentOutlook, type WeatherOutlookPick } from '@/context/WardrobeContext';
import type { ScentWeatherRecommendation } from '@/lib/scentWeatherEngine';

interface WeeklyOutlookDashboardProps {
  items: Fragrance[];
  weather: WeatherData | null;
  onSelectFragrance?: (item: Fragrance) => void;
}

interface OutlookDay {
  day: WeatherForecastDay;
  pick: WeatherOutlookPick | null;
}

const CALM_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function WeatherGlyph({ day, size = 22 }: { day: WeatherForecastDay; size?: number }) {
  const code = (day.icon ?? '').slice(0, 2);
  const condition = (day.condition ?? '').toLowerCase();
  const common = { size, strokeWidth: 1.45, 'aria-hidden': true } as const;

  if (/thunder|storm/.test(condition) || code === '11') return <CloudLightning {...common} />;
  if (/snow|sleet|ice/.test(condition) || code === '13') return <CloudSnow {...common} />;
  if (/drizzle/.test(condition) || code === '09') return <CloudDrizzle {...common} />;
  if (/rain|shower/.test(condition) || code === '10') return <CloudRain {...common} />;
  if (/mist|fog|haze|smoke/.test(condition) || code === '50') return <CloudFog {...common} />;
  if (/clear|sun/.test(condition) || code === '01') return <Sun {...common} />;
  return <Cloud {...common} />;
}

function forecastDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * True when a forecast day's calendar date is before today (local time).
 *
 * A *daily* scent forecast must always begin at today. The provider normally
 * returns a today-first window, but a payload that crosses local midnight (or an
 * older/redundancy provider that leads with the prior day) would otherwise push a
 * stale day into the strip — landing users on "yesterday" with today bumped to the
 * second tab. Dropping past days keeps the default-selected hero (index 0) pinned
 * to today regardless of how the window was generated. No-op when the data is
 * already today-first.
 */
function isPastForecastDay(iso: string): boolean {
  const date = forecastDate(iso);
  if (!date) return false;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date.getTime() < startOfToday.getTime();
}

function dayLabel(iso: string): string {
  return forecastDate(iso)?.toLocaleDateString(undefined, { weekday: 'short' }) ?? '—';
}

/** True when the forecast day is today's local calendar date. */
function isTodayForecastDay(iso: string): boolean {
  const date = forecastDate(iso);
  if (!date) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function dayNumber(iso: string): string {
  return forecastDate(iso)?.toLocaleDateString(undefined, { day: 'numeric' }) ?? '—';
}

function dedupeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = label.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fragranceNotes(item: Fragrance): string[] {
  const metrics = item.raw_engine_detail?.derived_metrics ?? item.derived_metrics;
  const metricNotes = metrics?.notes;
  const candidates = metricNotes
    ? [
        ...(metricNotes.top ?? []),
        ...(metricNotes.heart ?? []),
        ...(metricNotes.base ?? []),
        ...(metricNotes.flat ?? []),
      ]
    : [];

  if (candidates.length > 0) return dedupeLabels(candidates).slice(0, 3);
  if (item.notes?.length) return dedupeLabels(item.notes).slice(0, 3);

  const pyramid = [
    ...(item.pyramid?.top ?? []),
    ...(item.pyramid?.heart ?? []),
    ...(item.pyramid?.base ?? []),
  ];
  if (pyramid.length > 0) return dedupeLabels(pyramid).slice(0, 3);

  const accordSummary = metrics?.main_accords?.accord_summary?.trim();
  return accordSummary ? [accordSummary] : [];
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Rounded °F for the selected day — prefers the daypart temp, then the high/low. */
function temperatureLabel(day: WeatherForecastDay): string | null {
  const temp = day.temp ?? day.high ?? day.low;
  return typeof temp === 'number' && Number.isFinite(temp) ? `${Math.round(temp)}°` : null;
}

/**
 * The "why this bottle today" caption. The engine already scores each forecast
 * day (temperature, humidity, projection) and we previously threw that result
 * away, rendering a bare bottle that read as arbitrary. Surfacing the day's
 * weather plus the engine's recommended spray load turns the card back into an
 * actual forecast: the pick is visibly tied to the conditions that earned it.
 */
function forecastMeta(day: WeatherForecastDay, rec: ScentWeatherRecommendation | null): string[] {
  const parts: string[] = [];
  const temp = temperatureLabel(day);
  if (temp) parts.push(temp);

  const condition = (day.condition ?? '').trim();
  if (condition) parts.push(titleCase(condition));

  const sprays = rec?.spray_count?.recommended;
  if (typeof sprays === 'number' && sprays > 0) {
    parts.push(`${sprays} ${sprays === 1 ? 'spray' : 'sprays'}`);
  }
  return parts;
}

/** Short, human descriptor of a fragrance's own character for the "why this pick"
 *  line. Prefers the catalog family, then the dominant scent-vector axis, so the
 *  sentence always names something true about THIS bottle (not the weather). */
const FAMILY_DESCRIPTOR: Record<string, string> = {
  woody: 'warm, woody',
  fresh: 'fresh, airy',
  floral: 'soft, floral',
  oriental: 'rich, oriental',
  amber: 'glowing, amber',
  citrus: 'bright, citrus',
  aromatic: 'crisp, aromatic',
  gourmand: 'sweet, gourmand',
  chypre: 'mossy, chypre',
  'fougère': 'clean, fougère',
  fougere: 'clean, fougère',
  leather: 'supple, leather',
  aquatic: 'cool, aquatic',
  green: 'green, crisp',
  spicy: 'spiced, bold',
  sweet: 'sweet, inviting',
  musky: 'soft, musky',
  powdery: 'soft, powdery',
  smoky: 'smoky, resinous',
  oud: 'deep, oud-driven',
  tobacco: 'warm, tobacco',
};

const VECTOR_DESCRIPTOR: Record<string, string> = {
  freshness: 'fresh, airy',
  sweetness: 'sweet, inviting',
  woodiness: 'warm, woody',
  spice: 'spiced, bold',
  warmth: 'warm, enveloping',
  musk: 'soft, musky',
};

function pickCharacter(item: Fragrance): string {
  const family = item.family?.trim().toLowerCase();
  if (family && FAMILY_DESCRIPTOR[family]) return FAMILY_DESCRIPTOR[family];
  const vector = item.scent_vector;
  if (vector) {
    const axes = Object.keys(VECTOR_DESCRIPTOR) as (keyof typeof vector)[];
    const top = axes
      .map((axis) => ({ axis, value: typeof vector[axis] === 'number' ? vector[axis] : 0 }))
      .sort((a, b) => b.value - a.value)[0];
    if (top && top.value >= 3) return VECTOR_DESCRIPTOR[top.axis as string];
  }
  if (family) return family;
  return 'signature';
}

/** Coarse temperature mood for the conditions clause. */
function temperatureMood(day: WeatherForecastDay): string | null {
  const t = day.temp ?? day.high ?? day.low;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (t <= 40) return 'cold';
  if (t <= 55) return 'cool';
  if (t <= 72) return 'mild';
  if (t <= 84) return 'warm';
  return 'hot';
}

/** How the engine wants the bottle worn today, phrased for a reader. */
const WEAR_WINDOW_PHRASE: Record<ScentWeatherRecommendation['wear_window'], string> = {
  best_now: 'lands cleanly right now',
  better_later: 'blooms as the day warms',
  daytime_safe: 'stays crisp through the day',
  nighttime_better: 'deepens after dark',
  avoid_today: 'makes a confident statement',
};

/** Community-voted seasons for the bottle, lower-cased; [] when un-enriched. */
function pickSeasons(item: Fragrance): string[] {
  const metrics = item.raw_engine_detail?.derived_metrics ?? item.derived_metrics;
  return (metrics?.wear_profile?.primary_seasons ?? [])
    .map((season) => (typeof season === 'string' ? season.trim().toLowerCase() : ''))
    .filter(Boolean);
}

/** The seasons a given temperature mood flatters, for matching against votes. */
const MOOD_SEASONS: Record<string, string[]> = {
  cold: ['winter'],
  cool: ['fall', 'autumn', 'winter'],
  mild: ['spring', 'fall', 'autumn'],
  warm: ['spring', 'summer'],
  hot: ['summer'],
};

/**
 * Calendar season for a forecast date (northern-hemisphere month mapping — the
 * WeatherData surface carries no latitude, so months are the best signal we
 * have; the mood cross-check below keeps southern-hemisphere claims from
 * slipping through, because an out-of-season month and its real temperature
 * never agree on the same season).
 */
function calendarSeason(iso: string): string | null {
  const month = forecastDate(iso)?.getMonth();
  if (typeof month !== 'number') return null;
  if (month === 11 || month <= 1) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'fall';
}

/**
 * Title-cased season the bottle is voted for that fits today, or null.
 * A season is only ever claimed when THREE things agree: the community voted
 * the bottle for it, the day's temperature mood flatters it, AND it is the
 * actual calendar season of the selected date. Previously the calendar was
 * ignored, so a mild 68° July day happily rendered "ideal for Spring" —
 * technically mood-matched, instantly trust-breaking on screen.
 */
function matchedSeasonLabel(item: Fragrance, mood: string | null, dateIso: string): string | null {
  if (!mood) return null;
  const actual = calendarSeason(dateIso);
  if (!actual) return null;
  const matchesActual = (season: string) =>
    season.includes(actual) || (actual === 'fall' && season.includes('autumn'));
  const targets = MOOD_SEASONS[mood] ?? [];
  if (!targets.some(matchesActual)) return null;
  if (!pickSeasons(item).some(matchesActual)) return null;
  return actual.charAt(0).toUpperCase() + actual.slice(1);
}

/** 0–100 crowd-consensus score the community gives the bottle, or null. */
function crowdScore(item: Fragrance): number | null {
  const metrics = item.raw_engine_detail?.derived_metrics ?? item.derived_metrics;
  const score = metrics?.headline?.crowd_consensus_score;
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
}

/**
 * The single, centered "why this bottle today" sentence under the hero. It names
 * the bottle's own character, then leads with the STRONGEST real factor behind the
 * pick — in priority order: a community-voted season that matches today, a high
 * crowd rating, otherwise the engine's wear verdict for the day's temperature.
 * That mirrors exactly how `planWeeklyScentOutlook` scores the vault, so the copy
 * is an honest explanation rather than decoration. Kept to one tidy clause that
 * always fits the centered forecast column; the precise numbers (°, condition,
 * spray load) live in the metadata pill above it.
 */
function describeForecastPick(day: WeatherForecastDay, pick: WeatherOutlookPick): string {
  const weekday = forecastDate(day.date)?.toLocaleDateString(undefined, { weekday: 'long' }) ?? 'today';
  const character = pickCharacter(pick.item);
  const mood = temperatureMood(day);

  const season = matchedSeasonLabel(pick.item, mood, day.date);
  if (season) {
    return `Picked for ${weekday}: a ${character} scent your community rates ideal for ${season}.`;
  }

  const crowd = crowdScore(pick.item);
  if (crowd !== null && crowd >= 78) {
    const tail = mood ? `${mood} air` : "today's conditions";
    return `Picked for ${weekday}: a crowd-favorite ${character} scent matched to ${tail}.`;
  }

  const verdict = WEAR_WINDOW_PHRASE[pick.recommendation.wear_window] ?? 'balances well today';
  const tail = mood ? ` in ${mood} air` : '';
  return `Picked for ${weekday}: its ${character} character ${verdict}${tail}.`;
}

function ForecastHero({
  plan,
  direction,
  onSelect,
}: {
  plan: OutlookDay;
  direction: number;
  onSelect?: (item: Fragrance) => void;
}) {
  const prefersReducedMotion = useReducedMotion() === true;
  const pick = plan.pick;
  const fragrance = pick?.item ?? null;
  const notes = fragrance ? fragranceNotes(fragrance) : [];
  // Key the transition on the displayed *content* (the pick), not the calendar
  // day. Consecutive days frequently resolve to the same recommended bottle, and
  // keying on the date re-mounted BottleImage — re-fetching/decoding the identical
  // packshot and replaying the slide + skeleton crossfade for content that did not
  // change. With a content key, identical-pick navigations stay still (the day-tab
  // highlight still moves, so the change reads); only a genuine bottle change animates.
  const contentKey = fragrance?.id ?? 'empty';

  return (
    // Default (sync) presence — both layers are already `absolute inset-0`, so a
    // plain crossfade keeps the in/out overlap that reads as a smooth slide without
    // the layout-projection cost of popLayout stacking GPU-promoted bottle layers.
    <AnimatePresence initial={false} custom={direction}>
      <m.div
        key={contentKey}
        custom={direction}
        initial={{ opacity: 0, x: prefersReducedMotion ? 0 : direction * 22 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: prefersReducedMotion ? 0 : direction * -22 }}
        transition={{ duration: prefersReducedMotion ? 0.01 : 0.34, ease: CALM_EASE }}
        // Pre-promote to its own compositor layer + pin will-change so mobile WebKit
        // stops re-promoting/demoting every slide. motion-safe so reduced-motion users
        // and the static fallback keep a clean layer with no leftover hints.
        className="absolute inset-0 motion-safe:[transform:translateZ(0)] motion-safe:[backface-visibility:hidden] motion-safe:[will-change:transform,opacity]"
      >
        {pick && fragrance ? (
          // Only the BOTTLE opens the fragrance — the title/brand/notes are now
          // read-only. Previously the whole hero (bottle + text) was one <button>,
          // so tapping the NAME also navigated; product feedback is that the name
          // must NOT be a tap target. The row stays a plain flex container; the
          // bottle is the lone interactive element and the text sits beside it as
          // static copy.
          <div className="flex h-full w-full items-center justify-center gap-1.5 sm:gap-3">
            {/* Normalized bottle frame — a fixed share of the hero (not a full-width
                column), so the bottle and the title read as ONE centered unit instead
                of splitting to opposite edges. `forecast-hero-bottle` cancels the +9%
                normalized upscale (see index.css) so this tight square slot can never
                clip the cap, and the wrapper's bottom padding raises the shelf line a
                touch so the bottle sits beside — not below — the title. The shared
                width + `object-contain` keep every pick's footprint uniform.

                ANIMATION NOTE (shared-bottle morph — fix-later flag): tapping a
                fragrance "card image" everywhere else (Wardrobe grid, Community feed)
                plays a framer-motion shared-element morph driven by
                `layoutId={`wardrobe-bottle-${id}`}` + `bottleMorphTransition`
                (see Wardrobe.tsx). This bottle opens the SAME detail via the shared
                `onSelect` → `openFragranceDetail` path, so the modal still morphs from
                the matching grid bottle — but this forecast bottle does NOT itself
                carry that `layoutId`, so the morph does not originate from the hero.
                Deliberately left as-is and flagged here so the shared-morph animation
                can be wired/standardized from this surface in a later, dedicated pass
                (kept as one note so every place we implement this animation can be
                fixed together). */}
            <button
              type="button"
              onClick={onSelect ? () => onSelect(fragrance) : undefined}
              disabled={!onSelect}
              className="group forecast-hero-bottle relative h-full w-[54%] max-w-[14rem] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:cursor-default sm:w-[52%] sm:max-w-[15.5rem] md:max-w-[17rem]"
              aria-label={onSelect ? `Open ${pick.name} by ${pick.brand}` : `${pick.name} by ${pick.brand}`}
            >
              <BottleImage
                src={fragrance.imageUrl}
                alt={`${pick.brand} ${pick.name}`}
                variant="featured"
                adjustment={fragrance.imageAdjustment}
                imageProperties={fragrance.imageProperties}
                className="h-full w-full [&_.bottle-artboard]:inset-[1%] sm:[&_.bottle-artboard]:inset-[6%]"
                imgClassName="transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transform-none"
                loading="eager"
              />
            </button>
            {/* Width-constrained text stack read as ONE unit: CREED eyebrow → name →
                lead notes. Hierarchy mirrors how a fragrance is billed (house quiet,
                NAME the headline). The narrow max-width makes the title wrap in a
                controlled, premium way and NEVER truncate with an ellipsis — a 3-word
                name like "Silver Mountain Water" breaks after "Mountain", while a
                tighter name like "Green Irish Tweed" stays balanced on one line.
                NON-INTERACTIVE by design: the name is not a tap target (see above). */}
            <div className="flex min-w-0 w-[46%] max-w-[12.5rem] flex-col items-center justify-center self-center text-center sm:w-[48%] sm:max-w-[14rem] md:max-w-[20rem]">
              <p className="scent-type-label text-[10px] tracking-[0.3em] text-scent-accent/80 [text-indent:0.3em] sm:text-[12px] md:text-[13px]">
                {pick.brand}
              </p>
              <p className="mt-1 font-serif text-[clamp(1.35rem,5.6vw,2.1rem)] leading-[1.07] text-scent-text-primary [overflow-wrap:break-word] md:mt-1.5 md:text-[clamp(2.1rem,4.4vw,2.85rem)] md:leading-[1.05]">
                {pick.name}
              </p>
              {notes.length > 0 ? (
                // Notes render as per-note spans (not one joined string) so the
                // third note — and its leading separator — can drop out below
                // 360px instead of line-clamp cutting the joined string mid-way
                // and stranding a "Bergamot ·…" dangling-separator ellipsis on
                // SE-class screens. Wider viewports see the identical joined line.
                <p className="mt-1.5 line-clamp-2 font-serif text-[clamp(0.9rem,3.1vw,1.1rem)] italic leading-snug text-scent-accent sm:mt-2 md:mt-2.5 md:text-[clamp(1rem,1.7vw,1.2rem)]">
                  {notes.map((note, index) => (
                    <span key={note} className={index >= 2 ? 'hidden min-[360px]:inline' : undefined}>
                      {index > 0 ? ' · ' : ''}
                      {note}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          // px relaxes below sm: between the two 44px chevrons a 320px viewport
          // leaves ~120px for this message under the old px-12, which stacked
          // it into a one-word-per-line column.
          <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center sm:px-12">
            <Sparkles size={24} strokeWidth={1.5} className="text-scent-accent/75" aria-hidden />
            <p className="max-w-[17rem] font-serif text-lg italic leading-relaxed text-balance text-scent-text-secondary sm:max-w-none">
              Add fragrances to your vault for a daily scent forecast.
            </p>
          </div>
        )}
      </m.div>
    </AnimatePresence>
  );
}

export const WeeklyOutlookDashboard: React.FC<WeeklyOutlookDashboardProps> = ({
  items,
  weather,
  onSelectFragrance,
}) => {
  const forecast = useMemo(
    () => (weather?.forecast ?? []).filter((day) => !isPastForecastDay(day.date)),
    [weather?.forecast],
  );
  const [selected, setSelected] = useState(0);
  const [direction, setDirection] = useState(0);

  // The full vault × week engine matrix is expensive. `items` gets a new array
  // reference on unrelated wardrobe churn (a lastWornAt stamp, an image-url swap,
  // a background poll that touched one row), each of which would otherwise force
  // a complete re-score of every bottle on every day. Gate the heavy recompute on
  // a SCORING signature — only the fields the planner actually reads — so those
  // unrelated re-renders no longer re-run the matrix. (Engine-internal trait-text
  // memoization is handled separately.)
  const itemsScoringSignature = useMemo(
    () =>
      items
        .map((item) => {
          const dm = item.raw_engine_detail?.derived_metrics ?? item.derived_metrics ?? null;
          const lastWornAt = (item as { lastWornAt?: unknown }).lastWornAt;
          return [
            item.id ?? item._dbId ?? '',
            item.concentration ?? '',
            // Presence of structured metrics flips scoring; cheap proxy for "has
            // this bottle been enriched since the last score" without deep-hashing.
            dm ? '1' : '0',
            typeof lastWornAt === 'string' || typeof lastWornAt === 'number' ? String(lastWornAt) : '',
          ].join(':');
        })
        .join('|'),
    [items],
  );

  // Climate inputs the planner scores against — keyed off the forecast so a
  // weather refresh that returns the same numbers doesn't re-score either.
  const climates = useMemo(
    () =>
      forecast.map((day) => ({
        temperature_f: day.temp ?? day.high,
        humidity: day.humidity,
        condition: day.condition,
      })),
    [forecast],
  );
  const climateSignature = useMemo(
    () => climates.map((c) => `${c.temperature_f ?? ''}:${c.humidity ?? ''}:${c.condition ?? ''}`).join('|'),
    [climates],
  );

  // Latest values for the gated memo to read without listing them as deps (which
  // would defeat the signature gate and recompute on every identity change).
  const itemsRef = useRef(items);
  const climatesRef = useRef(climates);
  const forecastRef = useRef(forecast);
  itemsRef.current = items;
  climatesRef.current = climates;
  forecastRef.current = forecast;

  // Plan the whole week in one pass so each day gets its best-fit bottle AND the
  // week shows variety. Scoring days independently (the old approach) collapsed
  // to one repeated bottle: in ordinary weather the engine emits the same family
  // verdict every day and ties broke on wardrobe index. `planWeeklyScentOutlook`
  // layers a continuous thermal term on top of the engine and de-dupes across
  // the week. Picks are returned aligned to `forecast`.
  const outlook = useMemo<OutlookDay[]>(() => {
    const currentForecast = forecastRef.current;
    const picks = planWeeklyScentOutlook(itemsRef.current, climatesRef.current);
    return currentForecast.map((day, index) => ({ day, pick: picks[index] ?? null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsScoringSignature, climateSignature]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, outlook.length - 1)));
  }, [outlook.length]);

  const go = (next: number) => {
    if (outlook.length === 0) return;
    const wrapped = (next + outlook.length) % outlook.length;
    if (wrapped === selected) return;
    setDirection(next > selected || (selected === outlook.length - 1 && wrapped === 0) ? 1 : -1);
    setSelected(wrapped);
  };

  const activePlan = outlook[selected] ?? null;
  const activeMeta = activePlan?.pick
    ? forecastMeta(activePlan.day, activePlan.pick.recommendation)
    : [];
  const activeReason = activePlan?.pick
    ? describeForecastPick(activePlan.day, activePlan.pick)
    : null;

  return (
    <section
      className="scent-forecast mx-auto w-full max-w-[52rem] min-w-0 text-center"
      aria-label="Scent forecast"
    >
      {/* text-indent matches the tracking so the uppercase title's trailing
          letter-spacing doesn't pull it optically left of the centered axis.
          .forecast-title adds the two fading gold hairlines flanking the label. */}
      <h2 className="forecast-title scent-type-label text-[10px] tracking-[0.34em] text-scent-text-secondary [text-indent:0.34em] sm:text-[12px]">
        Scent Forecast
      </h2>

      {!activePlan ? (
        <div className="flex h-[14rem] items-center justify-center px-8 sm:h-[17rem]">
          <p className="max-w-sm font-serif text-lg italic leading-relaxed text-scent-text-muted">
            Live forecast unavailable right now. Your daily scent picks will return with the weather feed.
          </p>
        </div>
      ) : (
        <>
          {/* Hero frame is width-capped and centered so the carousel chevrons anchor
              to the actual composition (bottle + text) instead of floating against
              the page edges. Section vertical rhythm comes from the --fc-* spacing
              tokens (defined on .scent-forecast in index.css), NOT ad-hoc margins,
              so title→hero→pill→rail read as one tuned system. The hero is the focal
              point: a taller slot + larger bottle give the recommendation real
              product authority. The bottle and title share one centered row. */}
          {/* SLOT HEIGHT IS WIDTH-AWARE: below md the bottle is a square capped
              by its column WIDTH (~96px at 320w, ~132px at 390w), so any extra
              slot height becomes fixed dead bands above and below the packshot —
              measured 34–52px of void per side at the old h-[12.5rem]. The base
              height is trimmed to what the bottle + text stack actually fills;
              the bottle renders at the exact same size. sm gains max-w-[34rem]
              for the same reason: at 640–767px the old 27rem cap starved the
              bottle column (a 141px bottle in a 224px slot); the wider row lets
              the square genuinely earn the sm slot height. */}
          <div className="relative mx-auto mt-[var(--fc-title-hero)] flex h-[11.5rem] w-full max-w-[27rem] items-center justify-between gap-1.5 sm:h-[14rem] sm:max-w-[34rem] sm:gap-3 md:h-[16.5rem] md:max-w-[42rem] md:gap-5 lg:max-w-[46rem]">
            <ForecastChevron direction="prev" onClick={() => go(selected - 1)} />
            <div className="relative h-full flex-1 overflow-hidden">
              <ForecastHero
                plan={activePlan}
                direction={direction}
                onSelect={onSelectFragrance}
              />
            </div>
            <ForecastChevron direction="next" onClick={() => go(selected + 1)} />
          </div>

          {/* Weather + spray metadata as ONE centered inline pill, lifted out of the
              per-pick text column so the icon and "85° · Thunderstorms · 2 Sprays"
              read as a single grouped, screen-centered unit that ties the hero to the
              calendar rather than drifting beside the title. */}
          {activeMeta.length > 0 ? (
            <div className="mt-[var(--fc-hero-pill)] flex justify-center">
              {/* .forecast-meta-pill carries the shared near-black + gold-hairline
                  material; the glyph takes the accent tint (like an active tile's
                  glyph) so the pill's one pictorial element ties it to the rail.
                  The leading accent day token ("TODAY" / "SUN") pins the pill to
                  the SELECTED forecast day, so its weather can never read as
                  contradicting the current-conditions marquee up top. */}
              <div className="forecast-meta-pill inline-flex items-center gap-2 px-3 py-1 text-scent-text-secondary md:gap-2.5 md:px-4 md:py-1.5">
                <span className="flex items-center text-scent-accent/75" aria-hidden>
                  <WeatherGlyph day={activePlan.day} size={14} />
                </span>
                <span className="text-[11px] font-medium uppercase tracking-[0.14em] sm:text-[12px] md:text-[13px]">
                  <span className="text-scent-accent/85">
                    {isTodayForecastDay(activePlan.day.date) ? 'Today' : dayLabel(activePlan.day.date)}
                  </span>
                  {` · ${activeMeta.join(' · ')}`}
                </span>
              </div>
            </div>
          ) : null}

          {/* One centered "why this bottle today" line — the plain-language factor
              behind the pick (its character + the strongest real reason it was
              chosen for the day). Width-capped, balance-wrapped, and clamped to two
              lines so it stays optically centered and always fits the forecast
              column without ever crowding the day rail below. */}
          {activeReason ? (
            <p className="mx-auto mt-[var(--fc-hero-pill)] max-w-[28rem] px-4 text-center font-serif text-[clamp(0.84rem,3.2vw,1rem)] italic leading-snug text-balance line-clamp-2 text-scent-text-secondary md:max-w-[32rem] md:text-[clamp(0.96rem,1.55vw,1.12rem)]">
              {activeReason}
            </p>
          ) : null}

          {/* Seven calendar tiles, each a MINI of the community fragrance-detail
              card frame (`.forecast-day-tile` in index.css): a deep near-black
              fill, one gold hairline border, and — when active — a second quiet
              concentric inner hairline + a barely-there top sheen, exactly like
              the detail card's framing the owner likes. Depth comes from the
              border + inset highlight ONLY; the old active gold gradient fill
              (`from-scent-accent/[0.14]`) read as the rejected "glow inside the
              tile" and is gone (no projected gold glow). Tighter gap + slightly
              wider max-width give each tile a touch more width and presence. */}
          <div
            role="tablist"
            aria-label="Days this week"
            className="mx-auto mt-[var(--fc-pill-rail)] grid w-full max-w-[28.5rem] grid-cols-7 gap-1 sm:gap-2 md:max-w-[34rem] md:gap-3"
          >
            {outlook.slice(0, 7).map((plan, index) => {
              const isActive = index === selected;
              return (
                <button
                  key={plan.day.date}
                  role="tab"
                  aria-selected={isActive}
                  type="button"
                  onClick={() => go(index)}
                  title={`${dayLabel(plan.day.date)} — ${plan.day.condition ?? 'Forecast'}`}
                  className={`forecast-day-tile flex w-full h-[4.75rem] flex-col items-center justify-between py-2 text-[#f1e7da] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 sm:h-[6.5rem] sm:py-3.5 md:h-[7.25rem] md:py-4 ${
                    isActive ? 'is-active' : ''
                  }`}
                >
                  <span className={`text-[8px] font-semibold uppercase tracking-[0.16em] sm:text-[10px] md:text-[11px] ${isActive ? 'text-scent-accent/90' : 'text-[#cdbfa9]'}`}>
                    {dayLabel(plan.day.date)}
                  </span>
                  <span className="font-serif text-[1.2rem] leading-none sm:text-[1.8rem] md:text-[2.1rem]">
                    {dayNumber(plan.day.date)}
                  </span>
                  <span className={`flex items-center justify-center h-[18px] w-full sm:h-[22px] ${isActive ? 'text-scent-accent' : 'text-[#cdbfa9]'}`}>
                    <WeatherGlyph day={plan.day} size={18} />
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
};

function ForecastChevron({ direction, onClick }: { direction: 'prev' | 'next'; onClick: () => void }) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === 'prev' ? 'Previous day' : 'Next day'}
      className="forecast-chevron flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-scent-accent/60 hover:text-scent-gold-200 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 md:h-[3.25rem] md:w-[3.25rem]"
    >
      <Icon size={22} strokeWidth={1.5} aria-hidden className="md:h-[26px] md:w-[26px]" />
    </button>
  );
}
