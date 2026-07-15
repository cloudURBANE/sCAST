import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { Routes, Route, useLocation, useParams, type Location } from 'react-router-dom';
import type { Fragrance } from './components/Wardrobe';
import type { BeamProposalItem } from '@/lib/beamAgentClient';
import { vaultIdentityKey } from './lib/vaultIdentity';
import { buildHeroTickerPhrases } from './lib/heroTickerPhrases';
import { stableProposalItemId, type CurateCollectionResult } from './lib/collectionCuration';
import { getPendingCuration, curationItemToFragrance, pickResumeCurationTarget } from './lib/curationClient';
import { X } from 'lucide-react';
import { AnimatePresence, animate, m, useMotionValue, useReducedMotion } from 'framer-motion';
import { ThreadBackground, type ThreadBackgroundMode } from './components/threads/ThreadBackground';
import { AppTopNav } from './components/AppTopNav';
import { WeeklyOutlookDashboard } from './components/WeeklyOutlookDashboard';
import { AuthModal } from './components/AuthModal';
import { GuestSaveBanner, GuestModeBanner } from './components/GuestSaveBanner';
import { InstallPrompt } from './components/pwa/InstallPrompt';
import { PushPrompt } from './components/pwa/PushPrompt';
import { BadgeClearer } from './components/pwa/BadgeClearer';
import type { ScentFamily, ScentWeatherRecommendation } from './lib/scentWeatherEngine';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WeatherProvider, useWeather } from './context/WeatherContext';
import { WardrobeProvider, useWardrobe, useWardrobeItems, useWardrobeShareModalActions, type WardrobeAddResult } from './context/WardrobeContext';
import { Toaster } from './components/ui/toaster';
import { PageTransitionOverlay, warmTransitionEmblem } from './components/PageTransitionOverlay';
import { ErrorBoundary, RouteErrorFallback } from './components/ErrorBoundary';
import { useModalBehavior } from '@/hooks/use-modal-behavior';
import { toast } from '@/hooks/use-toast';
import { useRenderBudget } from '@/hooks/useRenderBudget';
import { useCalmMotion } from '@/hooks/useCalmMotion';
import { SCENT_EASE_OUT_EXPO } from '@/lib/motion';
import { useMarqueeSwipe } from '@/hooks/useMarqueeSwipe';
import { isIpadSafariPerformanceMode, isLowRenderBudget } from '@/lib/platform';
import NotFound from '@/pages/not-found';
import { SEO } from './components/SEO';
import { AppFooter } from './components/AppFooter';
import { CookieConsentBanner } from './components/legal/CookieConsentBanner';
import { hasAnalyticsConsent, onConsentChange } from '@/lib/consent';
import { loadRouteChunk } from '@/lib/routeChunkRecovery';
import { initWebVitals, vaultSizeBucket } from '@/lib/webVitalsTelemetry';
import { PreferenceSync } from './components/PreferenceSync';

