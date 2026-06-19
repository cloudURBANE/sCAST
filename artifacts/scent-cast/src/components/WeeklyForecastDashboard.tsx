import React from 'react';
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
  Wind,
} from 'lucide-react';
import {
  rankScentMissionRecommendations,
  type ScentMissionCalibration,
  type ScentWeatherRecommendation,
} from '@workspace/scent-weather-engine';
import { BottleImage } from '@/components/BottleImage';
import { BrandGoldLabel } from '@/components/BrandGoldLabel';
import type { Fragrance } from '@/components/Wardrobe';
import { buildMissionWardrobe } from '@/lib/scentMissionClient';
import {
  dayLabel,
  dayShort,
  fetchWeatherForecast,
  forecastDayToMissionWeather,
  readStoredForecastCoords,
  type ForecastDay,
  type WeatherForecast,
} from '@/lib/forecastClient';

type WeeklyForecastDashboardProps = {
  /** The user's wardrobe — the pool every daily pick is drawn from. */
  items: Fragrance[];
  /** Open the immersive detail for a chosen pick (same path as a vault tile). */
  onSelectFragrance?: (item: Fragrance) => void;
  className?: string;
};

/** One day's resolved card: the weather plus the wardrobe pick scored for it. */
type DayPlan = {
  day: ForecastDay;
  index: number;
  pick: Fragrance | null;
  engine: ScentWeatherRecommendation | null;
  reason: string;
};

const NO_CALIBRATION: ScentMissionCalibration = {};
const CALM_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Map an OpenWeather icon/condition to a calm lucide glyph. */
function WeatherGlyph({ icon, main, size = 18 }: { icon: string; main: string; size?: number }) {
  const code = icon.slice(0, 2);
  const key = `${code}|${main.toLowerCase()}`;
  const common = { size, strokeWidth: 1.6, 'aria-hidden': true } as const;
  if (key.includes('thunder') || code === '11') return <CloudLightning {...common} />;
  if (key.includes('snow') || code === '13') return <CloudSnow {...common} />;
  if (key.includes('drizzle') || code === '09') return <CloudDrizzle {...common} />;
  if (key.includes('rain') || code === '10') return <CloudRain {...common} />;
  if (key.includes('mist') || key.includes('fog') || key.includes('haze') || code === '50') return <CloudFog {...common} />;
  if (code === '01') return <Sun {...common} />;
  return <Cloud {...common} />;
}

/** Friendly label for the engine's wear-window verdict. */
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

function round(value: number): number {
  return Math.round(value);
}

