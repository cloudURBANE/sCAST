import React, { useMemo } from 'react';
import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import type { WeatherData, WeatherForecastDay } from '@/context/WeatherContext';
import { recommendFragranceForWeather } from '@/context/WardrobeContext';
import type { Fragrance } from '@/components/Wardrobe';

interface WeeklyOutlookDashboardProps {
  items: Fragrance[];
  weather: WeatherData | null;
}

/**
 * Map an OpenWeather icon code (e.g. "10d") — falling back to the condition
 * text — to a calm line icon. Kept deliberately small: the dashboard reads as a
 * quiet instrument cluster, not a colourful weather widget.
 */
function weatherIconFor(icon: string | null, condition: string | null): LucideIcon {
  const code = (icon ?? '').slice(0, 2);
  switch (code) {
    case '01':
      return Sun;
    case '02':
      return CloudSun;
    case '03':
    case '04':
      return Cloud;
    case '09':
    case '10':
      return CloudRain;
    case '11':
      return CloudLightning;
    case '13':
      return CloudSnow;
    case '50':
      return CloudFog;
    default:
      break;
  }
  const text = (condition ?? '').toLowerCase();
  if (/thunder|storm/.test(text)) return CloudLightning;
  if (/snow|sleet|ice/.test(text)) return CloudSnow;
  if (/rain|drizzle|shower/.test(text)) return CloudRain;
  if (/fog|mist|haze|smoke/.test(text)) return CloudFog;
  if (/cloud|overcast/.test(text)) return Cloud;
  if (/clear|sun/.test(text)) return Sun;
  return CloudSun;
}

function dayLabel(iso: string, index: number): string {
  if (index === 0) return 'Today';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function roundTemp(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}°` : '—';
}

interface OutlookDay {
  day: WeatherForecastDay;
  label: string;
  Icon: LucideIcon;
  pickName: string | null;
  pickBrand: string | null;
}

/**
 * "Your week in scent" — a quiet, Apple-style instrument cluster that sits at
 * the bottom of the home screen's first viewport (above the iPhone tab bar). For
 * each of the next 7 days it pairs the forecast (icon + high/low) with the
 * best-aligned fragrance from the user's vault, scored by the same weather
 * engine that drives the home recommendation.
 */
export const WeeklyOutlookDashboard: React.FC<WeeklyOutlookDashboardProps> = ({ items, weather }) => {
  const forecast = weather?.forecast ?? [];

  const outlook = useMemo<OutlookDay[]>(() => {
    return forecast.map((day, index) => {
      const pick = recommendFragranceForWeather(items, {
        temperature_f: day.temp ?? day.high,
        humidity: day.humidity ?? undefined,
        condition: day.condition ?? undefined,
      });
      return {
        day,
        label: dayLabel(day.date, index),
        Icon: weatherIconFor(day.icon, day.condition),
        pickName: pick?.name ?? null,
        pickBrand: pick?.brand ?? null,
      };
    });
  }, [forecast, items]);

  const hasVault = items.length > 0;

  return (
    <section
      aria-label="Your week in scent"
      className="mx-auto w-full max-w-[60rem] min-w-0"
    >
      <header className="mb-3 flex items-end justify-between gap-3 px-1 sm:mb-4">
        <div className="min-w-0">
          <p className="scent-type-label text-scent-accent/88">Your week in scent</p>
          <h2 className="mt-1 break-words font-serif text-xl italic leading-tight text-[#fff7ec] sm:text-2xl">
            7-day outlook
          </h2>
        </div>
        {weather?.location ? (
          <p className="shrink-0 scent-type-meta text-[10px] uppercase tracking-[0.14em] text-scent-text-muted sm:text-[11px]">
            {weather.location}
          </p>
        ) : null}
      </header>

      {outlook.length === 0 ? (
        // No live forecast (no provider key, or the 2.5 fallback that carries no
        // daily data). Keep the dashboard's footprint with one calm line rather
        // than collapsing the layout.
        <div className="flex min-h-[8.5rem] items-center justify-center rounded-[20px] border border-scent-accent/16 bg-[#050403] px-5 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.05)]">
          <p className="scent-type-chip text-[11px] text-scent-text-muted sm:text-sm">
            Live forecast unavailable right now — your daily scent picks return when the weather feed is back.
          </p>
        </div>
      ) : (
        <div
          className="-mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:grid sm:grid-cols-7 sm:gap-2 sm:overflow-visible sm:px-0"
          role="list"
        >
          {outlook.map(({ day, label, Icon, pickName, pickBrand }, index) => (
            <article
              key={day.date}
              role="listitem"
              className={[
                'flex min-w-[7.25rem] shrink-0 snap-start flex-col items-center gap-2 rounded-[18px] border bg-[#050403] px-3 py-3.5 text-center shadow-[inset_0_1px_0_rgba(255,236,183,0.05)] sm:min-w-0',
                index === 0
                  ? 'border-scent-accent/55'
                  : 'border-scent-accent/18',
              ].join(' ')}
            >
              <p
                className={[
                  'scent-type-chip text-[10px] uppercase tracking-[0.14em]',
                  index === 0 ? 'text-scent-accent' : 'text-scent-text-muted',
                ].join(' ')}
              >
                {label}
              </p>
              <Icon size={22} strokeWidth={1.6} className="text-[#fff7ec]" aria-hidden="true" />
              <p className="font-mono text-[11px] tabular-nums text-[#fff7ec]/82">
                <span className="text-[#fff7ec]">{roundTemp(day.high)}</span>
                <span className="text-scent-text-muted"> / {roundTemp(day.low)}</span>
              </p>
              <div
                className="my-0.5 h-px w-8 max-w-full bg-scent-accent/30"
                aria-hidden="true"
              />
              {hasVault && pickName ? (
                <div className="min-w-0">
                  <p
                    className="line-clamp-2 break-words font-serif text-[12px] italic leading-tight text-[#fff7ec]"
                    title={pickBrand ? `${pickName} · ${pickBrand}` : pickName}
                  >
                    {pickName}
                  </p>
                  {pickBrand ? (
                    <p className="mt-0.5 truncate scent-type-meta text-[9px] uppercase tracking-[0.1em] text-scent-text-muted">
                      {pickBrand}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="scent-type-meta text-[9px] uppercase tracking-[0.12em] text-scent-text-muted/80">
                  {hasVault ? 'No match' : 'Add scents'}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
};
