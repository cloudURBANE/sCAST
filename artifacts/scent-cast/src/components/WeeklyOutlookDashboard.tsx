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
              className="group forecast-hero-bottle relative h-full w-[48%] max-w-[12.5rem] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:cursor-default sm:w-[48%] sm:max-w-[13.5rem]"
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
            <div className="flex min-w-0 w-[52%] max-w-[12.5rem] flex-col items-center justify-center self-center text-center sm:w-[52%] sm:max-w-[14rem]">
              <p className="scent-type-label text-[10px] tracking-[0.3em] text-scent-accent/80 [text-indent:0.3em] sm:text-[12px]">
                {pick.brand}
              </p>
              <p className="mt-1 font-serif text-[clamp(1.35rem,5.6vw,2.1rem)] leading-[1.07] text-[#fff7ec] [overflow-wrap:break-word]">
                {pick.name}
              </p>
              {notes.length > 0 ? (
                <p className="mt-1.5 line-clamp-2 font-serif text-[clamp(0.8rem,3vw,1.05rem)] italic leading-snug text-scent-accent/85 sm:mt-2">
                  {notes.join(' · ')}
                </p>
              ) : null}
            </div>
          </div>
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
  const activeMeta = activePlan?.pick
    ? forecastMeta(activePlan.day, activePlan.pick.recommendation)
    : [];

  return (
    <section
      className="mx-auto w-full max-w-[52rem] min-w-0 text-center"
      aria-label="Scent forecast"
    >
      {/* text-indent matches the tracking so the uppercase title's trailing
          letter-spacing doesn't pull it optically left of the centered axis. */}
      <h2 className="scent-type-label text-[10px] tracking-[0.34em] text-[#efe4d6] [text-indent:0.34em] sm:text-[12px]">
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
              the page edges, and the generous height gives the packshot real product
              presence. The bottle and title share one centered, balanced row. */}
          <div className="relative mx-auto mt-1 flex h-[11.25rem] w-full max-w-[27rem] items-center justify-between gap-1.5 sm:mt-2 sm:h-[13rem] sm:gap-3">
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
            <div className="mt-2.5 flex justify-center sm:mt-3">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-scent-accent/20 bg-black/25 px-3 py-1 text-[#cdbfa9]">
                <WeatherGlyph day={activePlan.day} size={13} />
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] sm:text-[11px]">
                  {activeMeta.join(' · ')}
                </span>
              </div>
            </div>
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
            className={`mx-auto grid w-full max-w-[28.5rem] grid-cols-7 gap-1 sm:gap-2 ${
              activeMeta.length > 0 ? 'mt-3 sm:mt-4' : 'mt-4 sm:mt-5'
            }`}
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
                  className={`forecast-day-tile flex w-full h-[4.75rem] flex-col items-center justify-between py-2 text-[#f1e7da] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/60 sm:h-[6.5rem] sm:py-3.5 ${
                    isActive ? 'is-active' : ''
                  }`}
                >
                  <span className={`text-[8px] font-semibold uppercase tracking-[0.16em] sm:text-[10px] ${isActive ? 'text-scent-accent/90' : 'text-[#cdbfa9]'}`}>
                    {dayLabel(plan.day.date)}
                  </span>
                  <span className="font-serif text-[1.2rem] leading-none sm:text-[1.8rem]">
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
      className="flex h-9 w-7 shrink-0 items-center justify-center text-scent-accent/80 transition-colors hover:text-[#ffe8a5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50"
    >
      <Icon size={22} strokeWidth={1.5} aria-hidden />
    </button>
  );
}
