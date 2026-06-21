import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { Routes, Route, useLocation, useParams, type Location } from 'react-router-dom';
import type { Fragrance } from './components/Wardrobe';
import type { BeamProposalItem } from '@/lib/beamAgentClient';
import { vaultIdentityKey } from './lib/vaultIdentity';
import { stableProposalItemId, type CurateCollectionResult } from './lib/collectionCuration';
import { getPendingCuration, curationItemToFragrance, pickResumeCurationTarget } from './lib/curationClient';
import { X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ThreadBackground, type ThreadBackgroundMode } from './components/threads/ThreadBackground';
import { AppTopNav } from './components/AppTopNav';
import { WeeklyOutlookDashboard, forecastBottleLayoutId } from './components/WeeklyOutlookDashboard';
import { AuthModal } from './components/AuthModal';
import { GuestSaveBanner, GuestModeBanner } from './components/GuestSaveBanner';
import { InstallPrompt } from './components/pwa/InstallPrompt';
import { PushPrompt } from './components/pwa/PushPrompt';
import { BadgeClearer } from './components/pwa/BadgeClearer';
import type { ScentFamily, ScentWeatherRecommendation } from './lib/scentWeatherEngine';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WeatherProvider, useWeather } from './context/WeatherContext';
import { WardrobeProvider, useWardrobe, useWardrobeItems, useWardrobeShareModalActions } from './context/WardrobeContext';
import { Toaster } from './components/ui/toaster';
import { PageTransitionOverlay, warmTransitionEmblem } from './components/PageTransitionOverlay';
import { useBodyScrollLock, useModalBehavior } from '@/hooks/use-modal-behavior';
import { useRenderBudget } from '@/hooks/useRenderBudget';
import { useMarqueeSwipe } from '@/hooks/useMarqueeSwipe';
import { isIpadSafariPerformanceMode, isLowRenderBudget } from '@/lib/platform';
import NotFound from '@/pages/not-found';
import { SEO } from './components/SEO';
import { loadRouteChunk } from '@/lib/routeChunkRecovery';
import { initWebVitals, vaultSizeBucket } from '@/lib/webVitalsTelemetry';
import { FragranceCapture } from './components/FragranceCapture';

const Wardrobe = React.lazy(() =>
  loadRouteChunk(() => import('./components/Wardrobe').then((module) => ({ default: module.Wardrobe }))),
);
// Factory is named so the same dynamic import backs both React.lazy and the
// intent/idle prefetch below — the panel chunk is warmed before the user taps
// the "Discover Your Signature Scent" CTA, so the open crossfade lands on the
// real panel instead of flashing the SignaturePanelFallback pulse on first open.
const importScentMissionPanel = () =>
  import('./components/ScentMissionPanel').then((module) => ({ default: module.ScentMissionPanel }));
const ScentMissionPanel = React.lazy(() => loadRouteChunk(importScentMissionPanel));
let scentMissionPanelPrefetched = false;
function prefetchScentMissionPanel() {
  if (scentMissionPanelPrefetched || typeof window === 'undefined') return;
  scentMissionPanelPrefetched = true;
  // Best-effort warm-up; on failure clear the flag so a later intent can retry
  // and the real open still goes through loadRouteChunk's recovery path.
  void importScentMissionPanel().catch(() => {
    scentMissionPanelPrefetched = false;
  });
}
type ScentMissionStatus = import('./components/ScentMissionPanel').ScentMissionStatus;
const ScentNotesInfographic = React.lazy(() =>
  loadRouteChunk(() => import('./components/ScentNotesInfographic').then((module) => ({ default: module.ScentNotesInfographic }))),
);
const ShareModal = React.lazy(() =>
  loadRouteChunk(() => import('./components/ShareModal').then((module) => ({ default: module.ShareModal }))),
);
const ProfileSettingsModal = React.lazy(() =>
  loadRouteChunk(() => import('./components/ProfileSettingsModal').then((module) => ({ default: module.ProfileSettingsModal }))),
);
const CommunityPage = React.lazy(() => loadRouteChunk(() => import('@/pages/community')));
const ArenaPage = React.lazy(() => loadRouteChunk(() => import('@/pages/arena')));
// Dev-only iPad-freeze diagnostic lab. Gated on import.meta.env.DEV so it is
// neither routable nor shipped in production: Vite statically replaces
// import.meta.env.DEV with `false` in prod, so this import() is dead-code-
// eliminated and the chunk never enters the bundle. Keeps the "diagnose
// off-prod, no debug overlays in prod" guidance without deleting the tool.
const IpadFreezeLab = import.meta.env.DEV
  ? React.lazy(() => loadRouteChunk(() => import('@/pages/ipad-freeze-lab')))
  : null;
const SharePage = React.lazy(() =>
  loadRouteChunk(() => import('./components/SharePage').then((module) => ({ default: module.SharePage }))),
);

const titleCaseToken = (value: string): string =>
  value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const formatFamilyList = (families: ScentFamily[]): string =>
  families.length > 0 ? families.map(titleCaseToken).join(', ') : 'Flexible';

const formatAvoidList = (families: ScentFamily[]): string =>
  families.length > 0 ? families.map(titleCaseToken).join(', ') : 'None flagged';

const formatSprayCount = (sprayCount: ScentWeatherRecommendation['spray_count']): string => {
  const plural = sprayCount.recommended === 1 ? 'spray' : 'sprays';
  if (sprayCount.min === sprayCount.max) {
    return `${sprayCount.recommended} ${plural} recommended`;
  }
  return `${sprayCount.min}-${sprayCount.max} sprays (${sprayCount.recommended} recommended)`;
};

const PAGE_TRANSITION_TIMING = {
  standard: {
    coverMs: 96,
    minShowMs: 360,
    postSwapPaintMs: 48,
  },
  lowMotion: {
    coverMs: 72,
    minShowMs: 240,
    postSwapPaintMs: 32,
  },
} as const;

const routeSignature = (location: Location): string =>
  `${location.pathname}${location.search}`;

const LiveClock: React.FC = React.memo(() => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const syncMinute = () => {
      setTime(new Date());
      interval = setInterval(() => setTime(new Date()), 60_000);
    };

    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    timeout = setTimeout(syncMinute, msUntilNextMinute);

    return () => {
      if (timeout) clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  // 12-hour clock (e.g. "7:42 PM") for the consumer-facing en-US presentation.
  // The prior 24-hour render read inconsistently against the rest of the
  // app's casual time language.
  const display = time.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' });
  // The clock sits inside a compositor-animated marquee track; WebKit can skip
  // repainting text mutations inside that cached layer. Remounting the node on
  // each minute (key) and isolating it on its own layer forces the repaint.
  return (
    <span
      key={display}
      className="font-serif italic tracking-normal text-inherit leading-[1.05] text-[#fff7ec] tabular-nums"
      style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-block', transform: 'translateZ(0)', willChange: 'transform' }}
    >
      {display}
    </span>
  );
});

interface AtmosphereBarProps {
  weather: any;
  weatherLoading: boolean;
}

const ATMOSPHERE_TRACK_COPIES_DEFAULT = 4;
const ATMOSPHERE_TRACK_COPIES_LOW = 2;
const ATMOSPHERE_SCROLL_PIXELS_PER_SECOND = 14;
const ATMOSPHERE_SCROLL_MIN_SECONDS = 72;
const ATMOSPHERE_SCROLL_MAX_SECONDS = 160;
const ATMOSPHERE_SCROLL_REDUCED_MOTION_SECONDS = 240;
const HERO_TRACK_COPIES_DEFAULT = 4;
const HERO_TRACK_COPIES_LOW = 2;
const HERO_SCROLL_PIXELS_PER_SECOND = 14;
const HERO_SCROLL_MIN_SECONDS = 60;
const HERO_SCROLL_MAX_SECONDS = 180;
const HERO_SCROLL_REDUCED_MOTION_SECONDS = 240;

function AtmospherePlaceholder({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`scent-atmosphere-placeholder${active ? '' : ' scent-atmosphere-placeholder--static'}`}
      aria-label={active ? `Loading ${label}` : `${label} unavailable`}
    />
  );
}

// A hero ticker line, split into segments so the single "key" word or number
// in each line can be highlighted on its own as it crosses the marquee center.
// Plain lines are a single keyless segment.
interface HeroPhraseSegment {
  text: string;
  /** Exactly one segment per phrase carries the gold center-sheen highlight. */
  key?: boolean;
}
type HeroPhrase = HeroPhraseSegment[];

/** Flat text of a phrase — used for React keys, aria text, and the swipe-loop reset key. */
const heroPhraseText = (phrase: HeroPhrase): string => phrase.map((segment) => segment.text).join('');

function useLowBudgetMarqueeMode(): boolean {
  return useRef(isLowRenderBudget() || isIpadSafariPerformanceMode()).current;
}

