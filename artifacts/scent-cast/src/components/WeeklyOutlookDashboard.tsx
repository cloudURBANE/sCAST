import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

function relativeDayLabel(iso: string): string {
  const date = forecastDate(iso);
  if (!date) return 'Daily pick';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  const dayOffset = Math.round((date.getTime() - today.getTime()) / 86_400_000);

  if (dayOffset === 0) return "Today's pick";
  if (dayOffset === 1) return "Tomorrow's pick";
  return `${date.toLocaleDateString(undefined, { weekday: 'long' })}'s pick`;
}

/** In-sentence version of the same relative register: "today" / "tomorrow" /
 *  weekday name. The reason line used to always say the weekday ("Picked for
 *  Saturday…") while the header above it said "Today's pick" — two registers
 *  for the same day in one card. */
function relativeDayPhrase(iso: string): string {
  const date = forecastDate(iso);
  if (!date) return 'today';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  const dayOffset = Math.round((date.getTime() - today.getTime()) / 86_400_000);

  if (dayOffset === 0) return 'today';
  if (dayOffset === 1) return 'tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'long' });
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
  // Data may still label the family "oriental", but the displayed word is
  // "amber" — the current fragrance-family register (design-review must-fix).
  oriental: 'rich, amber',
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

/** Same verdicts with plural agreement, for the notes-led subject ("Grapefruit
 *  and green mango notes stay crisp…"). */
const WEAR_WINDOW_PHRASE_PLURAL: Record<ScentWeatherRecommendation['wear_window'], string> = {
  best_now: 'land cleanly right now',
  better_later: 'bloom as the day warms',
  daytime_safe: 'stay crisp through the day',
  nighttime_better: 'deepen after dark',
  avoid_today: 'make a confident statement',
};

/**
 * Lowercased "grapefruit and green mango" phrase built from the SAME notes the
 * card displays (fragranceNotes), or null when the bottle carries no note data.
 * The reason line previously described only the catalog family ("Rich, oriental
 * notes…") while the card showed grapefruit/green mango — copy and data visibly
 * disagreed, which made the recommendation read as ungrounded. Leading with the
 * displayed notes keeps the sentence provably about THIS bottle. Capped at two
 * short notes so the clause never runs long; anything longer (or an accord
 * summary blob) falls back to the family descriptor.
 */
function notesLeadPhrase(item: Fragrance): string | null {
  const lead = fragranceNotes(item)
    .slice(0, 2)
    .map((note) => note.trim().toLowerCase())
    .filter((note) => note.length > 0 && note.length <= 18);
  if (lead.length === 0) return null;
  return lead.length === 1 ? lead[0] : `${lead[0]} and ${lead[1]}`;
}

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
  const weekday = relativeDayPhrase(day.date);
  const mood = temperatureMood(day);
  // "today's warm, overcast air" — the mood plus a SHORT condition word ties
  // the clause to the same weather the meta line above shows. Multi-word
  // provider strings ("light intermittent showers") stay out so the sentence
  // never runs long; the selected day stays named so the copy never drifts to
  // a generic "today" while a future tab is selected.
  const conditionWord = (day.condition ?? '').trim().toLowerCase();
  const airQualifier = [mood, /^[a-z]+$/.test(conditionWord) && conditionWord !== mood ? conditionWord : null]
    .filter(Boolean)
    .join(', ');
  const dayAir = airQualifier ? `${weekday}'s ${airQualifier} air` : `${weekday}'s conditions`;

  const season = matchedSeasonLabel(pick.item, mood, day.date);
  const crowd = crowdScore(pick.item);

  // Ground the sentence in the notes the card actually displays; seasons stay
  // lowercase in body copy and the promotional "community-rated ideal for"
  // register is gone (design-review must-fix: rationale must agree with the
  // displayed scent data and read as product copy, not marketing).
  const notesLead = notesLeadPhrase(pick.item);
  if (notesLead) {
    const subject = `${notesLead.charAt(0).toUpperCase()}${notesLead.slice(1)} notes`;
    if (season) {
      return `${subject} suit ${dayAir} — a ${season.toLowerCase()} favorite.`;
    }
    if (crowd !== null && crowd >= 78) {
      return `${subject} suit ${dayAir} — a crowd favorite.`;
    }
    const verdict = WEAR_WINDOW_PHRASE_PLURAL[pick.recommendation.wear_window] ?? 'balance well';
    return `${subject} ${verdict} in ${dayAir}.`;
  }

  // No note data — fall back to the bottle's family/vector character.
  const character = pickCharacter(pick.item);
  const characterLead = character.charAt(0).toUpperCase() + character.slice(1);
  if (season) {
    return `${characterLead} notes suit ${dayAir} — a ${season.toLowerCase()} favorite.`;
  }
  if (crowd !== null && crowd >= 78) {
    return `A crowd-favorite ${character} pick, matched to ${dayAir}.`;
  }
  const verdict = WEAR_WINDOW_PHRASE[pick.recommendation.wear_window] ?? 'balances well';
  return `Its ${character} character ${verdict} in ${dayAir}.`;
}

