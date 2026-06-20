import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
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
import { recommendFragranceForWeather, type WeatherOutlookPick } from '@/context/WardrobeContext';
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
  const meta = pick ? forecastMeta(plan.day, pick.recommendation) : [];
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
      <motion.div
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
          <button
            type="button"
            onClick={onSelect ? () => onSelect(fragrance) : undefined}
            disabled={!onSelect}
            className="group grid h-full w-full grid-cols-[46%_54%] items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:cursor-default sm:grid-cols-[40%_60%]"
            aria-label={onSelect ? `Open ${pick.name} by ${pick.brand}` : `${pick.name} by ${pick.brand}`}
          >
            {/* Bottle FILLS its column (height + width) — not a width-clamped square.
                A narrow mobile column would cap an `aspect-square` packshot at the
                column width and ignore the tall hero, rendering it tiny and floating.
                Filling the slot lets `object-fit: contain` + `center bottom` size each
                normalized 768² packshot to the full column width AND seat them all on
                one shelf line: big and uniform. Tight artboard inset on phones draws
                it as large as the column allows; desktop keeps its 7% breathing room. */}
            <BottleImage
              src={fragrance.imageUrl}
              alt={`${pick.brand} ${pick.name}`}
              variant="featured"
              adjustment={fragrance.imageAdjustment}
              imageProperties={fragrance.imageProperties}
              className="h-full w-full [&_.bottle-artboard]:inset-[0%] sm:[&_.bottle-artboard]:inset-[7%]"
              imgClassName="transition-transform duration-500 group-hover:scale-[1.025] motion-reduce:transform-none"
              loading="eager"
            />
            {/* One centered column beside the bottle, read as ONE text unit:
                brand → name → notes → weather caption (no decorative divider rule).
                Hierarchy mirrors how a fragrance is actually billed — the HOUSE is a
                quiet eyebrow and the fragrance NAME is the headline (the previous
                build inverted this, a 3.4rem "Creed" dwarfing the scent it forecast).
                The lead notes and the weather caption tie the bottle to the day's
                conditions so the card reads as a forecast, not a random packshot, and
                the tight rhythm pairs the block with the bottle as a single hero. */}
            <div className="flex min-w-0 flex-col items-center justify-center self-center px-1 text-center sm:px-4">
              <p className="scent-type-label text-[10px] tracking-[0.32em] text-scent-accent/80 sm:text-[12px]">
                {pick.brand}
              </p>
              <p className="mt-1 line-clamp-2 font-serif text-[clamp(1.55rem,7.2vw,2.7rem)] leading-[1.04] text-[#fff7ec]">
                {pick.name}
              </p>
              {notes.length > 0 ? (
                <p className="mt-1.5 line-clamp-2 font-serif text-[clamp(0.85rem,3.4vw,1.2rem)] italic leading-snug text-scent-accent/85 sm:mt-2">
                  {notes.join(' · ')}
                </p>
              ) : null}
              {meta.length > 0 ? (
                <div className="mt-2 flex items-center justify-center gap-1.5 text-[#cdbfa9]">
                  <WeatherGlyph day={plan.day} size={13} />
                  <span className="text-[9.5px] font-medium uppercase tracking-[0.14em] sm:text-[11px]">
                    {meta.join(' · ')}
                  </span>
                </div>
              ) : null}
            </div>
          </button>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-12 text-center">
            <Sparkles size={24} strokeWidth={1.5} className="text-scent-accent/75" aria-hidden />
            <p className="font-serif text-lg italic leading-relaxed text-[#e9dece]">
              Add fragrances to your vault for a daily scent forecast.
            </p>
          </div>
        )}
      </motion.div>
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

  const outlook = useMemo<OutlookDay[]>(
    () =>
      forecast.map((day) => ({
        day,
        pick:
          recommendFragranceForWeather(items, {
            temperature_f: day.temp ?? day.high,
            humidity: day.humidity ?? undefined,
            condition: day.condition ?? undefined,
          }) ?? null,
      })),
    [forecast, items],
  );

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

  return (
    <section
      className="mx-auto w-full max-w-[52rem] min-w-0 text-center"
      aria-label="Daily scent forecast"
    >
      <h2 className="scent-type-label text-[10px] tracking-[0.34em] text-[#efe4d6] sm:text-[12px]">
        Daily Scent Forecast
      </h2>

      {!activePlan ? (
        <div className="flex h-[14rem] items-center justify-center px-8 sm:h-[17rem]">
          <p className="max-w-sm font-serif text-lg italic leading-relaxed text-scent-text-muted">
            Live forecast unavailable right now. Your daily scent picks will return with the weather feed.
          </p>
        </div>
      ) : (
        <>
          {/* Generous hero height on phone (was 8.75rem) — fills the column space the
              page used to waste as dead margin above the forecast, so the packshot
              reads big and intentional instead of as a thumbnail. */}
          <div className="relative mt-3 h-[14.5rem] sm:mt-3 sm:h-[16rem]">
            <ForecastChevron direction="prev" onClick={() => go(selected - 1)} />
            <div className="absolute inset-y-0 left-9 right-9 overflow-hidden sm:left-12 sm:right-12">
              <ForecastHero
                plan={activePlan}
                direction={direction}
                onSelect={onSelectFragrance}
              />
            </div>
            <ForecastChevron direction="next" onClick={() => go(selected + 1)} />
          </div>

          {/* Seven free-standing calendar cards (gap-separated, each its own
              rounded border) — matches the reference forecast strip. No single
              wrapping rail/border. Active day = gold border + warm fill + gold
              glyph; depth comes from border/fill only (no projected gold glow). */}
          <div
            role="tablist"
            aria-label="Days this week"
            className="mt-4 grid grid-cols-7 gap-1.5 sm:mt-6 sm:gap-2.5"
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
                  className={`flex min-w-0 flex-col items-center gap-0.5 rounded-[13px] border py-2 text-[#f1e7da] transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/60 sm:gap-1.5 sm:rounded-[18px] sm:py-3.5 ${
                    isActive
                      ? 'border-scent-accent/55 bg-gradient-to-b from-scent-accent/[0.14] to-scent-accent/[0.04]'
                      : 'border-scent-accent/15 bg-black/25'
                  }`}
                >
                  <span className={`text-[8px] font-semibold uppercase tracking-[0.16em] sm:text-[10px] ${isActive ? 'text-scent-accent/90' : 'text-[#cdbfa9]'}`}>
                    {dayLabel(plan.day.date)}
                  </span>
                  <span className="font-serif text-[1.2rem] leading-none sm:text-[1.8rem]">
                    {dayNumber(plan.day.date)}
                  </span>
                  <span className={isActive ? 'text-scent-accent' : 'text-[#cdbfa9]'}>
                    <WeatherGlyph day={plan.day} size={17} />
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
      className={`absolute top-1/2 z-10 flex h-9 w-7 -translate-y-1/2 items-center justify-center text-scent-accent/80 transition-colors hover:text-[#ffe8a5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50 ${
        direction === 'prev' ? 'left-0' : 'right-0'
      }`}
    >
      <Icon size={22} strokeWidth={1.5} aria-hidden />
    </button>
  );
}