/** The compact, weather-aware fragrance tile — a mini sibling of the vault card. */
function MiniFragranceCard({
  plan,
  onSelect,
}: {
  plan: DayPlan;
  onSelect?: (item: Fragrance) => void;
}) {
  const { pick, engine } = plan;
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
  const wearWindow = engine ? wearWindowLabel(engine.wear_window) : null;

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={interactive ? () => onSelect?.(pick) : undefined}
      className={`scent-fragrance-card scent-hover-lift group relative flex h-full w-full flex-col items-center overflow-hidden text-left transition-[transform,border-color] duration-500 motion-reduce:transition-none ${
        interactive ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50' : 'cursor-default'
      }`}
      aria-label={interactive ? `Open ${pick.name} by ${pick.brand}` : `${pick.name} by ${pick.brand}`}
    >
      <div className="scent-card-frame" aria-hidden />
      <div className="relative z-[1] flex h-full w-full flex-col items-center px-4 pb-4 pt-3 sm:px-5">
        {wearWindow ? (
          <span className="mb-1 inline-flex items-center rounded-full border border-scent-accent/25 px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-scent-accent/85">
            {wearWindow}
          </span>
        ) : null}
        <BrandGoldLabel brand={pick.brand} className="scent-card-brand w-full" />
        <div className="relative my-2 w-full flex-1 min-h-0 aspect-square">
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

export const WeeklyForecastDashboard: React.FC<WeeklyForecastDashboardProps> = ({
  items,
  onSelectFragrance,
  className = '',
}) => {
  const prefersReducedMotion = useReducedMotion() === true;
  const [forecast, setForecast] = React.useState<WeatherForecast | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [selected, setSelected] = React.useState(0);
  const [direction, setDirection] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    fetchWeatherForecast(readStoredForecastCoords(), controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setForecast(data);
        setSelected((current) => Math.min(current, Math.max(0, data.days.length - 1)));
        setStatus('ready');
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
      });
    return () => controller.abort();
  }, []);

  // Score every wardrobe item against each day once, then keep the best pick.
  // Recomputed only when the wardrobe or forecast changes — never per render.
  const plans = React.useMemo<DayPlan[]>(() => {
    if (!forecast) return [];
    const wardrobe = buildMissionWardrobe(items);
    return forecast.days.map((day, index) => {
      const weather = forecastDayToMissionWeather(day, forecast.location, forecast.isLive);
      const ranked = wardrobe.length > 0
        ? rankScentMissionRecommendations(wardrobe, NO_CALIBRATION, weather)
        : [];
      const top = ranked[0] ?? null;
      const pick = top ? items.find((item) => item.id === top.fragranceId) ?? null : null;
      return {
        day,
        index,
        pick,
        engine: top?.engine ?? null,
        reason: top?.reason ?? '',
      };
    });
  }, [forecast, items]);

  if (status === 'error' || (status === 'ready' && plans.length === 0)) {
    return null; // Fail quiet — the home page stands on its own without the forecast.
  }

  const activePlan = plans[selected] ?? null;
  const hasWardrobe = items.length > 0;

  const go = (next: number) => {
    if (!forecast) return;
    const clamped = Math.max(0, Math.min(forecast.days.length - 1, next));
    if (clamped === selected) return;
    setDirection(clamped > selected ? 1 : -1);
    setSelected(clamped);
  };

  const cardVariants = {
    enter: (dir: number) => ({ opacity: 0, x: prefersReducedMotion ? 0 : dir * 36, scale: prefersReducedMotion ? 1 : 0.97 }),
    center: { opacity: 1, x: 0, scale: 1 },
    exit: (dir: number) => ({ opacity: 0, x: prefersReducedMotion ? 0 : dir * -36, scale: prefersReducedMotion ? 1 : 0.97 }),
  };

  return (
    <section
      className={`relative mx-auto w-full max-w-[60rem] min-w-0 text-center ${className}`}
      aria-label="Your weekly scent forecast"
    >
      {/* Header — same calm, serif-italic voice as the rest of the home surface. */}
      <header className="mb-5 flex flex-col items-center sm:mb-6">
        <span className="scent-type-label text-scent-accent/55">Your week</span>
        <h2 className="mt-1 text-balance font-serif italic text-[clamp(1.4rem,3.4vw,1.9rem)] leading-[1.08] text-[#fff7ec]">
          A scent for every forecast.
        </h2>
        {forecast?.location ? (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-scent-text-subtle">
            <MapPin size={12} strokeWidth={1.8} aria-hidden />
            {forecast.location}
            {forecast.isLive ? (
              <span className="ml-1 inline-flex items-center gap-1 text-scent-accent/70">
                <span className="h-1.5 w-1.5 rounded-full bg-scent-accent/80" aria-hidden />
                Live
              </span>
            ) : null}
          </p>
        ) : null}
      </header>

      {status === 'loading' || !activePlan ? (
        <div className="mx-auto h-[22rem] w-full max-w-[17rem] animate-pulse rounded-[var(--radius-scent)] border border-scent-accent/10 bg-black/30" />
      ) : (
        <>
          {/* Center stage: symmetrical chevron · card · chevron. */}
          <div className="flex items-stretch justify-center gap-2 sm:gap-4">
            <ForecastChevron
              direction="prev"
              disabled={selected === 0}
              onClick={() => go(selected - 1)}
            />

            <div className="relative w-full max-w-[15.5rem] sm:max-w-[17rem]">
              <div className="relative aspect-[1/1.42]">
                <AnimatePresence initial={false} custom={direction} mode="popLayout">
                  <motion.div
                    key={selected}
                    custom={direction}
                    variants={cardVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: prefersReducedMotion ? 0.01 : 0.42, ease: CALM_EASE }}
                    className="absolute inset-0"
                  >
                    <MiniFragranceCard plan={activePlan} onSelect={hasWardrobe ? onSelectFragrance : undefined} />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            <ForecastChevron
              direction="next"
              disabled={selected >= plans.length - 1}
              onClick={() => go(selected + 1)}
            />
          </div>

          {/* Weather + engine reason for the selected day. */}
          <div className="mx-auto mt-4 min-h-[3.5rem] max-w-[26rem]">
            <div className="flex items-center justify-center gap-3 text-sm text-scent-text-muted">
              <span className="inline-flex items-center gap-1.5 text-[#fff7ec]">
                <WeatherGlyph icon={activePlan.day.icon} main={activePlan.day.main} size={18} />
                <span className="font-semibold">{round(activePlan.day.temp_high)}°</span>
                <span className="text-scent-text-subtle">/ {round(activePlan.day.temp_low)}°</span>
              </span>
              <span className="capitalize">{activePlan.day.condition}</span>
              <span className="inline-flex items-center gap-1 text-scent-text-subtle">
                <Droplets size={13} strokeWidth={1.7} aria-hidden />
                {round(activePlan.day.humidity)}%
              </span>
              {activePlan.day.wind_speed_mph >= 12 ? (
                <span className="inline-flex items-center gap-1 text-scent-text-subtle">
                  <Wind size={13} strokeWidth={1.7} aria-hidden />
                  {round(activePlan.day.wind_speed_mph)}
                </span>
              ) : null}
            </div>
            {hasWardrobe && activePlan.reason ? (
              <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-scent-text-muted/90">
                {activePlan.reason}
              </p>
            ) : null}
          </div>

          {/* Week rail — the symmetrical, centered "weather map" selector. */}
          <div className="mt-5 flex justify-center">
            <div
              role="tablist"
              aria-label="Days this week"
              className="flex max-w-full gap-1.5 overflow-x-auto px-1 pb-1 sm:gap-2"
              style={{ scrollbarWidth: 'none' }}
            >
              {plans.map((plan, index) => {
                const isActive = index === selected;
                return (
                  <button
                    key={plan.day.dt}
                    role="tab"
                    aria-selected={isActive}
                    type="button"
                    onClick={() => go(index)}
                    title={`${dayLabel(plan.day.dt, index)} — ${plan.day.condition}`}
                    className={`flex shrink-0 flex-col items-center gap-1 rounded-2xl border px-2.5 py-2 transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50 sm:px-3 ${
                      isActive
                        ? 'border-scent-accent/55 bg-scent-accent/10 text-[#fff7ec]'
                        : 'border-white/8 bg-white/[0.02] text-scent-text-subtle hover:border-white/15 hover:text-scent-text-muted'
                    }`}
                  >
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.12em]">
                      {dayShort(plan.day.dt, index)}
                    </span>
                    <span className={isActive ? 'text-scent-accent' : 'text-scent-text-subtle'}>
                      <WeatherGlyph icon={plan.day.icon} main={plan.day.main} size={17} />
                    </span>
                    <span className="text-[11px] font-semibold tabular-nums">{round(plan.day.temp_high)}°</span>
                  </button>
                );
              })}
            </div>
          </div>
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
