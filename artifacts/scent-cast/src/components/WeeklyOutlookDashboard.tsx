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
import { recommendFragranceForWeather } from '@/context/WardrobeContext';

interface WeeklyOutlookDashboardProps {
  items: Fragrance[];
  weather: WeatherData | null;
  onSelectFragrance?: (item: Fragrance) => void;
}

interface OutlookDay {
  day: WeatherForecastDay;
  pick: Fragrance | null;
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
  const notes = pick ? fragranceNotes(pick) : [];

  return (
    <AnimatePresence initial={false} custom={direction} mode="popLayout">
      <motion.div
        key={plan.day.date}
        custom={direction}
        initial={{ opacity: 0, x: prefersReducedMotion ? 0 : direction * 22 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: prefersReducedMotion ? 0 : direction * -22 }}
        transition={{ duration: prefersReducedMotion ? 0.01 : 0.34, ease: CALM_EASE }}
        className="absolute inset-0"
      >
        {pick ? (
          <button
            type="button"
            onClick={onSelect ? () => onSelect(pick) : undefined}
            disabled={!onSelect}
            className="group grid h-full w-full grid-cols-[37%_63%] items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:cursor-default sm:grid-cols-[38%_62%]"
            aria-label={onSelect ? `Open ${pick.name} by ${pick.brand}` : `${pick.name} by ${pick.brand}`}
          >
            <BottleImage
              src={pick.imageUrl}
              alt={`${pick.brand} ${pick.name}`}
              variant="featured"
              adjustment={pick.imageAdjustment}
              imageProperties={pick.imageProperties}
              className="h-full min-h-0 w-full [&_.bottle-packshot-frame]:scale-[1.5]"
              imgClassName="transition-transform duration-500 group-hover:scale-[1.025] motion-reduce:transform-none"
              loading="eager"
            />
            <div className="min-w-0 self-center pb-1 pl-2 pr-1 sm:pl-5">
              <p className="truncate font-serif text-[clamp(1.7rem,7.5vw,3rem)] italic leading-[1.04] text-[#fff7ec]">
                {pick.brand}
              </p>
              <p className="mt-2 line-clamp-2 font-serif text-[clamp(1.2rem,5.3vw,2rem)] leading-[1.08] text-[#f3e8d8]">
                {pick.name}
              </p>
              {notes.length > 0 ? (
                <p className="mt-4 line-clamp-2 font-serif text-[clamp(0.92rem,3.7vw,1.3rem)] italic leading-snug text-[#d9c9b5]">
                  {notes.join(' · ')}
                </p>
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
  const forecast = useMemo(() => weather?.forecast ?? [], [weather?.forecast]);
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
          })?.item ?? null,
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
      className="mx-auto w-full max-w-[52rem] min-w-0 border-t border-scent-accent/12 pt-5 text-center sm:pt-7"
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
          <div className="relative mt-2 h-[9.75rem] sm:mt-3 sm:h-[15rem]">
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

          <div
            role="tablist"
            aria-label="Days this week"
            className="mx-1 grid grid-cols-7 overflow-hidden rounded-[18px] border border-scent-accent/30 bg-black/25 sm:mx-0"
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
                  className={`relative flex min-w-0 flex-col items-center py-2 text-[#f1e7da] transition-colors duration-300 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-scent-accent/60 sm:py-4 ${
                    index > 0 ? 'border-l border-scent-accent/20' : ''
                  } ${isActive ? 'rounded-[17px] border border-scent-accent/75 bg-[#080705]' : ''}`}
                >
                  <span className="text-[8px] font-semibold uppercase tracking-[0.18em] sm:text-[10px]">
                    {dayLabel(plan.day.date)}
                  </span>
                  <span className="mt-1 font-serif text-[1.35rem] leading-none sm:text-[1.8rem]">
                    {dayNumber(plan.day.date)}
                  </span>
                  <span className={`mt-2 ${isActive ? 'text-scent-accent' : 'text-[#eee4d7]'}`}>
                    <WeatherGlyph day={plan.day} size={20} />
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
      className={`absolute top-1/2 z-10 flex h-10 w-8 -translate-y-1/2 items-center justify-center text-scent-accent transition-colors hover:text-[#ffe8a5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50 ${
        direction === 'prev' ? 'left-0' : 'right-0'
      }`}
    >
      <Icon size={29} strokeWidth={1.35} aria-hidden />
    </button>
  );
}