function usePauseMarqueeWhenHidden(
  sectionRef: React.RefObject<HTMLElement | null>,
  trackRef: React.RefObject<HTMLElement | null>,
  resetKey?: unknown,
): void {
  useEffect(() => {
    const section = sectionRef.current;
    const track = trackRef.current;
    if (!section || !track) return;

    let offscreen = false;
    const syncPaused = () => {
      if (offscreen || document.visibilityState === 'hidden') {
        track.dataset.marqueePaused = 'true';
      } else {
        delete track.dataset.marqueePaused;
      }
    };

    let observer: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        (entries) => {
          offscreen = entries.some((entry) => !entry.isIntersecting);
          syncPaused();
        },
        { rootMargin: '160px 0px' },
      );
      observer.observe(section);
    }

    document.addEventListener('visibilitychange', syncPaused);
    syncPaused();

    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', syncPaused);
      delete track.dataset.marqueePaused;
    };
  }, [resetKey, sectionRef, trackRef]);
}

function getHeroTickerPhrases(items: Fragrance[]): HeroPhrase[] {
  if (!items.length) {
    return [
      [{ text: 'Add scents to your vault and unlock deeper discovery' }],
      [{ text: 'Atmospheric nuance is analyzed to guide each wear' }],
      [{ text: 'Your signature profile is syncing with the current environment' }],
    ];
  }

  const phrases: HeroPhrase[] = [];

  const families = items.map(i => i.family).filter(Boolean) as string[];
  if (families.length > 0) {
    const fc: Record<string, number> = {};
    families.forEach(f => { fc[f] = (fc[f] || 0) + 1; });
    const topFamily = Object.entries(fc).sort((a, b) => b[1] - a[1])[0][0];
    phrases.push([
      { text: 'Predominantly ' },
      { text: topFamily.toLowerCase(), key: true },
      { text: ' olfactory signature' },
    ]);
  }

  const allNotes = items.flatMap(i => i.notes || []);
  if (allNotes.length > 0) {
    const nc: Record<string, number> = {};
    allNotes.forEach(n => { const k = n.toLowerCase(); nc[k] = (nc[k] || 0) + 1; });
    const [topNote, topCount] = Object.entries(nc).sort((a, b) => b[1] - a[1])[0];
    if (topCount > 1) phrases.push([
      { text: 'Recurring molecule detected: ' },
      { text: topNote, key: true },
    ]);
  }

  const vectors = items.map(i => i.scent_vector).filter(Boolean) as NonNullable<Fragrance['scent_vector']>[];
  if (vectors.length > 0) {
    const dims = ['freshness', 'sweetness', 'woodiness', 'spice', 'warmth', 'musk'] as const;
    const labels: Record<string, string> = {
      freshness: 'fresh and airy', sweetness: 'sweet and gourmand',
      woodiness: 'woody and grounded', spice: 'spiced and bold',
      warmth: 'warm and enveloping', musk: 'musky and skin-close',
    };
    const top = dims
      .map(d => ({ d, avg: vectors.reduce((s, v) => s + v[d], 0) / vectors.length }))
      .sort((a, b) => b.avg - a.avg)[0];
    if (top.avg >= 4.5) phrases.push([
      { text: 'Your vault reads ' },
      { text: labels[top.d], key: true },
    ]);
  }

  const seasons = items.map(i => i.season).filter(Boolean) as string[];
  if (seasons.length > 0) {
    const sc: Record<string, number> = {};
    seasons.forEach(s => { sc[s] = (sc[s] || 0) + 1; });
    const [topSeason, topSeasonCount] = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];
    if (topSeasonCount > 1) phrases.push([
      { text: 'Calibrated for ' },
      { text: topSeason.toLowerCase(), key: true },
      { text: ' conditions' },
    ]);
  }

  const brands = new Set(items.map(i => i.brand).filter(Boolean));
  if (brands.size > 1) phrases.push([
    // Highlight the full key detail ("43 houses"), not just the bare count, so
    // the gold sheen lands on a self-contained, meaningful tell as it crosses
    // center — matching how every other phrase highlights its whole variable.
    { text: `${brands.size} houses`, key: true },
    { text: ' represented in your collection' },
  ]);

  if (phrases.length < 3) phrases.push(
    [{ text: 'Olfactory intelligence active' }],
    [{ text: 'Atmospheric pairing in progress' }],
  );

  return phrases;
}

interface HeroMarqueeProps {
  phrases: HeroPhrase[];
}