// User-triggered surface: FragranceCapture (~1.5k lines) pulls in the heavy
// fragranceApi client and only renders inside the vault panel's search mode.
// Lazy + route-chunk-recovered like the sibling modals/panels so it is kept
// out of the home/entry bundle for a faster time-to-interactive.
const FragranceCapture = React.lazy(() =>
  loadRouteChunk(() => import('./components/FragranceCapture').then((module) => ({ default: module.FragranceCapture }))),
);

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
// Trust / legal surfaces. Lazy + route-chunk-recovered like every other view so
// they never weigh on the home bundle.
const PrivacyPage = React.lazy(() =>
  loadRouteChunk(() => import('@/pages/legal').then((module) => ({ default: module.PrivacyPage }))),
);
const TermsPage = React.lazy(() =>
  loadRouteChunk(() => import('@/pages/legal').then((module) => ({ default: module.TermsPage }))),
);
const CookiePolicyPage = React.lazy(() =>
  loadRouteChunk(() => import('@/pages/legal').then((module) => ({ default: module.CookiePolicyPage }))),
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
      className="font-serif italic tracking-normal text-inherit leading-[1.05] text-foreground tabular-nums"
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

const HERO_TRACK_COPIES_DEFAULT = 4;
const HERO_TRACK_COPIES_LOW = 2;
const HERO_SCROLL_PIXELS_PER_SECOND = 14;
const HERO_SCROLL_MIN_SECONDS = 60;
const HERO_SCROLL_MAX_SECONDS = 180;
const HERO_SCROLL_REDUCED_MOTION_SECONDS = 240;
// Weather context bar marquee: the metrics gently auto-scroll inside the bounded,
// gold-hairline "new shape" box. Same cadence as the hero ticker so the two bands
// read as one calm system.
const WEATHER_TRACK_COPIES_DEFAULT = 4;
const WEATHER_TRACK_COPIES_LOW = 2;
const WEATHER_SCROLL_PIXELS_PER_SECOND = 14;
const WEATHER_SCROLL_MIN_SECONDS = 72;
const WEATHER_SCROLL_MAX_SECONDS = 160;
const WEATHER_SCROLL_REDUCED_MOTION_SECONDS = 240;

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

// Honest, share-based phrase selection lives in a pure leaf module so it can be
// unit-tested away from this component tree. `Fragrance` is a structural
// superset of `HeroTickerItem`, so it satisfies the selector's input directly.
// The returned `HeroPhrase[]` shape and neutral fallback are unchanged.
function getHeroTickerPhrases(items: Fragrance[]): HeroPhrase[] {
  return buildHeroTickerPhrases(items);
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
      void document.fonts.ready.then(startWhenFontsSettle);
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
  const trackCopies = lowBudgetMarquee ? WEATHER_TRACK_COPIES_LOW : WEATHER_TRACK_COPIES_DEFAULT;

  useMarqueeSwipe(trackRef, {
    distanceVar: '--weather-marquee-distance',
    durationVar: '--weather-marquee-duration',
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
  // Priority order for the scrolling band (design review): the trio that leads
  // each loop — and therefore what a glance most often catches — should be the
  // decision-relevant data (temperature, condition, location). Time is the least
  // valuable metric in-app (the device status bar already shows it), so it rides
  // last; nothing is removed.
  const metrics = [
    { label: 'Temperature', value: temp },
    { label: 'Conditions', value: condition },
    { label: 'Location', value: location },
    { label: 'Humidity', value: humidity },
    { label: 'Time', value: <LiveClock /> },
  ];

  // Measure one looped copy and size the CSS keyframe distance/duration to it so
  // the band cruises at a constant ~14px/s regardless of how wide the metric set
  // renders. Re-measures on resize, font settle, and whenever the values change
  // (a new locality/temperature changes the copy width). Mirrors the hero ticker
  // so both bands share one motion system.
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
        ? WEATHER_SCROLL_REDUCED_MOTION_SECONDS
        : Math.min(
            WEATHER_SCROLL_MAX_SECONDS,
            Math.max(WEATHER_SCROLL_MIN_SECONDS, distance / WEATHER_SCROLL_PIXELS_PER_SECOND),
          );

      track.style.setProperty('--weather-marquee-distance', `${distance}px`);
      track.style.setProperty('--weather-marquee-duration', `${duration}s`);
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
      void document.fonts.ready.then(startWhenFontsSettle);
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

  // One bounded gold-hairline box (the "new shape") whose five metrics gently
  // auto-scroll. The metric cells keep the new card styling (centered label +
  // serif value, hairline dividers); the looped copies + measured keyframe
  // distance restore the calm horizontal motion. The track is also swipe/drag
  // scrubbable (useMarqueeSwipe) and pauses when offscreen or the tab is hidden.
  return (
    <section ref={sectionRef} className="scent-weather-context" aria-label="Current atmosphere" aria-busy={pendingWeather}>
      <div className="scent-weather-context-row">
        <div className="scent-weather-marquee-track" ref={trackRef}>
          {[...Array(trackCopies)].map((_, copyIndex) => (
            <div
              key={copyIndex}
              ref={copyIndex === 0 ? groupRef : undefined}
              className="scent-weather-marquee-group"
              aria-hidden={copyIndex > 0}
            >
              {metrics.map((metric) => (
                <div key={metric.label} className="scent-weather-cell">
                  <span className="scent-weather-label">{metric.label}</span>
                  <span className="scent-weather-value">{metric.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
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
    <div className="mx-auto w-full min-w-0 max-w-[52rem]">
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
      <div className="scent-lux-input mx-auto h-[50px] w-full max-w-[42.75rem] animate-pulse rounded-[var(--radius-scent)] sm:h-[60px]" />
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
  // Mirrors the live vault grid (Wardrobe.tsx: grid-cols-1 gap-3 sm:grid-cols-2
  // sm:gap-4 lg:gap-5 xl:grid-cols-4, tiles min-h-[26rem]) so the chunk swap
  // doesn't jump columns or row heights when the real grid mounts.
  return (
    <section className="w-full py-10" aria-label="Loading vault">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:gap-5 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div
            key={item}
            className="min-h-[26rem] rounded-[var(--radius-scent)] border border-scent-accent/12 bg-black/32"
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
    isDetailRefreshing,
    handleWardrobeImageLoad,
    handleWardrobeImageError,
    ensureWardrobeImage,
    isAdmin,
    setIsShareModalOpen,
    setActiveRecommendation,
    setActiveEngineRecommendation,
    setRecommendationReason,
    markFragranceWorn,
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
  const calmLayout = useCalmMotion();
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
  // With `layout` FLIP disabled on calm devices (every phone), the hero box
  // used to snap instantly between the short search card and the tall Beam
  // panel — the crossfade played over a hard height jump. Instead, right
  // before the view swap the inner wrapper is pinned to its current pixel
  // height, then tweened to the incoming view's height and released back to
  // `auto`. This is a plain height tween (the same technique the mission
  // header's exit collapse already uses safely on iOS) — no FLIP transforms,
  // and `auto` outside the swap means streaming content never fights an
  // animated height. Driven through a MotionValue so no React re-renders.
  const heroInnerHeight = useMotionValue<number | 'auto'>('auto');
  const heroMeasureRef = useRef<HTMLDivElement | null>(null);
  const beginHeroHeightTween = useCallback(() => {
    if (!calmLayout || reduceMotion) return;
    const el = heroMeasureRef.current;
    if (el) heroInnerHeight.set(el.offsetHeight);
  }, [calmLayout, reduceMotion, heroInnerHeight]);
  const handleExitMission = useCallback(() => {
    beginHeroHeightTween();
    setViewState('search');
    setMissionStatus(null);
  }, [beginHeroHeightTween]);
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
          season: '',
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
        const result = await handleAddItem(built).catch(
          (): WardrobeAddResult => ({ persisted: false }),
        );
        // A guest add is stored locally (guestSaved) and a duplicate is already
        // in the vault — both are successful outcomes for curation, not failures.
        const succeeded = result.persisted || result.guestSaved || result.duplicate;
        if (!succeeded) {
          failedItems.push(item);
          onProgress({ index, total, name: item.name, status: 'failed' });
          continue;
        }
        // A duplicate already lives in the vault with its image — skip the
        // image-curation hold below and report it ready immediately.
        const canonicalItem = result.item ?? (built as unknown as Fragrance);
        const hasImage =
          typeof canonicalItem.imageUrl === 'string' && canonicalItem.imageUrl.trim().length > 0;
        if (!hasImage) {
          // No catalog image rode along — actively trigger the image pipeline and
          // wait for it (this is the "curating" hold the user sees).
          onProgress({ index, total, name: item.name, status: 'curating' });
          const ensured = await ensureWardrobeImage(canonicalItem).catch(() => null);
          if (!ensured?.imageUrl?.trim()) {
            failedItems.push(item);
            onProgress({ index, total, name: item.name, status: 'failed' });
            continue;
          }
        }
        added++;
        onProgress({ index, total, name: item.name, status: 'ready' });
      }
      return { added, total, failedItems };
    },
    [ensureWardrobeImage, handleAddItem],
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
    : { duration: 0.42, ease: SCENT_EASE_OUT_EXPO };

  // NOTE: the Beam agent panel deliberately does NOT lock body scroll. It is
  // inline content that replaces the search card within the page flow (not a
  // fixed overlay), so it never needed scroll isolation. Pinning <body> with
  // position:fixed for it caused the iPhone "tap Close -> gray screen" freeze:
  // on close, removing position:fixed leaves iOS WebKit showing a blank gray
  // compositor layer that locks the page until the next touch. Letting the page
  // scroll normally while the panel is open removes that failure mode entirely.
  // Do NOT re-add useBodyScrollLock(agentActive) here — it has regressed this
  // exact iPhone close bug every time it returns (see commits 23b2a22, f49aa67).

  useEffect(() => {
    if (!discoveryReady && viewState === 'agent') {
      setViewState('search');
    }
  }, [discoveryReady, viewState]);

  // Runs the hero height tween armed by beginHeroHeightTween(). Fires after the
  // view swap has committed to the DOM (the measure wrapper already holds the
  // incoming view), animates the pinned height to the new natural height, then
  // releases back to 'auto'. When the value is 'auto' (desktop FLIP path, or no
  // swap in flight) this is a no-op.
  useLayoutEffect(() => {
    if (heroInnerHeight.get() === 'auto') return;
    const el = heroMeasureRef.current;
    if (!el) return;
    const controls = animate(heroInnerHeight, el.offsetHeight, {
      duration: 0.42,
      ease: SCENT_EASE_OUT_EXPO,
      onComplete: () => heroInnerHeight.set('auto'),
    });
    return () => controls.stop();
  }, [viewState, heroInnerHeight]);

  // While the swap tween is in flight, retarget it if the incoming content
  // resizes mid-animation (e.g. the lazy panel chunk resolves and replaces the
  // Suspense skeleton), so a late resolve glides instead of snapping. Inert
  // whenever the height is 'auto'.
  useEffect(() => {
    const el = heroMeasureRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (heroInnerHeight.get() === 'auto') return;
      const target = el.offsetHeight;
      if (heroInnerHeight.get() === target) return;
      animate(heroInnerHeight, target, {
        duration: 0.42,
        ease: SCENT_EASE_OUT_EXPO,
        onComplete: () => heroInnerHeight.set('auto'),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [heroInnerHeight]);

  useEffect(() => {
    if (viewState !== 'agent') return;
    // The Beam Agent replaces the search card inside the hero box, so bring that
    // box into view on open. `block: 'nearest'` avoids a hard page jump. Wait
    // for the swap/height tween (0.42s) to finish first so the smooth scroll
    // measures the panel's final height and never competes with the swap
    // animation for frames on iOS.
    const id = window.setTimeout(() => {
      heroVaultRef.current?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'nearest',
      });
    }, reduceMotion ? 0 : 460);
    return () => window.clearTimeout(id);
  }, [reduceMotion, viewState]);

  const handleOpenMission = useCallback(() => {
    beginHeroHeightTween();
    setViewState('agent');
  }, [beginHeroHeightTween]);

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

  // Resume-on-DEEP-LINK: open a curation's detail card ONLY when the user arrived
  // via a completion push deep-link `/?curation=<jobKey>` (the SW's
  // notificationclick → data.url) AND that exact pick is fully enriched. A plain
  // app open never force-opens anything — ready picks live in the notification
  // feed. This is the fix for the "Unknown / NO IMAGE card greets me on every
  // launch" artifact: previously this effect opened the first `ready` item on
  // every load, and `ready` was set on a too-weak enrichment bar.
  //
  // We strip the `?curation` param immediately and record the jobKey as "opened"
  // in localStorage so a refresh (or a re-tap) can't re-slam the same modal.
  // Guarded by a ref so re-renders don't re-fetch.
  const resumeCurationToken = location.search;
  const curationResumeHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authToken) return;
    const jobKey = new URLSearchParams(resumeCurationToken).get('curation');
    // No deep-link → nothing to resume. Don't even hit the network on a plain open.
    if (!jobKey) return;

    const guardKey = `${authToken}:${jobKey}`;
    if (curationResumeHandledRef.current === guardKey) return;
    curationResumeHandledRef.current = guardKey;

    // Strip the param up front so a reload is clean regardless of the outcome.
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete('curation');
      window.history.replaceState(window.history.state, '', url.toString());
    }

    // Once-per-device de-dupe: never auto-open the same curation twice.
    const seenStorageKey = 'scent_curation_opened';
    const readSeen = (): string[] => {
      try {
        const seen = JSON.parse(window.localStorage.getItem(seenStorageKey) ?? '[]');
        return Array.isArray(seen) ? (seen as string[]) : [];
      } catch {
        return [];
      }
    };
    if (readSeen().includes(jobKey)) return;

    let cancelled = false;
    void (async () => {
      const items = await getPendingCuration(authToken);
      if (cancelled) return;

      const target = pickResumeCurationTarget(items, jobKey);
      if (!target) return;

      try {
        const next = readSeen();
        if (!next.includes(jobKey)) next.push(jobKey);
        // Keep the list bounded so it can't grow without limit.
        window.localStorage.setItem(seenStorageKey, JSON.stringify(next.slice(-100)));
      } catch {
        /* storage unavailable — opening once is still fine */
      }

      openFragranceDetail(curationItemToFragrance(target));
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

      {/* Gutters respect the horizontal safe-area insets (viewport-fit=cover):
          in landscape on a notched phone the content column stays clear of the
          notch/rounded corners like the fixed bars already do. Portrait is
          unchanged (insets are 0, so max() resolves to the original 1rem/2rem). */}
      <main className="relative z-10 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))] sm:pr-[max(2rem,env(safe-area-inset-right))] sm:pb-24 max-w-[1760px] mx-auto">
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
        {/* sm/lg gaps tightened one step (was gap-8/gap-10): on iPad the four
            stacked modules (search → Beam → atmosphere → forecast) each sat in
            an isolated pocket of air, pushing the forecast hero — the product
            value — a full extra beat down the page. The tighter cadence keeps
            the modules reading as one composed column; phone rhythm
            (justify-between) is untouched. */}
        {/* Phone gap tightened one more step (gap-4→gap-3) and the nav
            clearance pared back (1.5rem→1rem): the design review's one
            structural complaint left was total vertical height — the savings
            come from the empty transitions between modules, not from the
            modules themselves. */}
        <div className={`flex min-h-[calc(100svh-var(--topbar-h))] flex-col gap-3 pt-0 pb-[calc(var(--bottomnav-h)+1rem)] sm:min-h-0 sm:gap-6 sm:pt-0 sm:pb-0 lg:gap-8 ${agentActive ? '' : 'justify-between sm:justify-start'}`}>
          {/* The hero ticker sits flush against the fixed top bar (no padding
              above it) so it visually replaces the bar's old bottom hairline. */}
          <HomepageHeroMarquee />

          {/* Passthrough wrapper (`display:contents`) so its children — search,
              stat, forecast — become DIRECT flex children of the column and share
              in the column's `justify-between` distribution (mobile only). On a
              tall phone the stacked content is shorter than the viewport; rather
              than pooling that slack into ONE dead gap (all-at-bottom read as a
              void before the nav; my-auto read as a void above the forecast;
              full centering read as a void between the ticker and the search),
              justify-between spreads it into several small, EVEN gaps between the
              ticker, search, stat, and forecast — consistent rhythm instead of a
              hole — while the ticker stays flush at the top and the calendar
              anchors just above the nav. sm:justify-start on the column restores
              the untouched desktop flow. */}
          <div className="contents">
          {/* 52rem matches every sibling in this column (mission header, the
              Discover CTA that "shares the exact box" of the card, atmosphere
              bar, forecast), so the card edges align down the whole stack on
              wide viewports. It was 60rem — drift from a larger refactor. */}
          <section className="relative mx-auto w-full max-w-[52rem] min-w-0 text-center">
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
                <m.div
                  key="mission-header"
                  initial={calmLayout ? false : { opacity: 0, y: 6, ...missionHeaderMargins }}
                  animate={{ opacity: 1, y: 0, ...missionHeaderMargins }}
                  exit={calmLayout ? { opacity: 0 } : { opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
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
                      className="absolute right-0 top-1/2 inline-flex min-h-11 -translate-y-1/2 items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-scent-text-subtle transition-colors duration-200 active:bg-white/10 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
                      aria-label="Close and return to fragrance search"
                    >
                      <X size={18} strokeWidth={1.75} aria-hidden />
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em]">Close</span>
                    </button>
                  </div>
                  <h2 className="mx-auto max-w-[32rem] text-balance font-serif italic text-[clamp(1.4rem,3.4vw,1.9rem)] leading-[1.05] tracking-normal text-foreground drop-shadow-[0_4px_14px_rgba(0,0,0,0.72)]">
                    {missionStatus?.headerTitle ?? 'A scent for today.'}
                  </h2>
                  <p className="mt-1.5 scent-type-label text-scent-accent/55">
                    {missionStatus?.progressText ?? 'Tell me about your day'}
                  </p>
                  <p className="mx-auto mt-1 hidden max-w-xl text-sm leading-6 text-scent-text-muted sm:block">
                    {missionStatus?.contextLine ?? 'Weather context ready when available'}
                  </p>
                </m.div>
              ) : null}
            </AnimatePresence>

            {/* The hero box holds EITHER the fragrance-search card OR the
                signature-scent Beam Agent — never both. Opening the agent
                replaces the search card in place, so the card's details are not
                duplicated above the panel; closing (the header X) returns the
                search card. */}
            <m.div
              ref={heroVaultRef}
              layout={isMounted ? !calmLayout : false}
              transition={vaultContentTransition}
              className="scent-vault-panel w-full min-w-0 relative overflow-hidden"
              style={{ scrollMarginTop: 'calc(var(--topbar-h) + 1rem)' }}
              data-view-state={viewState}
            >
              {/* Height rides the swap MotionValue ('auto' outside a swap); the
                  plain wrapper below is the natural-height measure target for
                  the tween. See heroInnerHeight above. */}
              <m.div className="scent-vault-panel-inner min-w-0" style={{ height: heroInnerHeight }}>
                <div ref={heroMeasureRef} className="min-w-0">
                {/* popLayout pops the outgoing surface out of flow so the panel
                    resizes in a single smooth stage while the two views
                    crossfade — instead of the old wait-mode swap, which let the
                    card visibly grow/bounce after the fade completed. */}
                <AnimatePresence initial={false} mode="popLayout">
                  {agentActive ? (
                    <m.div
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
                    </m.div>
                  ) : (
                    <m.div
                      key="search"
                      initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                      transition={vaultContentTransition}
                    >
                      <React.Suspense fallback={<SignaturePanelFallback />}>
                        <FragranceCapture
                          onAdd={handleAddItem}
                          onVaultSearchStateChange={handleVaultSearchStateChange}
                          existingVaultKeys={vaultIdentityKeys}
                          onViewVault={handleViewVault}
                          embeddedInVaultPanel
                        />
                      </React.Suspense>
                    </m.div>
                  )}
                </AnimatePresence>
                </div>
              </m.div>
            </m.div>

            {/* One stable lower action slot owns both states: search mode shows
                the Discover CTA, agent mode hosts the portaled cue / Confirm
                lane. Keeping the slot mounted prevents the CTA and card from
                visibly reattaching on close. */}
            {(agentActive || (discoveryReady && stateSettled && !vaultSearchUiActive)) ? (
              <m.div
                ref={signatureSectionRef}
                layout={isMounted ? !calmLayout : false}
                transition={vaultContentTransition}
                className="scent-mission-action-slot mt-2 flex min-h-[44px] justify-center sm:mt-3 sm:min-h-[50px]"
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
                    <m.button
                      key="signature-cta"
                      type="button"
                      onClick={handleOpenMission}
                      onPointerEnter={prefetchScentMissionPanel}
                      // pointerdown fires ~80-120ms before click on touch, where
                      // pointerenter/focus never warm the chunk — a free head
                      // start against the Suspense skeleton on a cold open.
                      onPointerDown={prefetchScentMissionPanel}
                      onFocus={prefetchScentMissionPanel}
                      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                      // Press feedback lives here, not in CSS :active — the
                      // stylesheet cedes transform to framer-motion so the
                      // enter/exit y-shift and the press scale can't clobber
                      // each other's transform.
                      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                      transition={vaultContentTransition}
                      // Auto-width ghost pill (was a full-width glass slab that
                      // duplicated the search input's box): the pill hugs its
                      // label so the gold input above stays the block's only
                      // full-width capsule. Height keeps the 44px+ tap target.
                      // A notch smaller and less tracked than the last pass
                      // (design review: the pill still sat too close to the
                      // search field in visual weight) — height/padding/tracking
                      // each step down one register; 44px keeps the tap target.
                      className="scent-signature-cta group inline-flex h-[44px] items-center justify-center rounded-full px-6 text-[11.5px] font-bold uppercase tracking-[0.09em] text-scent-accent focus-visible:outline-none sm:h-[50px] sm:px-8 sm:text-[12.5px] sm:tracking-[0.12em]"
                      aria-label="Discover with Beam Agent"
                      title="Discover with Beam Agent"
                    >
                      {/* No leading icon — the label is the sole content so it
                          centers in the pill. The text-indent equals the
                          letter-spacing so the trailing tracking gap doesn't pull
                          the glyphs optically left of center. */}
                      <span className="[text-indent:0.09em] sm:[text-indent:0.12em]">Discover With Beam Agent</span>
                    </m.button>
                  )}
                </AnimatePresence>
              </m.div>
            ) : null}
          </section>

          {!agentActive ? <HomepageAtmosphereChrome /> : null}

          {/* Weekly outlook dashboard — on phones the forecast sits directly in
              the column's natural gap-4 rhythm beneath the atmosphere/stat row, so
              it reads as connected to that row rather than isolated by a void
              above it. Normal flow on md+. Hidden in agent mode (it takes over the
              hero). */}
          {!agentActive ? (
            // Follow the column's natural gap rhythm — the forecast sits one
            // consistent step below the atmosphere/stat row, same as every other
            // gap in the stack, so the page reads as one locked spacing system.
            // The earlier my-auto centered the module in the leftover viewport
            // space, which on tall phones opened a "dead zone" ABOVE the forecast
            // title (the reported too-large gap before "Scent Forecast"). Letting
            // the stack top-anchor sends any remainder to the BOTTOM instead,
            // where it reads as calm breathing room in front of the floating nav
            // pill rather than a void mid-page. The column pb still holds nav
            // clearance regardless of overflow. md+ is unchanged.
            <WeeklyOutlookDashboard
              items={items}
              weather={weather}
              onSelectFragrance={openFragranceDetail}
            />
          ) : null}
          </div>
        </div>

        {/* Page two: the Vault of Aromas, reached by scrolling one screen down
            from the home view above. */}
        {/* The home column above already fills the first viewport (min-h 100svh),
            so this margin is pure separation — a moderate band, not a dead zone. */}
        <div id="scent-vault-section" className="scent-deferred-section !mt-16 sm:!mt-28 lg:!mt-36" style={{ scrollMarginTop: 'var(--topbar-h)' }}>
            <React.Suspense fallback={<WardrobeFallback />}>
              <Wardrobe
                items={items}
                onDelete={handleDeleteItem}
                onAdd={handleAddItem}
                pendingDetailOpen={pendingDetailOpen}
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
                isDetailRefreshing={isDetailRefreshing}
                onImageLoad={handleWardrobeImageLoad}
                onImageError={handleWardrobeImageError}
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
              {/* House modal close recipe (ShareModal / ProfileSettingsModal):
                  bordered circle + visible focus ring; the old borderless ghost
                  had no focus-visible affordance at all. */}
              <button ref={recommendationCloseRef} type="button" onClick={closeRecommendationOverlay} className="group -m-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition-colors hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40" aria-label="Close recommendation">
                <X size={18} strokeWidth={1.75} className="transition-transform duration-300 group-hover:rotate-90" />
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
                    {/* When Concentration is absent, Reason spans the full row so
                        the two-column grid never opens with a hole at top-right;
                        Confidence (always last) spans below for the same reason —
                        the metric count is odd, so an un-spanned final cell left
                        an orphan bottom-left on every sm+ viewport. */}
                    <div className={activeRecommendation.concentration && activeRecommendation.concentration !== 'Unknown' ? undefined : 'sm:col-span-2'}>
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
                        <div className="sm:col-span-2">
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
              <button
                type="button"
                onClick={() => {
                  // Confirming the pick IS wearing it: stamp lastWornAt so the
                  // recency penalty rotates tomorrow's pick off this bottle. The
                  // X in the top bar stays a pure dismiss (no wear logged).
                  const picked = activeRecommendation;
                  void markFragranceWorn(picked);
                  toast({
                    title: 'Logged for today',
                    description: `We'll rest ${picked.name} and rotate tomorrow's pick.`,
                  });
                  closeRecommendationOverlay();
                }}
                className="w-full py-4 bg-scent-accent text-black scent-type-chip hover:opacity-90 transition-opacity active:scale-[0.98]"
              >
                Confirm Alignment
              </button>
            </div>
          </div>
      ) : null}

      <AppFooter className="mt-12 sm:mt-16" />
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
    authError,
    clearAuthError,
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
        clearAuthError();
      }}
      onContinueAsGuest={() => {
        clearAuthError();
        handleContinueAsGuest();
      }}
      errorMessage={authError}
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
    let started = false;
    let idleHandle: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Performance analytics is opt-in. Only initialise Web Vitals once the user
    // has granted analytics consent — and only once. If they grant it later in
    // the session, the consent listener below starts it then.
    const start = () => {
      if (cancelled || started || !hasAnalyticsConsent()) return;
      started = true;
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

    const unsubscribe = onConsentChange(() => start());

    return () => {
      cancelled = true;
      unsubscribe();
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
          <Route
            path="/"
            element={
              // Route-scoped boundary for the home shell so a DashboardView render
              // error degrades to a localized panel (nav stays mounted) instead of
              // nuking the whole SPA via the root boundary's hard reload. resetKeys
              // soft-recovers it the moment the user navigates away.
              <ErrorBoundary
                scope="dashboard"
                resetKeys={[location.pathname]}
                fallback={(error, reset) => (
                  <RouteErrorFallback label="The home view" error={error} onRetry={reset} />
                )}
              >
                <DashboardView />
              </ErrorBoundary>
            }
          />
          <Route
            path="/community"
            element={
              <ErrorBoundary
                scope="community"
                resetKeys={[location.pathname]}
                fallback={(error, reset) => (
                  <RouteErrorFallback label="The community feed" error={error} onRetry={reset} />
                )}
              >
                <CommunityPageView />
              </ErrorBoundary>
            }
          />
          <Route
            path="/arena"
            element={
              <ErrorBoundary
                scope="arena"
                resetKeys={[location.pathname]}
                fallback={(error, reset) => (
                  <RouteErrorFallback label="The arena" error={error} onRetry={reset} />
                )}
              >
                <ArenaPageView />
              </ErrorBoundary>
            }
          />
          {import.meta.env.DEV && IpadFreezeLab ? (
            <Route path="/debug/ipad-freeze" element={<IpadFreezeLab />} />
          ) : null}
          <Route
            path="/share/:userId"
            element={
              <ErrorBoundary
                scope="share"
                resetKeys={[location.pathname]}
                fallback={(error, reset) => (
                  <RouteErrorFallback label="This shared vault" error={error} onRetry={reset} />
                )}
              >
                <SharePageView />
              </ErrorBoundary>
            }
          />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/cookies" element={<CookiePolicyPage />} />
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
            <PreferenceSync />
            {showThreadBackground ? <ThreadBackground mode={threadBackgroundMode} /> : null}
            <WebVitalsReporter />
            <AppContent location={renderedLocation} />
            <Toaster />
            <InstallPrompt />
            <PushPrompt />
            <BadgeClearer />
            <CookieConsentBanner />
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
    void warmTransitionEmblem();

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
