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
  Droplets,
  MapPin,
  Sparkles,
  Sun,
} from 'lucide-react';
import type { ScentWeatherRecommendation } from '@workspace/scent-weather-engine';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
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
  index: number;
  pick: Fragrance | null;
  recommendation: ScentWeatherRecommendation | null;
}

const CALM_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function WeatherGlyph({ day, size = 18 }: { day: WeatherForecastDay; size?: number }) {
  const code = (day.icon ?? '').slice(0, 2);
  const condition = (day.condition ?? '').toLowerCase();
  const common = { size, strokeWidth: 1.6, 'aria-hidden': true } as const;

  if (/thunder|storm/.test(condition) || code === '11') return <CloudLightning {...common} />;
  if (/snow|sleet|ice/.test(condition) || code === '13') return <CloudSnow {...common} />;
  if (/drizzle/.test(condition) || code === '09') return <CloudDrizzle {...common} />;
  if (/rain|shower/.test(condition) || code === '10') return <CloudRain {...common} />;
  if (/mist|fog|haze|smoke/.test(condition) || code === '50') return <CloudFog {...common} />;
  if (/clear|sun/.test(condition) || code === '01') return <Sun {...common} />;
  return <Cloud {...common} />;
}

function dayLabel(iso: string, index: number, short = false): string {
  if (index === 0) return 'Today';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { weekday: short ? 'short' : 'long' });
}