const HeroMarquee: React.FC<HeroMarqueeProps> = React.memo(({ phrases }) => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLSpanElement>(null);
  const lowBudgetMarquee = useLowBudgetMarqueeMode();
  const trackCopies = lowBudgetMarquee ? HERO_TRACK_COPIES_LOW : HERO_TRACK_COPIES_DEFAULT;
  const phraseKey = useMemo(() => phrases.map(heroPhraseText).join('|'), [phrases]);

  useMarqueeSwipe(trackRef, {
    distanceVar: '--hero-marquee-distance',
    durationVar: '--hero-marquee-duration',
    resetKey: phraseKey,
  });
  usePauseMarqueeWhenHidden(sectionRef, trackRef, phraseKey);

  // Center-crossing sheen.
  //
  // Each phrase's key word/number (`.scent-marquee-key`) gets the gold sheen
  // sweep — the same treatment the brand labels use — but only at the moment
  // it passes the horizontal center of the screen (where the bottom-nav pill
  // sits). We detect that with an IntersectionObserver whose root is shrunk to
  // a thin vertical strip at viewport center via a negative left/right
  // rootMargin. This is event-driven (no per-frame getBoundingClientRect), so
  // it stays cheap even with several key words and the four looped track
  // copies.
  //
  // Per-device notes — this must keep working identically everywhere:
  //   • All engines: IntersectionObserver reports CSS-transform motion (the
  //     marquee scroll), so the strip-crossing fires reliably. The strip is a
  //     non-zero ~2% width (a true 0-width root never reports isIntersecting).
  //   • The marquee cruises at ~14px/s, so a key word dwells in the strip for
  //     well over the 1.9s sweep on every viewport size — no missed frames.
  //   • iOS/iPadOS Safari: WebKit fires IO callbacks on its compositor cadence;
  //     the class toggle below only flips a CSS animation, never reads layout,
  //     so it cannot stall the scroll or fight useMarqueeSwipe's transforms.
  //   • Reduced motion: skipped entirely (the sheen keyframes are also gated by
  //     `prefers-reduced-motion` in CSS), matching the brand-label behavior.
  // Re-runs whenever the phrase set changes (the key nodes are recreated).
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const keyNodes = Array.from(track.querySelectorAll<HTMLElement>('.scent-marquee-key'));
    if (!keyNodes.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Toggle a one-shot animation class as the word enters/leaves the
          // center strip, so it re-sheens cleanly on every loop pass.
          entry.target.classList.toggle('scent-marquee-key--lit', entry.isIntersecting);
        }
      },
      { root: null, rootMargin: '0px -49% 0px -49%', threshold: 0 },
    );
    keyNodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [phraseKey]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const group = groupRef.current;
    if (!track || !group) return;
    let cancelled = false;
    let animationFrame = 0;
    let pendingReady = false;

    const updateDistance = (ready = true) => {
      if (cancelled) return;
      const distance = group.getBoundingClientRect().width;
      if (distance <= 0) return;

      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = prefersReducedMotion
        ? HERO_SCROLL_REDUCED_MOTION_SECONDS
        : Math.min(
            HERO_SCROLL_MAX_SECONDS,
            Math.max(HERO_SCROLL_MIN_SECONDS, distance / HERO_SCROLL_PIXELS_PER_SECOND),
          );

      track.style.setProperty('--hero-marquee-distance', `${distance}px`);
      track.style.setProperty('--hero-marquee-duration', `${duration}s`);
      if (ready) {
        track.dataset.marqueeReady = 'true';
      }
    };

    const scheduleDistanceUpdate = (ready = true) => {
      pendingReady = pendingReady || ready;
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        const readyForFrame = pendingReady;
        pendingReady = false;
        updateDistance(readyForFrame);
      });
    };

    if (track.dataset.marqueeReady !== 'true') {
      track.dataset.marqueeReady = 'false';
    }

    const startWhenFontsSettle = () => scheduleDistanceUpdate(true);

    if (document.fonts?.ready) {
      document.fonts.ready.then(startWhenFontsSettle);
    } else {
      startWhenFontsSettle();
    }

    const handleResize = () => scheduleDistanceUpdate(track.dataset.marqueeReady === 'true');
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(group);
    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      cancelled = true;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [phraseKey]);

  return (
    <div ref={sectionRef} className="scent-marquee-band scent-full-bleed w-full overflow-hidden py-[8px] sm:py-[12px] flex select-none relative">
      <div ref={trackRef} className="scent-marquee-track-row whitespace-nowrap scent-marquee-text">
        {[...Array(trackCopies)].map((_, copyIndex) => (
          <span
            key={copyIndex}
            ref={copyIndex === 0 ? groupRef : undefined}
            className="scent-marquee-phrase-group flex items-center"
            aria-hidden={copyIndex > 0}
          >
            {phrases.map((phrase, phraseIndex) => (
              <React.Fragment key={`${phraseIndex}:${heroPhraseText(phrase)}`}>
                <span className="scent-marquee-phrase whitespace-nowrap">
                  {phrase.map((segment, segmentIndex) =>
                    segment.key ? (
                      // The center-sheen target; data-text drives the gold
                      // gradient overlay (see .scent-marquee-key in index.css).
                      <span
                        key={segmentIndex}
                        className="scent-marquee-key"
                        data-text={segment.text}
                      >
                        {segment.text}
                      </span>
                    ) : (
                      <React.Fragment key={segmentIndex}>{segment.text}</React.Fragment>
                    ),
                  )}
                </span>
                {phraseIndex < phrases.length - 1 ? (
                  <span className="scent-marquee-divider shrink-0" aria-hidden="true" />
                ) : null}
              </React.Fragment>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
});

const AtmosphereBar: React.FC<AtmosphereBarProps> = React.memo(({
  weather,
  weatherLoading,
}) => {
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const lowBudgetMarquee = useLowBudgetMarqueeMode();
  const trackCopies = lowBudgetMarquee ? ATMOSPHERE_TRACK_COPIES_LOW : ATMOSPHERE_TRACK_COPIES_DEFAULT;

  useMarqueeSwipe(trackRef, {
    distanceVar: '--atmosphere-marquee-distance',
    durationVar: '--atmosphere-marquee-duration',
  });

  const firstFiniteNumber = (fallback: number, ...values: unknown[]): number => {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return fallback;
  };

  const firstString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };

  const getWeatherNumber = (
    w: any,
    keys: string[],
    fallback: number,
  ): number => firstFiniteNumber(fallback, ...keys.map((key) => w?.[key]));

  const getWeatherString = (
    w: any,
    keys: string[],
    fallback = '',
  ): string => firstString(...keys.map((key) => w?.[key])) ?? fallback;

  const tempValue = getWeatherNumber(weather, ['temperature_f', 'temperature', 'temp'], Number.NaN);
  const humidityValue = getWeatherNumber(weather, ['humidity_percent', 'humidity'], Number.NaN);
  const pendingWeather = weatherLoading && !weather;
  const tempMissing = !Number.isFinite(tempValue);
  const humidityMissing = !Number.isFinite(humidityValue);
  const conditionText = getWeatherString(weather, ['condition', 'description']);
  const locationText = firstString(weather?.location);
  const temp = pendingWeather || tempMissing
    ? <AtmospherePlaceholder label="temperature" active={pendingWeather} />
    : `${Math.round(tempValue)}°F`;
  const condition = pendingWeather || !conditionText
    ? <AtmospherePlaceholder label="conditions" active={pendingWeather} />
    : titleCaseToken(conditionText);
  const humidity = pendingWeather || humidityMissing
    ? <AtmospherePlaceholder label="humidity" active={pendingWeather} />
    : `${humidityValue}%`;
  const location = pendingWeather || !locationText
    ? <AtmospherePlaceholder label="location" active={pendingWeather} />
    : locationText;
  const atmosphereDisplayKey = [
    pendingWeather ? 'pending' : 'ready',
    tempMissing ? 'temp-missing' : `temp:${Math.round(tempValue)}`,
    humidityMissing ? 'humidity-missing' : `humidity:${humidityValue}`,
    conditionText || 'condition-missing',
    locationText || 'location-missing',
  ].join('|');
  usePauseMarqueeWhenHidden(sectionRef, trackRef, atmosphereDisplayKey);
  const metrics = [
    { label: 'Conditions', value: condition },
    { label: 'Humidity', value: humidity },
    { label: 'Time', value: <LiveClock /> },
    { label: 'Temperature', value: temp },
    { label: 'Location', value: location },
  ];

  useEffect(() => {
    const track = trackRef.current;
    const group = groupRef.current;
    if (!track || !group) return;
    let cancelled = false;
    let animationFrame = 0;
    let pendingReady = false;

    const updateDistance = (ready = true) => {
      if (cancelled) return;
      const distance = group.getBoundingClientRect().width;
      if (distance <= 0) return;

      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = prefersReducedMotion
        ? ATMOSPHERE_SCROLL_REDUCED_MOTION_SECONDS
        : Math.min(
            ATMOSPHERE_SCROLL_MAX_SECONDS,
            Math.max(ATMOSPHERE_SCROLL_MIN_SECONDS, distance / ATMOSPHERE_SCROLL_PIXELS_PER_SECOND),
          );

      track.style.setProperty('--atmosphere-marquee-distance', `${distance}px`);
      track.style.setProperty('--atmosphere-marquee-duration', `${duration}s`);
      if (ready) {
        track.dataset.marqueeReady = 'true';
      }
    };

    const scheduleDistanceUpdate = (ready = true) => {
      pendingReady = pendingReady || ready;
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        const readyForFrame = pendingReady;
        pendingReady = false;
        updateDistance(readyForFrame);
      });
    };

    if (track.dataset.marqueeReady !== 'true') {
      track.dataset.marqueeReady = 'false';
    }

    const startWhenFontsSettle = () => scheduleDistanceUpdate(true);

    if (document.fonts?.ready) {
      document.fonts.ready.then(startWhenFontsSettle);
    } else {
      startWhenFontsSettle();
    }

    const handleResize = () => scheduleDistanceUpdate(track.dataset.marqueeReady === 'true');
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(group);
    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      cancelled = true;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [atmosphereDisplayKey]);

  return (
    <section ref={sectionRef} className="scent-atmosphere-marquee relative" aria-label="Current atmosphere" aria-busy={pendingWeather}>
      <div className="scent-atmosphere-marquee-track" ref={trackRef}>
        {[...Array(trackCopies)].map((_, copyIndex) => (
          <div
            className="scent-atmosphere-marquee-group"
            key={copyIndex}
            ref={copyIndex === 0 ? groupRef : undefined}
            aria-hidden={copyIndex > 0}
          >
            {metrics.map((metric) => (
              <div key={metric.label} className="scent-atmosphere-marquee-cell">
                <span className="scent-atmosphere-label">
                  <span className="scent-atmosphere-label-text">{metric.label}</span>
                </span>
                <span className="scent-atmosphere-value">{metric.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
});

const HomepageHeroMarquee: React.FC = React.memo(() => {
  const items = useWardrobeItems();
  const tickerPhrases = useMemo(() => getHeroTickerPhrases(items), [items]);

  return <HeroMarquee phrases={tickerPhrases} />;
});

const HomepageAtmosphereChrome: React.FC = React.memo(() => {
  const { weather, weatherLoading } = useWeather();

  return (
    <div className="scent-full-bleed">
      <AtmosphereBar
        weather={weather}
        weatherLoading={weatherLoading}
      />
    </div>
  );
});

function HeroVaultContentFallback() {
  return (
    <div className="relative w-full min-w-0" aria-label="Loading fragrance search">
      <div className="mx-auto mb-6 h-24 max-w-[38rem] animate-pulse rounded-[var(--radius-scent)] bg-white/[0.035] sm:mb-7" />
      <div className="scent-lux-input mx-auto h-[60px] w-full max-w-[42.75rem] animate-pulse rounded-[var(--radius-scent)] sm:h-[68px]" />
    </div>
  );
}

// Matches the opened signature section's first row (input capsule + close) so a
// first-time chunk load swaps in without shifting the input's position.
function SignaturePanelFallback() {
  return (
    <div className="flex w-full items-center gap-2" aria-label="Loading signature scent">
      <div className="scent-lux-input h-[60px] flex-1 animate-pulse rounded-full sm:h-[68px]" />
      <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-white/[0.05]" />
    </div>
  );
}

function WardrobeFallback() {
  return (
    <section className="mx-auto w-full max-w-[1400px] py-10" aria-label="Loading vault">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="min-h-[24rem] rounded-[var(--radius-scent)] border border-scent-accent/12 bg-black/32"
          />
        ))}
      </div>
    </section>
  );
}

function DashboardView() {
  const location = useLocation();
  const { authToken, authEmail, authPictureUrl, authUsername, handleSignOut, setIsAuthModalOpen, setIsProfileModalOpen } = useAuth();
  const { weather } = useWeather();
  const {
    items,
    wardrobeLoaded,
    onboardingCompleted,
    onboardingResolved,
    wardrobeError,
    retryLoadWardrobe,
    activeRecommendation,
    activeEngineRecommendation,
    recommendationReason,
    wardrobeRevertSnapshot,
    wardrobeFixBusy,
    wardrobeFixHint,
    vaultSearchUiActive,
    isImageSyncing,
    isAdmin,
    setIsShareModalOpen,
    setActiveRecommendation,
    setActiveEngineRecommendation,
    setRecommendationReason,
    handleAddItem,
    handlePersistWardrobeImage,
    handleVerifyWardrobeFact,
    uploadAdminBottleImage,
    handleRevertWardrobe,
    handleDeleteItem,
    closeRecommendationOverlay,
    handleVaultSearchStateChange,
    handleExpandArchive,
    pendingDetailOpen,
    pendingDetailOpenSourceLayoutId,
    openFragranceDetail,
    clearPendingDetailOpen,
  } = useWardrobe();
  const reduceMotion = useReducedMotion();
  // framer-motion `layout` (FLIP) animations measure getBoundingClientRect and
  // apply compensating transforms. On iOS/iPadOS WebKit, running them on the
  // Beam Agent open/close — especially as the body scroll-lock is torn down —
  // produces blank/gray frames and compositor stalls. `layout` was previously
  // gated only on the OS reduce-motion flag (false by default), so it ran at
  // full fidelity on every phone/tablet. Treat low-render-budget and iPad-Safari
  // as "calm" too, so those devices get a plain crossfade instead of FLIP.
  const calmLayout =
    reduceMotion || isLowRenderBudget() || isIpadSafariPerformanceMode();
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);
  // Track Tailwind's `sm` breakpoint so the Beam Agent header can animate its
  // exact pull-up margins to zero on close. framer needs the explicit
  // (responsive) margin values to collapse the header's height + margins in step
  // with the card crossfade — otherwise the header keeps its space during the
  // fade and the search card / cues / CTA snap upward afterward (the old
  // "push up at the end" on close).
  const [isSmUp, setIsSmUp] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 640px)');
    const onChange = (event: MediaQueryListEvent) => setIsSmUp(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const missionHeaderMargins = isSmUp
    ? { marginTop: '0', marginBottom: '0.75rem' }
    : { marginTop: '0', marginBottom: '0.625rem' };
  const [viewState, setViewState] = useState<'search' | 'agent'>('search');
  // Beam Agent progress surfaced by the panel so its header (title + progress +
  // close) can render in a strip ABOVE the bordered card instead of inside it.
  const [missionStatus, setMissionStatus] = useState<ScentMissionStatus | null>(null);
  // Host element rendered BELOW the card; the Beam Agent portals its impressions
  // lane here so the cues sit under the card instead of crowding it.
  const [missionCueHost, setMissionCueHost] = useState<HTMLDivElement | null>(null);
  const handleMissionStatus = useCallback((status: ScentMissionStatus) => {
    setMissionStatus(status);
  }, []);
  const handleExitMission = useCallback(() => {
    setViewState('search');
    setMissionStatus(null);
  }, []);
  const heroVaultRef = useRef<HTMLDivElement | null>(null);
  const signatureSectionRef = useRef<HTMLDivElement | null>(null);
  const recommendationOverlayRef = useRef<HTMLDivElement | null>(null);
  const recommendationCloseRef = useRef<HTMLButtonElement | null>(null);

  const handleMissionReveal = useCallback(
    (item: Fragrance, engine: ScentWeatherRecommendation, reason: string) => {
      setActiveEngineRecommendation(engine);
      setRecommendationReason(reason);
      setActiveRecommendation(item);
    },
    [setActiveEngineRecommendation, setActiveRecommendation, setRecommendationReason],
  );

  // Add a Beam-proposed collection to the vault through the NORMAL wardrobe path
  // (same handleAddItem a search-result add uses), then actively sync each image
  // so the agent can hold a "curating" state until the bottle is ready. Reports
  // per-item progress back to the panel. The agent never writes — this runs only
  // after the user taps Confirm in the proposal card.
  const handleCurateCollection = useCallback(
    async (
      collectionItems: BeamProposalItem[],
      onProgress: (progress: {
        index: number;
        total: number;
        name: string;
        status: 'adding' | 'curating' | 'ready' | 'failed';
      }) => void,
    ): Promise<CurateCollectionResult> => {
      const total = collectionItems.length;
      let added = 0;
      const failedItems: BeamProposalItem[] = [];
      for (let index = 0; index < total; index++) {
        const item = collectionItems[index];
        const generatedId = stableProposalItemId(item);
        const built: Record<string, unknown> = {
          id: generatedId,
          name: item.name,
          brand: item.brand,
          imageUrl: item.imageUrl ?? '',
          season: 'Universal',
        };
        if (item.family) built.family = item.family;
        if (item.notes?.length) built.notes = item.notes;
        if (item.pyramid) built.pyramid = item.pyramid;
        if (item.accords?.length) built.accords = item.accords;
        if (item.scentVector) built.scent_vector = item.scentVector;
        if (item.performance) built.performance = item.performance;
        if (item.concentration) built.concentration = item.concentration;
        if (item.storagePath) built.storagePath = item.storagePath;
        if (item.imageHash) built.imageHash = item.imageHash;
        if (item.storageProvider) built.storageProvider = item.storageProvider;
        if (item.sourceProvider) built.sourceProvider = item.sourceProvider;
        if (item.description) built.description = item.description;

        onProgress({ index, total, name: item.name, status: 'adding' });
        const result = await handleAddItem(built).catch(() => ({ persisted: false }));
        if (!result.persisted) {
          failedItems.push(item);
          onProgress({ index, total, name: item.name, status: 'failed' });
          continue;
        }
        added++;
        const hasImage =
          typeof built.imageUrl === 'string' && (built.imageUrl as string).trim().length > 0;
        if (!hasImage) {
          // No catalog image rode along — actively trigger the image pipeline and
          // wait for it (this is the "curating" hold the user sees).
          onProgress({ index, total, name: item.name, status: 'curating' });
          await handlePersistWardrobeImage(built as unknown as Fragrance, undefined, undefined, {
            suppressToast: true,
          }).catch(() => null);
        }
        onProgress({ index, total, name: item.name, status: 'ready' });
      }
      return { added, total, failedItems };
    },
    [handleAddItem, handlePersistWardrobeImage],
  );

  useModalBehavior({
    isOpen: Boolean(activeRecommendation),
    containerRef: recommendationOverlayRef,
    initialFocusRef: recommendationCloseRef,
    onDismiss: closeRecommendationOverlay,
  });

  // A completed user (durable server flag, or >= 3 saved) is discovery-ready even
  // while the wardrobe is still hydrating or temporarily empty. The add-3 steps
  // only appear for genuine new users who have not completed onboarding.
  //
  // `stateSettled` keeps the hero area as a stable shell (no add-3 steps, no
  // locked CTA) until onboarding state is known for a signed-in user, so a
  // returning completed user on a fresh device never flashes the add-3 ordeal.
  const stateSettled = !authToken || onboardingResolved;
  const discoveryReady = onboardingCompleted || items.length >= 3;
  const agentActive = viewState === 'agent';
  const vaultContentTransition = reduceMotion
    ? { duration: 0.01 }
    : { duration: 0.42, ease: [0.16, 1, 0.3, 1] as const };

  useBodyScrollLock(agentActive);

  useEffect(() => {
    if (!discoveryReady && viewState === 'agent') {
      setViewState('search');
    }
  }, [discoveryReady, viewState]);

  useEffect(() => {
    if (viewState !== 'agent') return;
    // The Beam Agent replaces the search card inside the hero box, so bring that
    // box into view on open. `block: 'nearest'` avoids a hard page jump.
    const id = window.requestAnimationFrame(() => {
      heroVaultRef.current?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'nearest',
      });
    });
    return () => window.cancelAnimationFrame(id);
  }, [reduceMotion, viewState]);

  const handleOpenMission = useCallback(() => {
    setViewState('agent');
  }, []);

  // Warm the Beam Agent chunk during idle time once the Discover CTA is actually
  // reachable, so touch users (no hover to prefetch on) get an instant, flash-free
  // open. Runs at most once per session via the module-level guard; degrades to a
  // short timeout where requestIdleCallback is unavailable (Safari/older WebKit).
  useEffect(() => {
    if (agentActive || scentMissionPanelPrefetched) return;
    if (!(discoveryReady && stateSettled && !vaultSearchUiActive)) return;
    const ric = (window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    });
    if (typeof ric.requestIdleCallback === 'function') {
      const handle = ric.requestIdleCallback(prefetchScentMissionPanel, { timeout: 2000 });
      return () => ric.cancelIdleCallback?.(handle);
    }
    const id = window.setTimeout(prefetchScentMissionPanel, 1200);
    return () => window.clearTimeout(id);
  }, [agentActive, discoveryReady, stateSettled, vaultSearchUiActive]);

  // Brand+name identities of saved fragrances, so the search overlay can flag
  // results that are already in the vault and offer "View in vault" instead of a
  // silent duplicate add.
  const vaultIdentityKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of items) {
      const key = vaultIdentityKey(item.brand ?? item.product?.brand, item.name ?? item.product?.name);
      if (key) keys.add(key);
    }
    return keys;
  }, [items]);

  // "View in vault" on an already-saved search result. Rather than dumping the
  // user at the top of the vault to hunt for the fragrance themselves, resolve
  // the exact saved item by its brand+name identity and open its detail — the
  // same path used by Beam proposals and curation deep-links, which also handles
  // scrolling the (lazy) vault section into view. Falls back to a plain scroll
  // when the match can't be resolved (e.g. identity drift between catalogs).
  const handleViewVault = useCallback(
    (match?: { brand?: string | null; house?: string | null; name?: string | null }) => {
      const targetKey = match ? vaultIdentityKey(match.brand ?? match.house, match.name) : '';
      const targetItem = targetKey
        ? items.find(
            (it) =>
              vaultIdentityKey(it.brand ?? it.product?.brand, it.name ?? it.product?.name) ===
              targetKey,
          )
        : undefined;
      if (targetItem) {
        openFragranceDetail(targetItem);
        return;
      }
      document
        .getElementById('scent-vault-section')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [items, openFragranceDetail],
  );

  // Resume-on-return: when a signed-in user opens the app — especially via the
  // completion push deep-link `/?curation=<jobKey>` (see the SW's notificationclick
  // → data.url) — fetch their pending/ready beam curations and surface the ready
  // one by opening its detail card (where "Add to vault" is offered). This runs
  // once per token; it degrades to a no-op when nothing is ready or the request
  // fails (the client returns []). We strip the `?curation` param afterward via
  // history.replaceState so a reload doesn't re-trigger and React Router's page
  // transition is not disturbed. Guarded by a ref so re-renders don't re-fetch.
  const resumeCurationToken = location.search;
  const curationResumeHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authToken) return;
    const guardKey = `${authToken}:${resumeCurationToken}`;
    if (curationResumeHandledRef.current === guardKey) return;
    curationResumeHandledRef.current = guardKey;

    let cancelled = false;
    const jobKey = new URLSearchParams(resumeCurationToken).get('curation');

    void (async () => {
      const items = await getPendingCuration(authToken);
      if (cancelled) return;

      // Always clear the deep-link param once we've handled this open, so a
      // refresh is clean whether or not anything was ready.
      if (jobKey && typeof window !== 'undefined' && window.history?.replaceState) {
        const url = new URL(window.location.href);
        url.searchParams.delete('curation');
        window.history.replaceState(window.history.state, '', url.toString());
      }

      const target = pickResumeCurationTarget(items, jobKey);
      if (target) openFragranceDetail(curationItemToFragrance(target));
    })();

    return () => {
      cancelled = true;
    };
  }, [authToken, resumeCurationToken, openFragranceDetail]);

  // iOS PWA standalone mode reports viewport/safe-area differently than Safari;
  // keep this shell padding tied to --bottomnav-h so fixed nav content has space.
  return (
    <div className="min-h-[100svh] relative overflow-x-hidden pb-[calc(var(--bottomnav-h)+2rem)] md:pb-0">
      <SEO title="ScentBeam — Your scent, perfected" description="Build your fragrance vault and discover your signature scent, calibrated to the weather around you." url="https://scentbeam.com/" />
      <AppTopNav
        authToken={authToken}
        authEmail={authEmail}
        authPictureUrl={authPictureUrl}
        authUsername={authUsername}
        renderedRoute="home"
        agentActive={agentActive}
        suppressBottomNav={vaultSearchUiActive}
        onSignIn={() => setIsAuthModalOpen(true)}
        onShare={() => setIsShareModalOpen(true)}
        onSignOut={handleSignOut}
        onEditProfile={() => setIsProfileModalOpen(true)}
      />

      <div style={{ height: 'var(--topbar-h)' }} />

      <main className="relative z-10 px-4 sm:px-8 sm:pb-24 max-w-[1760px] mx-auto">
        {/* Home — first viewport. On phones this column fills the space below the
            top bar (min-h = 100svh − topbar) and reserves the floating tab bar as
            real bottom PADDING (bottomnav-h + breathing room). Padding — not a
            min-height-only calc — is what guarantees the calendar clears the nav:
            when the stacked content is taller than the viewport, my-auto's free
            space collapses to zero, so a min-height alone would let the last row
            (the calendar's weather glyphs) flow under the fixed nav. The pb holds
            that gap open regardless of overflow. On md+ (no bottom nav) the
            min-height + padding relax to the original stacked rhythm. The Vault of
            Aromas is no longer part of this screen — it lives one scroll down as
            the "second page". */}
        <div className="flex min-h-[calc(100svh-var(--topbar-h))] flex-col gap-4 pt-0 pb-[calc(var(--bottomnav-h)+0.5rem)] sm:min-h-0 sm:gap-12 sm:pt-0 sm:pb-0">
          {/* The hero ticker sits flush against the fixed top bar (no padding
              above it) so it visually replaces the bar's old bottom hairline. */}
          <HomepageHeroMarquee />

          <section className="relative mx-auto w-full max-w-[60rem] min-w-0 text-center">
            {/* Beam Agent header strip — title, progress, and close live ABOVE
                the bordered card so the card itself only holds the conversation
                and composer. Mounted only in agent mode. */}
            {/* popLayout pops the header out of flow the instant it closes, so
                the search card + lower actions (both layout-tracked) slide up to
                fill the gap in the SAME pass the header fades — instead of the
                header holding its full height through the fade and then snapping
                everything upward once it finally unmounts. */}
            <AnimatePresence initial={false} mode="popLayout">
              {agentActive ? (
                <motion.div
                  key="mission-header"
                  initial={reduceMotion ? false : { opacity: 0, y: 6, ...missionHeaderMargins }}
                  animate={{ opacity: 1, y: 0, ...missionHeaderMargins }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
                  transition={vaultContentTransition}
                  // The pull-up margins (toward the hero marquee, so the agent
                  // does not open with a dead gap above "A scent for today.")
                  // live in framer values rather than classes so that on close
                  // the header collapses its own height AND margins to zero in
                  // step with the card crossfade. overflow-hidden clips the
                  // content as it collapses, so the search card, cues, and CTA
                  // rise in a single continuous motion instead of snapping up
                  // after the fade completes.
                  style={{ overflow: 'hidden' }}
                  className="mx-auto w-full max-w-[52rem] px-1"
                >
                  {/* min-h holds the absolutely-positioned close button fully
                      inside the header's clipped (overflow-hidden) box, so the
                      top of the X is not shaved off. */}
                  {/* The progress bar that used to sit here was driven by the
                      scripted mission tree, which the live chat agent never
                      advances — so it sat near-empty and tracked nothing real.
                      It's been removed; the calm status line below ("A scent for
                      today." + phase) is the honest progress signal. The wrapper
                      stays to hold the absolutely-positioned close button. */}
                  <div className="relative mb-2 flex min-h-11 items-center justify-center">
                    {/* The X is paired with a visible "Close" label so the
                        affordance reads as an explicit, non-destructive exit
                        back to search — not a bare ambiguous glyph. The label
                        rides alongside the X at every width (it is short enough
                        not to crowd the SE-class header). */}
                    <button
                      type="button"
                      onClick={handleExitMission}
                      // touch-manipulation drops the iOS tap delay and stops the
                      // tap from being read as a scroll-start during the busy
                      // close frame, so a single tap reliably triggers the exit.
                      style={{ touchAction: 'manipulation' }}
                      className="absolute right-0 top-1/2 inline-flex min-h-11 -translate-y-1/2 items-center justify-center gap-1.5 rounded-full px-3 text-scent-text-subtle transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
                      aria-label="Close and return to fragrance search"
                    >
                      <X size={18} strokeWidth={1.75} aria-hidden />
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em]">Close</span>
                    </button>
                  </div>
                  <h2 className="mx-auto max-w-[32rem] text-balance font-serif italic text-[clamp(1.4rem,3.4vw,1.9rem)] leading-[1.05] tracking-normal text-[#fff7ec] drop-shadow-[0_4px_14px_rgba(0,0,0,0.72)]">
                    {missionStatus?.headerTitle ?? 'A scent for today.'}
                  </h2>
                  <p className="mt-1.5 scent-type-label text-scent-accent/55">
                    {missionStatus?.progressText ?? 'Tell me about your day'}
                  </p>
                  <p className="mx-auto mt-1 hidden max-w-xl text-sm leading-6 text-scent-text-muted sm:block">
                    {missionStatus?.contextLine ?? 'Weather context ready when available'}
                  </p>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {/* The hero box holds EITHER the fragrance-search card OR the
                signature-scent Beam Agent — never both. Opening the agent
                replaces the search card in place, so the card's details are not
                duplicated above the panel; closing (the header X) returns the
                search card. */}
            <motion.div
              ref={heroVaultRef}
              layout={isMounted ? !calmLayout : false}
              transition={vaultContentTransition}
              className="scent-vault-panel w-full min-w-0 relative overflow-hidden"
              style={{ scrollMarginTop: 'calc(var(--topbar-h) + 1rem)' }}
              data-view-state={viewState}
            >
              <div className="scent-vault-panel-inner min-w-0">
                {/* popLayout pops the outgoing surface out of flow so the panel
                    resizes in a single smooth stage while the two views
                    crossfade — instead of the old wait-mode swap, which let the
                    card visibly grow/bounce after the fade completed. */}
                <AnimatePresence initial={false} mode="popLayout">
                  {agentActive ? (
                    <motion.div
                      key="agent"
                      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                      transition={vaultContentTransition}
                    >
                      <React.Suspense fallback={<SignaturePanelFallback />}>
                        <ScentMissionPanel
                          items={items}
                          weather={weather}
                          authToken={authToken}
                          onExit={handleExitMission}
                          onRevealMatch={handleMissionReveal}
                          onViewProposalItem={openFragranceDetail}
                          onStatusChange={handleMissionStatus}
                          cueBarContainer={missionCueHost}
                          onCurateCollection={handleCurateCollection}
                        />
                      </React.Suspense>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="search"
                      initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                      transition={vaultContentTransition}
                    >
                      <FragranceCapture
                        onAdd={handleAddItem}
                        onVaultSearchStateChange={handleVaultSearchStateChange}
                        existingVaultKeys={vaultIdentityKeys}
                        onViewVault={handleViewVault}
                        embeddedInVaultPanel
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>

            {/* One stable lower action slot owns both states: search mode shows
                the Discover CTA, agent mode hosts the portaled cue / Confirm
                lane. Keeping the slot mounted prevents the CTA and card from
                visibly reattaching on close. */}
            {(agentActive || (discoveryReady && stateSettled && !vaultSearchUiActive)) ? (
              <motion.div
                ref={signatureSectionRef}
                layout={isMounted ? !calmLayout : false}
                transition={vaultContentTransition}
                className="scent-mission-action-slot mt-2 flex min-h-[46px] justify-center sm:mt-4 sm:min-h-[60px]"
              >
                {/* Stable portal host for the Beam Agent cue / Confirm lane.
                    This element stays mounted for the whole time the action slot
                    is shown (it is merely hidden in search mode) instead of being
                    swapped in/out inside the AnimatePresence below. The panel
                    injects an owned portal node into THIS element, so keeping the
                    host mounted across the close means the panel's portal
                    teardown can never race a host that unmounts in a SEPARATE
                    AnimatePresence — that race was the cross-tree `removeChild`
                    exception that tripped the ErrorBoundary ("System Disruption"
                    / reload) and left the body-scroll lock stuck (frozen page) on
                    close, across every browser. Cue entrance/exit is animated by
                    the portaled content itself, so no motion is lost. The host is
                    pulled out of flow when hidden so the Discover CTA still
                    centers in search mode. */}
                <div
                  ref={setMissionCueHost}
                  className={`w-full ${agentActive ? '' : 'hidden'}`}
                  aria-hidden={!agentActive}
                />
                <AnimatePresence initial={false} mode="popLayout">
                  {agentActive ? null : (
                    <motion.button
                      key="signature-cta"
                      type="button"
                      onClick={handleOpenMission}
                      onPointerEnter={prefetchScentMissionPanel}
                      onFocus={prefetchScentMissionPanel}
                      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                      transition={vaultContentTransition}
                      className="scent-signature-cta group flex h-[46px] w-full max-w-[52rem] items-center justify-center rounded-full px-6 text-[11.5px] font-bold uppercase tracking-[0.11em] text-scent-accent focus-visible:outline-none sm:h-[60px] sm:text-[13px] sm:tracking-[0.14em]"
                      aria-label="Discover with Beam Agent"
                      title="Discover with Beam Agent"
                    >
                      {/* No leading icon — the label is the sole content so it
                          centers in the pill. The text-indent equals the
                          letter-spacing so the trailing tracking gap doesn't pull
                          the glyphs optically left of center. */}
                      <span className="[text-indent:0.11em] sm:[text-indent:0.14em]">Discover With Beam Agent</span>
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>
            ) : null}
          </section>

          {!agentActive ? <HomepageAtmosphereChrome /> : null}

          {/* Weekly outlook dashboard — on phones it CENTERS in the leftover
              column space (my-auto splits the free space evenly above and below
              instead of mt-auto dumping it all into one void above), so the
              forecast reads as intentionally placed and balanced rather than
              slammed against the tab bar with a dead gap overhead. Normal flow on
              md+. Hidden in agent mode, which takes over the hero. */}
          {!agentActive ? (
            // Split the leftover column height EVENLY above and below the
            // forecast (my-auto) instead of dumping all of it below (mb-auto),
            // which left a giant dead gap between the date cards and the fixed
            // bottom nav. The even split pulls the date-card row down toward the
            // nav so the lower rhythm reads intentionally tight rather than
            // stretched. Normal flow on md+ (no bottom nav).
            <div className="my-auto sm:my-0">
              <WeeklyOutlookDashboard
                items={items}
                weather={weather}
                onSelectFragrance={(item) => openFragranceDetail(item, {
                  sourceLayoutId: forecastBottleLayoutId(item.id),
                  scrollToVault: false,
                })}
              />
            </div>
          ) : null}
        </div>

        {/* Page two: the Vault of Aromas, reached by scrolling one screen down
            from the home view above. */}
        <div id="scent-vault-section" className="scent-deferred-section !mt-16 sm:!mt-72 lg:!mt-96" style={{ scrollMarginTop: 'var(--topbar-h)' }}>
            <React.Suspense fallback={<WardrobeFallback />}>
              <Wardrobe
                items={items}
                onDelete={handleDeleteItem}
                onAdd={handleAddItem}
                pendingDetailOpen={pendingDetailOpen}
                pendingDetailOpenSourceLayoutId={pendingDetailOpenSourceLayoutId}
                onClearPendingDetailOpen={clearPendingDetailOpen}
                onPersistWardrobeImage={handlePersistWardrobeImage}
                onVerifyWardrobeFact={handleVerifyWardrobeFact}
                isAdmin={isAdmin}
                onUploadBottleImage={authToken && isAdmin ? uploadAdminBottleImage : undefined}
                featuredItem={activeRecommendation}
                onRevertWardrobe={handleRevertWardrobe}
                fixWardrobeBusy={wardrobeFixBusy}
                revertAvailable={!!wardrobeRevertSnapshot}
                wardrobeFixHint={wardrobeFixHint}
                onExpandArchive={handleExpandArchive}
                authToken={authToken}
                wardrobeLoaded={wardrobeLoaded}
                wardrobeError={wardrobeError}
                onRetryLoadWardrobe={retryLoadWardrobe}
                isImageSyncing={isImageSyncing}
              />
            </React.Suspense>
          </div>
      </main>

      {activeRecommendation ? (
          <div
            ref={recommendationOverlayRef}
            key="recommendation-overlay"
            className="fixed inset-0 z-[110] bg-black/95 flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recommendation-overlay-title"
          >
            {/* Pinned top bar — X always visible */}
            <div
              className="flex items-center justify-between px-5 pb-4 shrink-0"
              style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}
            >
              <p className="scent-type-label text-scent-accent">Strategic Alignment Found</p>
              <button ref={recommendationCloseRef} type="button" onClick={closeRecommendationOverlay} className="-m-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-scent-text-subtle hover:text-white hover:bg-white/10 transition-all active:scale-95" aria-label="Close recommendation">
                <X size={20} strokeWidth={1.75} />
              </button>
            </div>

            {/* Scrollable middle */}
            <div className="flex-1 overflow-y-auto">
              <div className="flex items-center justify-center min-h-full px-5 py-6 sm:px-16 sm:py-12">
                <div className="max-w-2xl w-full text-center space-y-6 sm:space-y-12">
                  <header>
                    <h2 id="recommendation-overlay-title" className="font-serif italic text-2xl sm:text-6xl mb-4">You should wear</h2>
                    <div className="h-px w-16 bg-white/20 mx-auto" />
                  </header>
                  <button
                    type="button"
                    className="w-full py-6 sm:py-16 border-y border-white/10 group cursor-pointer bg-transparent text-center"
                    onClick={closeRecommendationOverlay}
                  >
                    <p className="mb-2 font-serif text-sm uppercase tracking-[0.2em] text-scent-text-muted">{activeRecommendation.brand}</p>
                    <h3 className="font-serif italic text-3xl sm:text-8xl text-white leading-tight transition-transform group-hover:scale-105">{activeRecommendation.name}</h3>
                  </button>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-12 text-left">
                    <div>
                      <p className="mb-2 scent-type-label">Olfactory Reason</p>
                      <p className="text-base italic text-scent-text-muted leading-relaxed">{recommendationReason || 'Optimal olfactory alignment with your current atmospheric conditions.'}</p>
                    </div>
                    {activeRecommendation.concentration && activeRecommendation.concentration !== 'Unknown' && (
                    <div>
                      <p className="mb-2 scent-type-label">Concentration</p>
                      <p className="text-base italic text-scent-text-muted leading-relaxed">{activeRecommendation.concentration}</p>
                    </div>
                    )}
                    <div className="sm:col-span-2">
                      <React.Suspense fallback={<div className="min-h-32 rounded-[18px] border border-scent-accent/12 bg-white/[0.03]" />}>
                        <ScentNotesInfographic
                          derivedMetrics={
                            activeRecommendation.derived_metrics ??
                            activeRecommendation.raw_engine_detail?.derived_metrics ??
                            null
                          }
                          legacyPyramid={activeRecommendation.pyramid}
                          scentAxesFallback={activeRecommendation.scent_vector ?? null}
                        />
                      </React.Suspense>
                    </div>
                    {activeEngineRecommendation ? (
                      <>
                        <div>
                          <p className="mb-2 scent-type-label">Best Families</p>
                          <p className="text-base italic text-scent-text-muted leading-relaxed">{formatFamilyList(activeEngineRecommendation.best_scent_families)}</p>
                        </div>
                        <div>
                          <p className="mb-2 scent-type-label">Avoid Today</p>
                          <p className="text-base italic text-scent-text-muted leading-relaxed">{formatAvoidList(activeEngineRecommendation.avoid_scent_families)}</p>
                        </div>
                        <div>
                          <p className="mb-2 scent-type-label">Sprays</p>
                          <p className="text-base italic text-scent-text-muted leading-relaxed">{formatSprayCount(activeEngineRecommendation.spray_count)}</p>
                        </div>
                        <div>
                          <p className="mb-2 scent-type-label">Projection Risk</p>
                          <p className="text-base italic text-scent-text-muted leading-relaxed">{titleCaseToken(activeEngineRecommendation.projection_risk)}</p>
                        </div>
                        <div>
                          <p className="mb-2 scent-type-label">Confidence</p>
                          <p className="text-base italic text-scent-text-muted leading-relaxed">{titleCaseToken(activeEngineRecommendation.confidence)}</p>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            {/* Pinned bottom — Confirm always visible */}
            <div
              className="px-5 pt-3 shrink-0 border-t border-white/5"
              style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
            >
              <button type="button" onClick={closeRecommendationOverlay} className="w-full py-4 bg-scent-accent text-black scent-type-chip hover:opacity-90 transition-opacity active:scale-[0.98]">
                Confirm Alignment
              </button>
            </div>
          </div>
      ) : null}

      <footer className="relative z-10 border-t border-scent-accent/10 py-16 px-8 mt-24">
        <div className="max-w-[1400px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center opacity-30">
            <img
              src="/nav/scentbeam-nav-logo.png"
              srcSet="/nav/scentbeam-nav-logo.png 1x, /nav/scentbeam-nav-logo@2x.png 2x"
              alt="ScentBeam"
              className="h-5 w-auto"
              draggable={false}
            />
          </div>
          <p className="scent-type-label">© 2026 Olfactory Intelligence Systems</p>
        </div>
      </footer>
    </div>
  );
}

function CommunityPageView() {
  const { authToken, authEmail, authPictureUrl, authUsername, handleSignOut, setIsAuthModalOpen, setIsProfileModalOpen } = useAuth();
  const { setIsShareModalOpen } = useWardrobeShareModalActions();
  return (
    <>
      <SEO title="Community | ScentBeam" description="Discuss and discover fragrances with the community." url="https://scentbeam.com/community" />
      <CommunityPage
        authToken={authToken}
        authEmail={authEmail}
        authPictureUrl={authPictureUrl}
        authUsername={authUsername}
        onSignIn={() => setIsAuthModalOpen(true)}
        onShare={() => setIsShareModalOpen(true)}
        onSignOut={handleSignOut}
        onEditProfile={() => setIsProfileModalOpen(true)}
      />
    </>
  );
}

function ArenaPageView() {
  const { authToken, authEmail, authPictureUrl, authUsername, handleSignOut, setIsAuthModalOpen, setIsProfileModalOpen } = useAuth();
  const { setIsShareModalOpen } = useWardrobeShareModalActions();
  return (
    <>
      <SEO title="Arena | ScentBeam" description="Vote on head-to-head fragrance battles." url="https://scentbeam.com/arena" />
      <ArenaPage
        authToken={authToken}
        authEmail={authEmail}
        authPictureUrl={authPictureUrl}
        authUsername={authUsername}
        onSignIn={() => setIsAuthModalOpen(true)}
        onShare={() => setIsShareModalOpen(true)}
        onSignOut={handleSignOut}
        onEditProfile={() => setIsProfileModalOpen(true)}
      />
    </>
  );
}

function SharePageView() {
  const { userId } = useParams<{ userId: string }>();
  return (
    <>
      <SEO title="Shared Wardrobe | ScentBeam" description="Check out this fragrance wardrobe." />
      <SharePage userId={userId || ''} />
    </>
  );
}

function GlobalModals() {
  const {
    authToken,
    authUsername,
    isAuthModalOpen,
    setIsAuthModalOpen,
    isProfileModalOpen,
    setIsProfileModalOpen,
    setAuthUsername,
    guestPromptDismissed,
    setGuestPromptDismissed,
    guestModeActive,
    guestModeAcknowledged,
    setGuestModeAcknowledged,
    handleContinueAsGuest,
  } = useAuth();

  const { items, setItems, isShareModalOpen, setIsShareModalOpen, userId } = useWardrobe();

  // Gentle guest nudge: surfaces only once a guest has shown real intent (a few
  // saves), while the hard modal is closed and they haven't waved it off. It
  // also auto-retires after a few seconds (see GuestSaveBanner) so it never
  // becomes a fixture pinned over the top of every screen.
  const showGuestBanner = !authToken && !isAuthModalOpen && !guestPromptDismissed && items.length >= 3;
  // Persistent guest-state banner after an explicit "Continue as guest". The
  // save nudge takes priority so the two never stack in the same anchor slot.
  const showGuestModeBanner =
    !authToken && !isAuthModalOpen && guestModeActive && !guestModeAcknowledged && !showGuestBanner;
  const guestBanner = showGuestBanner ? (
    <GuestSaveBanner
      itemCount={items.length}
      onSignIn={() => setIsAuthModalOpen(true)}
      onDismiss={() => setGuestPromptDismissed(true)}
    />
  ) : showGuestModeBanner ? (
    <GuestModeBanner
      onSignIn={() => setIsAuthModalOpen(true)}
      onDismiss={() => setGuestModeAcknowledged(true)}
    />
  ) : null;

  const authModal = isAuthModalOpen ? (
    <AuthModal
      onClose={() => {
        setIsAuthModalOpen(false);
        setGuestPromptDismissed(true);
      }}
      onContinueAsGuest={handleContinueAsGuest}
      allowDismiss
      title={items.length >= 2 ? 'Save your wardrobe before you lose it' : undefined}
      subtitle={
        items.length >= 2
          ? 'You can keep exploring as a guest, but signing in will persist your fragrances to your account.'
          : undefined
      }
    />
  ) : null;

  const shareModal = isShareModalOpen ? (
    <React.Suspense fallback={null}>
      <ShareModal
        isOpen={isShareModalOpen}
        onClose={() => setIsShareModalOpen(false)}
        userId={userId}
        authToken={authToken}
        items={items}
        onToggleVisibility={(id, hidden) => {
          setItems(prev =>
            prev.map(item =>
              (item._dbId ?? item.id) === id ? { ...item, shareHidden: hidden } : item,
            ),
          );
        }}
      />
    </React.Suspense>
  ) : null;

  const profileModal = isProfileModalOpen ? (
    <React.Suspense fallback={null}>
      <ProfileSettingsModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        authToken={authToken}
        currentUsername={authUsername}
        onSaved={setAuthUsername}
      />
    </React.Suspense>
  ) : null;

  return (
    <>
      {guestBanner}
      {authModal}
      {shareModal}
      {profileModal}
    </>
  );
}

function RouteChunkFallback() {
  return (
    <div className="grid min-h-[100svh] place-items-center px-6" aria-label="Loading route">
      <div className="h-8 w-8 rounded-full border border-white/15 border-t-scent-accent animate-spin" />
    </div>
  );
}

function WebVitalsReporter() {
  const location = useLocation();
  const { authToken } = useAuth();
  const items = useWardrobeItems();
  const contextRef = useRef({
    route: routeSignature(location),
    authState: authToken ? 'authenticated' as const : 'guest' as const,
    vaultSizeBucket: vaultSizeBucket(items.length),
  });

  useEffect(() => {
    contextRef.current = {
      route: routeSignature(location),
      authState: authToken ? 'authenticated' : 'guest',
      vaultSizeBucket: vaultSizeBucket(items.length),
    };
  }, [authToken, items.length, location]);

  useEffect(() => {
    let cancelled = false;
    let idleHandle: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const start = () => {
      void initWebVitals(() => contextRef.current).catch((err) => {
        if (!cancelled && import.meta.env.DEV) {
          console.debug('[web-vital] init failed', err);
        }
      });
    };

    const scheduleIdle = window.requestIdleCallback as
      | ((callback: IdleRequestCallback, options?: IdleRequestOptions) => number)
      | undefined;

    if (scheduleIdle) {
      idleHandle = scheduleIdle(start, { timeout: 2000 });
    } else {
      timer = setTimeout(start, 1000);
    }

    return () => {
      cancelled = true;
      if (idleHandle !== null && window.cancelIdleCallback) window.cancelIdleCallback(idleHandle);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return null;
}

const AppContent = React.memo(function AppContent({ location }: { location: Location }) {
  return (
    <>
      <React.Suspense fallback={<RouteChunkFallback />}>
        <Routes location={location}>
          <Route path="/" element={<DashboardView />} />
          <Route path="/community" element={<CommunityPageView />} />
          <Route path="/arena" element={<ArenaPageView />} />
          {import.meta.env.DEV && IpadFreezeLab ? (
            <Route path="/debug/ipad-freeze" element={<IpadFreezeLab />} />
          ) : null}
          <Route path="/share/:userId" element={<SharePageView />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </React.Suspense>
      <GlobalModals />
    </>
  );
});

const AppShell = React.memo(function AppShell({
  renderedLocation,
  showThreadBackground,
  threadBackgroundMode,
  ipadSafariPerformanceMode,
  touchPerformanceMode,
  lowRenderPerformanceMode,
}: {
  renderedLocation: Location;
  showThreadBackground: boolean;
  threadBackgroundMode: ThreadBackgroundMode;
  ipadSafariPerformanceMode: boolean;
  touchPerformanceMode: boolean;
  lowRenderPerformanceMode: boolean;
}) {
  const shellClassName = [
    'scent-app-shell min-h-[100svh] bg-scent-bg selection:bg-scent-accent selection:text-black text-white relative overflow-x-hidden',
    ipadSafariPerformanceMode ? 'scent-ipad-safari-perf' : '',
    touchPerformanceMode ? 'scent-touch-perf' : '',
    lowRenderPerformanceMode ? 'scent-low-render-perf' : '',
  ].filter(Boolean).join(' ');

  return (
    <AuthProvider>
      <WeatherProvider>
        <WardrobeProvider>
          <div className={shellClassName}>
            {showThreadBackground ? <ThreadBackground mode={threadBackgroundMode} /> : null}
            <WebVitalsReporter />
            <AppContent location={renderedLocation} />
            <Toaster />
            <InstallPrompt />
            <PushPrompt />
            <BadgeClearer />
          </div>
        </WardrobeProvider>
      </WeatherProvider>
    </AuthProvider>
  );
});

export default function App() {
  const location = useLocation();
  const [renderedLocation, setRenderedLocation] = useState<Location>(location);
  const [transitionVisible, setTransitionVisible] = useState(false);
  const [transitionKey, setTransitionKey] = useState(0);
  const activeRouteRef = useRef(routeSignature(location));
  const coverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paintFrameRef = useRef<number | null>(null);
  const pendingRevealRouteRef = useRef<string | null>(null);
  const transitionStartedAtRef = useRef(0);
  const isFreezeLab = import.meta.env.DEV && renderedLocation.pathname === '/debug/ipad-freeze';
  const { lowMotionRenderMode, isIpad, isIpadStandalone, ipadSafariPerformanceMode, touchPerformanceMode } = useRenderBudget();
  const [threadBackgroundReady, setThreadBackgroundReady] = useState(false);
  // iPad keeps the full tablet layout, but gets its own CSS-scheduled backdrop:
  // fewer moving layers, no per-line filters, and no JS animation loop.
  const threadBackgroundMode: ThreadBackgroundMode = isIpad
    ? 'ipad-optimized'
    : lowMotionRenderMode
      ? 'static'
      : 'raf';
  const showThreadBackground =
    !isFreezeLab && renderedLocation.pathname !== '/community' && threadBackgroundReady;
  const transitionTiming = useMemo(
    () => (lowMotionRenderMode || ipadSafariPerformanceMode ? PAGE_TRANSITION_TIMING.lowMotion : PAGE_TRANSITION_TIMING.standard),
    [ipadSafariPerformanceMode, lowMotionRenderMode],
  );

  const clearTransitionWork = useCallback(() => {
    pendingRevealRouteRef.current = null;
    if (coverTimerRef.current) {
      clearTimeout(coverTimerRef.current);
      coverTimerRef.current = null;
    }
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (paintFrameRef.current !== null) {
      cancelAnimationFrame(paintFrameRef.current);
      paintFrameRef.current = null;
    }
  }, []);

  const scheduleRevealAfterRoutePaint = useCallback(() => {
    paintFrameRef.current = requestAnimationFrame(() => {
      paintFrameRef.current = requestAnimationFrame(() => {
        paintFrameRef.current = null;
        const elapsed = Date.now() - transitionStartedAtRef.current;
        const remainingShowMs = Math.max(transitionTiming.minShowMs - elapsed, 0);
        const revealDelayMs = Math.max(remainingShowMs, transitionTiming.postSwapPaintMs);

        hideTimerRef.current = setTimeout(() => {
          hideTimerRef.current = null;
          setTransitionVisible(false);
        }, revealDelayMs);
      });
    });
  }, [transitionTiming]);

  useEffect(() => {
    const renderedRoute = routeSignature(renderedLocation);
    if (!transitionVisible || pendingRevealRouteRef.current !== renderedRoute) return;

    pendingRevealRouteRef.current = null;
    scheduleRevealAfterRoutePaint();
  }, [renderedLocation, scheduleRevealAfterRoutePaint, transitionVisible]);

  useLayoutEffect(() => {
    const nextRoute = routeSignature(location);
    if (nextRoute === activeRouteRef.current) return;
    activeRouteRef.current = nextRoute;

    clearTransitionWork();
    warmTransitionEmblem();

    transitionStartedAtRef.current = Date.now();
    setTransitionKey((key) => key + 1);
    setTransitionVisible(true);

    coverTimerRef.current = setTimeout(() => {
      coverTimerRef.current = null;
      pendingRevealRouteRef.current = nextRoute;
      setRenderedLocation(location);
    }, transitionTiming.coverMs);
  }, [clearTransitionWork, location, transitionTiming.coverMs]);

  useEffect(() => () => {
    clearTransitionWork();
  }, [clearTransitionWork]);

  // Own scroll position across route changes. React Router does not reset scroll
  // on navigation, and in a standalone PWA the browser's own scroll restoration
  // ('auto') is inconsistent — so each route was landing at whatever scroll the
  // previous page left behind ("a random part of the page"). Take manual control
  // and reset to the top whenever the *rendered* route commits. Keying on
  // `renderedLocation.pathname` (not `location`) runs the reset while the page
  // transition overlay still covers the screen, so the jump is never visible, and
  // it leaves same-route query/hash changes (e.g. in-page scrollIntoView) alone.
  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [renderedLocation.pathname]);

  useEffect(() => {
    if (isFreezeLab) {
      setThreadBackgroundReady(false);
      return undefined;
    }

    let cancelled = false;
    let frame = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: number | null = null;

    frame = requestAnimationFrame(() => {
      settleTimer = setTimeout(() => {
        const scheduleIdle = window.requestIdleCallback as
          | ((callback: IdleRequestCallback, options?: IdleRequestOptions) => number)
          | undefined;

        const reveal = () => {
          if (!cancelled) setThreadBackgroundReady(true);
        };

        if (scheduleIdle) {
          idleHandle = scheduleIdle(reveal, { timeout: 1600 });
        } else {
          reveal();
        }
      }, isIpad ? (isIpadStandalone ? 1900 : 1500) : lowMotionRenderMode ? 1200 : 700);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (settleTimer) clearTimeout(settleTimer);
      if (idleHandle !== null && window.cancelIdleCallback) window.cancelIdleCallback(idleHandle);
    };
  }, [isFreezeLab, isIpad, isIpadStandalone, lowMotionRenderMode]);

  return (
    <>
      <AppShell
        renderedLocation={renderedLocation}
        showThreadBackground={showThreadBackground}
        threadBackgroundMode={threadBackgroundMode}
        ipadSafariPerformanceMode={ipadSafariPerformanceMode}
        touchPerformanceMode={touchPerformanceMode}
        lowRenderPerformanceMode={lowMotionRenderMode}
      />
      <PageTransitionOverlay visible={transitionVisible} animationKey={transitionKey} />
    </>
  );
}