/** Pace of the reason line's type-on reveal. The delay lets the hero's slide
 *  (0.34s) land first so the module reads as a sequence — bottle arrives, data
 *  fades in, then the day's verdict is written out — instead of everything
 *  snapping at once. ~26ms/char puts a typical 90-char sentence at ~2.3s. */
const TYPE_MS_PER_CHAR = 26;
const TYPE_START_DELAY_MS = 480;

/**
 * Types the "why this bottle today" line out slowly, character by character —
 * the forecast being written for you, and the module's one moment of ongoing
 * motion after the hero settles. Layout is reserved up front: the untyped tail
 * stays in the flow as an invisible (not absent) span, so the sentence wraps
 * identically at every frame and the day rail below never reflows mid-type.
 * Screen readers get the whole sentence at once via aria-label; reduced-motion
 * users see it instantly.
 */
function TypedReasonLine({ text }: { text: string }) {
  const prefersReducedMotion = useReducedMotion() === true;
  const [typedChars, setTypedChars] = useState(() => (prefersReducedMotion ? text.length : 0));

  useEffect(() => {
    if (prefersReducedMotion) {
      setTypedChars(text.length);
      return;
    }
    setTypedChars(0);
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      const elapsed = now - start - TYPE_START_DELAY_MS;
      const next = elapsed <= 0 ? 0 : Math.min(text.length, Math.ceil(elapsed / TYPE_MS_PER_CHAR));
      setTypedChars(next);
      if (next < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, prefersReducedMotion]);

  return (
    // Same optics the static line carried: brighter serif italic, width-capped,
    // balance-wrapped, two-line clamp — see the render-site comment.
    <p
      aria-label={text}
      className="mx-auto mt-[var(--fc-hero-pill)] max-w-[28rem] px-4 text-center font-serif text-[clamp(0.9rem,3.3vw,1.05rem)] italic leading-snug text-balance line-clamp-2 text-scent-text-primary md:max-w-[32rem] md:text-[clamp(0.98rem,1.6vw,1.14rem)]"
    >
      <span aria-hidden="true">
        {text.slice(0, typedChars)}
        <span className="invisible">{text.slice(typedChars)}</span>
      </span>
    </p>
  );
}

/**
 * The lead-notes line, with wrap-safe separators. Each "· Note" pair is one
 * non-breaking token, and a layout pass hides the separator of any token that
 * starts a new visual line — so a wrap renders as
 *   Grapefruit · Green Mango
 *   Tomato
 * never with a dangling "· Tomato" (the orphaned leading dot was a flagged
 * production defect). Pure CSS can't do this in centered text (a line-leading
 * token is not at the container edge, so overflow-clip tricks don't apply);
 * the offsetTop comparison is the cheap, deterministic signal, re-run on
 * resize/font settle via ResizeObserver so zoom and Dynamic Type stay correct.
 */
function ForecastNotesLine({ notes }: { notes: string[] }) {
  const lineRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!line) return;

    const update = () => {
      const tokens = Array.from(line.querySelectorAll<HTMLElement>('[data-note-token]'));
      let previous: HTMLElement | null = null;
      for (const token of tokens) {
        // Skip the third note while it's display:none below 360px.
        if (token.offsetParent === null) continue;
        const separator = token.querySelector<HTMLElement>('[data-note-separator]');
        if (separator) {
          const startsNewLine = previous !== null && token.offsetTop > previous.offsetTop + 1;
          separator.style.display = startsNewLine ? 'none' : '';
        }
        previous = token;
      }
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(line);
    return () => observer.disconnect();
  }, [notes]);

  return (
    // Same optics as before: warm cream serif italic, two-line cap. Only the
    // separator ownership moved — each dot now lives INSIDE its note's
    // non-breaking token so the pair wraps as a unit and the dot can be hidden
    // at a line start. Gold stays on the separators alone (the name owns the
    // card's one strong statement).
    <p
      ref={lineRef}
      className="mt-1.5 line-clamp-2 font-serif text-[clamp(0.9rem,3.1vw,1.1rem)] italic leading-snug text-scent-text-secondary sm:mt-2 md:mt-2.5 md:text-[clamp(1rem,1.7vw,1.2rem)]"
    >
      {notes.map((note, index) => (
        <React.Fragment key={note}>
          {/* Plain space OUTSIDE the nowrap token: adjacent nowrap spans with
              no whitespace between them would form one unbreakable run and
              overflow instead of wrapping. This space is the only permitted
              break point, so a break always lands BETWEEN tokens. */}
          {index > 0 ? ' ' : null}
          <span
            data-note-token
            className={`whitespace-nowrap ${index >= 2 ? 'hidden min-[360px]:inline' : ''}`}
          >
            {index > 0 ? (
              <span data-note-separator className="mr-[0.3em] text-scent-accent/75">
                ·
              </span>
            ) : null}
            {note}
          </span>
        </React.Fragment>
      ))}
    </p>
  );
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
              // Width share +~6% and a small upward nudge (design review: the
              // bottle sat slightly small and low beside the denser copy block;
              // the square is width-capped, so widening the column is the
              // clip-safe way to grow the packshot optically).
              className="group forecast-hero-bottle relative h-full w-[57%] max-w-[14.875rem] shrink-0 -translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:cursor-default sm:w-[55%] sm:max-w-[16.5rem] md:max-w-[20rem]"
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
            {/* translate-y nudges the block down a hair from the geometric
                center: the bottle is vertically centered in its frame, but a
                bottle's visual mass sits in its lower body, so a dead-centered
                text column reads as floating slightly HIGH beside it. The small
                downward shift seats brand/name/notes against the bottle's real
                optical center so the two halves lock as one unit. */}
            <div className="flex min-w-0 w-[43%] max-w-[12.5rem] translate-y-[0.3rem] flex-col items-center justify-center self-center text-center sm:w-[45%] sm:max-w-[14rem] sm:translate-y-[0.45rem] md:max-w-[20rem] md:translate-y-[0.6rem]">
              {/* text-balance + tighter phone tracking so a long house name
                  ("DOLCE & GABBANA") composes as two even centered lines
                  instead of one ragged break; sm+ keeps the original size and
                  0.3em spacing untouched. */}
              <p className="scent-type-label text-balance text-[10px] tracking-[0.22em] text-scent-accent/80 [text-indent:0.22em] sm:text-[12px] sm:tracking-[0.3em] sm:[text-indent:0.3em] md:text-[14px]">
                {pick.brand}
              </p>
              {/* Phone size trimmed a further step so a long name like "Silver
                  Mountain Water" stacks in three lines, not four — the bottle
                  stays the hero, the name supports it. md steps UP slightly so
                  the wider iPad card's interior scale matches its frame. */}
              <p className="mt-0.5 font-serif text-[clamp(1.15rem,4.6vw,1.75rem)] leading-[1.02] text-scent-text-primary [overflow-wrap:break-word] md:mt-1 md:text-[clamp(2.2rem,4.6vw,3rem)] md:leading-[1.05]">
                {pick.name}
              </p>
              {notes.length > 0 ? (
                // Per-note tokens (not one joined string) so the third note can
                // drop out below 360px, and so a wrapped line NEVER starts with
                // an orphaned "· " separator — see ForecastNotesLine.
                <ForecastNotesLine notes={notes} />
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
  const prefersReducedMotion = useReducedMotion() === true;
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
      {/* Editorial masthead — the title speaks in the same serif-italic voice as
          the page mastheads ("Vault of Aromas", the search headline) instead of
          the tracked micro-label the data chrome uses (HUMIDITY / TIME). As a
          10px tracked label the module's own name read as one more piece of
          metadata; the serif names it as the daily editorial feature it is.
          Scaled to a module (not page) register so the hero below stays the
          focal point. */}
      {/* One register smaller than before (≈8%): the section label was close
          enough in scale to the fragrance name inside the card that the two
          competed as headlines. At this size it reads as the section's name
          while the pick's name keeps the editorial moment. */}
      {/* ~7% smaller again (design review): the search headline is the page-
          level invitation, this is a SECTION title — the two serif registers
          need clearer separation so the page has one heading system. */}
      <h2 className="forecast-title font-serif italic text-[clamp(1.15rem,4.1vw,1.4rem)] tracking-normal leading-none text-[#fff7ec] sm:text-[clamp(1.35rem,2.15vw,1.6rem)]">
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
          {/* md cap widened 42→44rem: on iPad portrait the card sat visibly
              narrower than the tablet column it anchors, reading as a phone
              composition centered in a large canvas. The wider frame (with the
              matching internal scale bumps below) lets the hero use the tablet
              viewport decisively; phone (27rem) and lg (46rem) are untouched. */}
          {/* Border a step quieter (0.2→0.16) with a touch more tonal lift in
              the fill — the card should read through elevation, not outline;
              the strongest gold borders belong to the active states. */}
          <div className="relative mx-auto mt-[var(--fc-title-hero)] w-full max-w-[27rem] overflow-hidden rounded-[28px] border border-scent-accent/[0.16] bg-gradient-to-b from-white/[0.055] via-black/20 to-black/35 sm:max-w-[34rem] sm:rounded-[32px] md:max-w-[44rem] lg:max-w-[46rem]">
            {/* Centered on the card's axis like every other line in the module.
                The old right-aligned "1 of 7" counter is gone: the seven-day rail
                below already communicates position (labeled, tappable tiles with a
                highlighted selection — the richer affordance), so the counter was
                duplicate positional chrome that also pulled the day label off the
                centered axis. text-indent matches the tracking for optical center. */}
            {/* Strip padding trimmed a step so the day label reads as a quiet
                caption on the card rather than a boxed header band of its own. */}
            {/* Strip shortened + divider faded further (design review: the
                full-strength header band read as dashboard chrome; the label
                should sit on the card as quiet metadata, not a table header). */}
            <div className="flex items-center justify-center border-b border-white/[0.04] px-4 py-1.5 sm:px-5 sm:py-2">
              <p className="text-[9px] font-semibold uppercase tracking-[0.16em] [text-indent:0.16em] text-scent-accent/85 sm:text-[10px]">
                {relativeDayLabel(activePlan.day.date)}
              </p>
            </div>

            <div
              id="scent-forecast-active-panel"
              role="tabpanel"
              className="relative flex h-[11.5rem] w-full items-center justify-between gap-1.5 px-1.5 sm:h-[14rem] sm:gap-3 sm:px-2.5 md:h-[17.5rem] md:gap-5 md:px-4"
            >
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

            {/* Weather + spray metadata stays inside the recommendation frame so
                the bottle, day context, and wear guidance read as one module.
                Keyed on the day and faded in on a short delay so the reveal
                sequences after the hero slide (bottle → data → typed verdict)
                instead of every line landing on the same frame. */}
            {activeMeta.length > 0 ? (
              <div className="flex justify-center px-3 pb-3 sm:pb-3.5">
                <m.div
                  key={activePlan.day.date}
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: prefersReducedMotion ? 0.01 : 0.45, delay: prefersReducedMotion ? 0 : 0.18, ease: CALM_EASE }}
                  className="forecast-meta-pill inline-flex min-h-8 max-w-full items-center gap-1.5 text-scent-text-secondary md:gap-2">
                  {/* Cream, not gold: the day token beside it is this line's one
                      gold element; a gold glyph doubled the accent in a caption
                      that should read as quiet supporting data. */}
                  <span className="flex items-center text-scent-text-secondary/85" aria-hidden>
                    <WeatherGlyph day={activePlan.day} size={14} />
                  </span>
                  <span className="truncate text-[10px] font-medium uppercase tracking-[0.1em] sm:text-[12px] sm:tracking-[0.12em] md:text-[13px]">
                    <span className="text-scent-accent/85">
                      {isTodayForecastDay(activePlan.day.date) ? 'Today' : dayLabel(activePlan.day.date)}
                    </span>
                    {` · ${activeMeta.join(' · ')}`}
                  </span>
                </m.div>
              </div>
            ) : null}
          </div>

          {/* One centered "why this bottle today" line — the plain-language factor
              behind the pick (its character + the strongest real reason it was
              chosen for the day). Width-capped, balance-wrapped, and clamped to two
              lines so it stays optically centered and always fits the forecast
              column without ever crowding the day rail below. Brighter than the
              old text-scent-text-secondary so it's legible on a real phone
              outdoors; italic serif + smaller-than-name keeps it supporting copy.
              Typed on slowly (TypedReasonLine) as the last beat of the reveal. */}
          {activeReason ? <TypedReasonLine text={activeReason} /> : null}

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
            className="mx-auto mt-[var(--fc-pill-rail)] grid w-full max-w-[28.5rem] grid-cols-7 gap-1 sm:gap-2 md:max-w-[36rem] md:gap-3"
          >
            {outlook.slice(0, 7).map((plan, index) => {
              const isActive = index === selected;
              return (
                <button
                  key={plan.day.date}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls="scent-forecast-active-panel"
                  tabIndex={isActive ? 0 : -1}
                  type="button"
                  onClick={() => go(index)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') {
                      event.preventDefault();
                      go(selected + 1);
                    } else if (event.key === 'ArrowLeft') {
                      event.preventDefault();
                      go(selected - 1);
                    } else if (event.key === 'Home') {
                      event.preventDefault();
                      go(0);
                    } else if (event.key === 'End') {
                      event.preventDefault();
                      go(outlook.length - 1);
                    }
                  }}
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
      className="forecast-chevron flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-scent-accent/70 hover:text-scent-gold-200 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 md:h-[3.25rem] md:w-[3.25rem]"
    >
      {/* Glyph one px up from the last pass (19→20) — at 19 the bare arrows
          read as visually undersized against the hero (design review). The
          44px+ button keeps the full tap target either way. */}
      <Icon size={20} strokeWidth={1.5} aria-hidden className="md:h-[24px] md:w-[24px]" />
    </button>
  );
}