function roundTemp(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}°` : '—';
}

function wearWindowLabel(window: ScentWeatherRecommendation['wear_window']): string {
  switch (window) {
    case 'best_now':
      return 'Best today';
    case 'daytime_safe':
      return 'Daytime';
    case 'better_later':
      return 'Better later';
    case 'nighttime_better':
      return 'Better at night';
    case 'avoid_today':
      return 'Skip today';
    default:
      return 'Daytime';
  }
}

function MiniFragranceCard({
  plan,
  onSelect,
}: {
  plan: OutlookDay;
  onSelect?: (item: Fragrance) => void;
}) {
  const { pick, recommendation } = plan;

  if (!pick) {
    return (
      <div className="scent-fragrance-card relative flex h-full w-full flex-col items-center overflow-hidden">
        <div className="scent-card-frame" aria-hidden />
        <div className="relative z-[1] flex h-full flex-col items-center justify-center gap-3 px-5 py-7 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-scent-accent/25 text-scent-accent/70">
            <Sparkles size={20} strokeWidth={1.7} aria-hidden />
          </span>
          <p className="text-sm font-medium leading-relaxed text-scent-text-muted">
            Add fragrances to your vault and we&apos;ll match one to each day&apos;s weather.
          </p>
        </div>
      </div>
    );
  }

  const interactive = Boolean(onSelect);

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={interactive ? () => onSelect?.(pick) : undefined}
      className={`scent-fragrance-card scent-hover-lift group relative flex h-full w-full flex-col items-center overflow-hidden text-left transition-[transform,border-color] duration-500 motion-reduce:transition-none ${
        interactive
          ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50'
          : 'cursor-default'
      }`}
      aria-label={interactive ? `Open ${pick.name} by ${pick.brand}` : `${pick.name} by ${pick.brand}`}
    >
      <div className="scent-card-frame" aria-hidden />
      <div className="relative z-[1] flex h-full w-full flex-col items-center px-4 pb-4 pt-3 sm:px-5">
        {recommendation ? (
          <span className="mb-1 inline-flex items-center rounded-full border border-scent-accent/25 px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-scent-accent/85">
            {wearWindowLabel(recommendation.wear_window)}
          </span>
        ) : null}
        <BrandGoldLabel brand={pick.brand} className="scent-card-brand w-full" />
        <div className="relative my-2 aspect-square min-h-0 w-full flex-1">
          <BottleImage
            src={pick.imageUrl}
            alt={`${pick.brand} ${pick.name}`}
            variant="grid"
            adjustment={pick.imageAdjustment}
            imageProperties={pick.imageProperties}
            className="absolute inset-0"
            imgClassName="transition-transform duration-500 group-hover:scale-[1.04] motion-reduce:transform-none"
          />
        </div>
        <div className="scent-card-title-row mt-auto shrink-0">
          <h3 className="scent-card-title" title={pick.name}>
            {pick.name}
          </h3>
        </div>
      </div>
    </button>
  );
}

export const WeeklyOutlookDashboard: React.FC<WeeklyOutlookDashboardProps> = ({
  items,
  weather,
  onSelectFragrance,
}) => {
  const prefersReducedMotion = useReducedMotion() === true;
  const forecast = useMemo(() => weather?.forecast ?? [], [weather?.forecast]);
  const [selected, setSelected] = useState(0);
  const [direction, setDirection] = useState(0);

  const outlook = useMemo<OutlookDay[]>(() => {
    return forecast.map((day, index) => {
      const match = recommendFragranceForWeather(items, {
        temperature_f: day.temp ?? day.high,
        humidity: day.humidity ?? undefined,
        condition: day.condition ?? undefined,
      });
      return {
        day,
        index,
        pick: match?.item ?? null,
        recommendation: match?.recommendation ?? null,
      };
    });
  }, [forecast, items]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, outlook.length - 1)));
  }, [outlook.length]);

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(outlook.length - 1, next));
    if (clamped === selected) return;
    setDirection(clamped > selected ? 1 : -1);
    setSelected(clamped);
  };

  const activePlan = outlook[selected] ?? null;
  const cardVariants = {
    enter: (value: number) => ({
      opacity: 0,
      x: prefersReducedMotion ? 0 : value * 36,
      scale: prefersReducedMotion ? 1 : 0.97,
    }),
    center: { opacity: 1, x: 0, scale: 1 },
    exit: (value: number) => ({
      opacity: 0,
      x: prefersReducedMotion ? 0 : value * -36,
      scale: prefersReducedMotion ? 1 : 0.97,
    }),
  };

  return (
    <section
      className="relative mx-auto w-full max-w-[60rem] min-w-0 text-center"
      aria-label="Your weekly scent forecast"
    >
      <header className="mb-5 flex flex-col items-center sm:mb-6">
        <span className="scent-type-label text-scent-accent/55">Your week</span>
        <h2 className="mt-1 text-balance font-serif text-[clamp(1.4rem,3.4vw,1.9rem)] italic leading-[1.08] text-[#fff7ec]">
          A scent for every forecast.
        </h2>
        {weather?.location ? (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-scent-text-subtle">
            <MapPin size={12} strokeWidth={1.8} aria-hidden />
            {weather.location}
            {weather.isLive ? (
              <span className="ml-1 inline-flex items-center gap-1 text-scent-accent/70">
                <span className="h-1.5 w-1.5 rounded-full bg-scent-accent/80" aria-hidden />
                Live
              </span>
            ) : null}
          </p>
        ) : null}
      </header>

      {!activePlan ? (
        <div className="mx-auto flex h-[22rem] w-full max-w-[17rem] items-center justify-center rounded-[var(--radius-scent)] border border-scent-accent/10 bg-black/30 px-6">
          <p className="text-sm leading-relaxed text-scent-text-muted">
            Live forecast unavailable right now. Your daily scent picks will return with the weather feed.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-stretch justify-center gap-2 sm:gap-4">
            <ForecastChevron direction="prev" disabled={selected === 0} onClick={() => go(selected - 1)} />
            <div className="relative w-full max-w-[15.5rem] sm:max-w-[17rem]">
              <div className="relative aspect-[1/1.42]">
                <AnimatePresence initial={false} custom={direction} mode="popLayout">
                  <motion.div
                    key={activePlan.day.date}
                    custom={direction}
                    variants={cardVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: prefersReducedMotion ? 0.01 : 0.42, ease: CALM_EASE }}
                    className="absolute inset-0"
                  >
                    <MiniFragranceCard plan={activePlan} onSelect={onSelectFragrance} />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
            <ForecastChevron
              direction="next"
              disabled={selected >= outlook.length - 1}
              onClick={() => go(selected + 1)}
            />
          </div>

          <div className="mx-auto mt-4 min-h-[4.75rem] max-w-[28rem]">
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-scent-text-muted">
              <span className="inline-flex items-center gap-1.5 text-[#fff7ec]">
                <WeatherGlyph day={activePlan.day} size={18} />
                <span className="font-semibold">{roundTemp(activePlan.day.high)}</span>
                <span className="text-scent-text-subtle">/ {roundTemp(activePlan.day.low)}</span>
              </span>
              {activePlan.day.condition ? (
                <span className="capitalize">{activePlan.day.condition}</span>
              ) : null}
              {activePlan.day.humidity !== null ? (
                <span className="inline-flex items-center gap-1 text-scent-text-subtle">
                  <Droplets size={13} strokeWidth={1.7} aria-hidden />
                  {Math.round(activePlan.day.humidity)}%
                </span>
              ) : null}
            </div>
            {activePlan.recommendation?.explanation ? (
              <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-scent-text-muted/90">
                {activePlan.recommendation.explanation}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex justify-center">
            <div
              role="tablist"
              aria-label="Days this week"
              className="flex max-w-full gap-1.5 overflow-x-auto px-1 pb-1 sm:gap-2"
              style={{ scrollbarWidth: 'none' }}
            >
              {outlook.map((plan, index) => {
                const isActive = index === selected;
                return (
                  <button
                    key={plan.day.date}
                    role="tab"
                    aria-selected={isActive}
                    type="button"
                    onClick={() => go(index)}
                    title={`${dayLabel(plan.day.date, index)} — ${plan.day.condition ?? 'Forecast'}`}
                    className={`flex shrink-0 flex-col items-center gap-1 rounded-2xl border px-2.5 py-2 transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50 sm:px-3 ${
                      isActive
                        ? 'border-scent-accent/55 bg-scent-accent/10 text-[#fff7ec]'
                        : 'border-white/8 bg-white/[0.02] text-scent-text-subtle hover:border-white/15 hover:text-scent-text-muted'
                    }`}
                  >
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.12em]">
                      {dayLabel(plan.day.date, index, true)}
                    </span>
                    <span className={isActive ? 'text-scent-accent' : 'text-scent-text-subtle'}>
                      <WeatherGlyph day={plan.day} size={17} />
                    </span>
                    <span className="text-[11px] font-semibold tabular-nums">{roundTemp(plan.day.high)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <a
            href="https://open-meteo.com/"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex text-[9px] uppercase tracking-[0.14em] text-scent-text-subtle/55 transition-colors hover:text-scent-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50"
          >
            Weather data by Open-Meteo
          </a>
        </>
      )}
    </section>
  );
};

function ForecastChevron({
  direction,
  disabled,
  onClick,
}: {
  direction: 'prev' | 'next';
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'prev' ? 'Previous day' : 'Next day'}
      className="my-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-scent-text-muted transition-colors duration-300 hover:border-scent-accent/40 hover:text-[#fff7ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50 disabled:pointer-events-none disabled:opacity-30 sm:h-11 sm:w-11"
    >
      <Icon size={20} strokeWidth={1.9} aria-hidden />
    </button>
  );
}
