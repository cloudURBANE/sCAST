import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { Routes, Route, useLocation, useParams, type Location } from 'react-router-dom';
import { FragranceCapture, vaultIdentityKey } from './components/FragranceCapture';
import { Wardrobe, Fragrance, DestinationType, EnergyState } from './components/Wardrobe';
import { Play, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScentIntentModal } from './components/ScentIntentModal';
import { ScentNotesInfographic } from './components/ScentNotesInfographic';
import { ThreadBackground } from './components/threads/ThreadBackground';
import { AppTopNav } from './components/AppTopNav';
import { AuthModal } from './components/AuthModal';
import { GuestSaveBanner, GuestModeBanner } from './components/GuestSaveBanner';
import { ShareModal } from './components/ShareModal';
import { ProfileSettingsModal } from './components/ProfileSettingsModal';
import type { ScentFamily, ScentWeatherRecommendation } from './lib/scentWeatherEngine';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WeatherProvider, useWeather } from './context/WeatherContext';
import { WardrobeProvider, useWardrobe, useWardrobeItems, useWardrobeShareModalActions } from './context/WardrobeContext';
import { Toaster } from './components/ui/toaster';
import { PageTransitionOverlay, warmTransitionEmblem } from './components/PageTransitionOverlay';
import { useModalBehavior } from '@/hooks/use-modal-behavior';
import { useRenderBudget } from '@/hooks/useRenderBudget';
import { useMarqueeSwipe } from '@/hooks/useMarqueeSwipe';
import NotFound from '@/pages/not-found';
import { SEO } from './components/SEO';
import { loadRouteChunk } from '@/lib/routeChunkRecovery';

const CommunityPage = React.lazy(() => loadRouteChunk(() => import('@/pages/community')));
const IpadFreezeLab = React.lazy(() => loadRouteChunk(() => import('@/pages/ipad-freeze-lab')));
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
  const display = time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
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

const ATMOSPHERE_TRACK_COPIES = 4;
const ATMOSPHERE_SCROLL_PIXELS_PER_SECOND = 14;
const ATMOSPHERE_SCROLL_MIN_SECONDS = 72;
const ATMOSPHERE_SCROLL_MAX_SECONDS = 160;
const ATMOSPHERE_SCROLL_REDUCED_MOTION_SECONDS = 240;
const HERO_TRACK_COPIES = 4;
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

function getHeroTickerPhrases(items: Fragrance[]): string[] {
  if (!items.length) {
    return [
      'Add scents to your vault and unlock deeper discovery',
      'Atmospheric nuance is analyzed to guide each wear',
      'Your signature profile is syncing with the current environment',
    ];
  }

  const phrases: string[] = [];

  const families = items.map(i => i.family).filter(Boolean) as string[];
  if (families.length > 0) {
    const fc: Record<string, number> = {};
    families.forEach(f => { fc[f] = (fc[f] || 0) + 1; });
    const topFamily = Object.entries(fc).sort((a, b) => b[1] - a[1])[0][0];
    phrases.push(`Predominantly ${topFamily.toLowerCase()} olfactory signature`);
  }

  const allNotes = items.flatMap(i => i.notes || []);
  if (allNotes.length > 0) {
    const nc: Record<string, number> = {};
    allNotes.forEach(n => { const k = n.toLowerCase(); nc[k] = (nc[k] || 0) + 1; });
    const [topNote, topCount] = Object.entries(nc).sort((a, b) => b[1] - a[1])[0];
    if (topCount > 1) phrases.push(`Recurring molecule detected: ${topNote}`);
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
    if (top.avg >= 4.5) phrases.push(`Your vault reads ${labels[top.d]}`);
  }

  const seasons = items.map(i => i.season).filter(Boolean) as string[];
  if (seasons.length > 0) {
    const sc: Record<string, number> = {};
    seasons.forEach(s => { sc[s] = (sc[s] || 0) + 1; });
    const [topSeason, topSeasonCount] = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];
    if (topSeasonCount > 1) phrases.push(`Calibrated for ${topSeason.toLowerCase()} conditions`);
  }

  const brands = new Set(items.map(i => i.brand).filter(Boolean));
  if (brands.size > 1) phrases.push(`${brands.size} houses represented in your collection`);

  if (phrases.length < 3) phrases.push('Olfactory intelligence active', 'Atmospheric pairing in progress');

  return phrases;
}

interface HeroMarqueeProps {
  phrases: string[];
}

const HeroMarquee: React.FC<HeroMarqueeProps> = React.memo(({ phrases }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLSpanElement>(null);
  const phraseKey = useMemo(() => phrases.join('|'), [phrases]);

  useMarqueeSwipe(trackRef, {
    distanceVar: '--hero-marquee-distance',
    durationVar: '--hero-marquee-duration',
    resetKey: phraseKey,
  });

  useLayoutEffect(() => {
    const track = trackRef.current;
    const group = groupRef.current;
    if (!track || !group) return;
    let cancelled = false;
    let animationFrame = 0;

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

    if (track.dataset.marqueeReady !== 'true') {
      track.dataset.marqueeReady = 'false';
    }

    const startWhenFontsSettle = () => {
      animationFrame = window.requestAnimationFrame(() => updateDistance(true));
    };

    if (document.fonts?.ready) {
      document.fonts.ready.then(startWhenFontsSettle);
    } else {
      startWhenFontsSettle();
    }

    const handleResize = () => updateDistance(track.dataset.marqueeReady === 'true');
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(group);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelled = true;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [phraseKey]);

  return (
    <div className="scent-marquee-band scent-full-bleed w-full overflow-hidden py-[17px] sm:py-[18px] flex select-none relative">
      <div ref={trackRef} className="scent-marquee-track-row whitespace-nowrap scent-marquee-text">
        {[...Array(HERO_TRACK_COPIES)].map((_, copyIndex) => (
          <span
            key={copyIndex}
            ref={copyIndex === 0 ? groupRef : undefined}
            className="scent-marquee-phrase-group flex items-center"
            aria-hidden={copyIndex > 0}
          >
            {phrases.map((phrase, phraseIndex) => (
              <React.Fragment key={`${phraseIndex}:${phrase}`}>
                <span className="scent-marquee-phrase whitespace-nowrap">{phrase}</span>
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
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);

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
    : conditionText;
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
  const metrics = [
    { label: 'Matrix', subtitle: 'Conditions', value: condition },
    { label: 'Saturation', subtitle: 'Humidity', value: humidity },
    { label: 'Chronos', subtitle: 'Time', value: <LiveClock /> },
    { label: 'Atmosphere', subtitle: 'Temperature', value: temp },
    { label: 'Coordinate', subtitle: 'Location', value: location },
  ];

  useLayoutEffect(() => {
    const track = trackRef.current;
    const group = groupRef.current;
    if (!track || !group) return;
    let cancelled = false;
    let animationFrame = 0;

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

    if (track.dataset.marqueeReady !== 'true') {
      track.dataset.marqueeReady = 'false';
    }

    const startWhenFontsSettle = () => {
      animationFrame = window.requestAnimationFrame(() => updateDistance(true));
    };

    if (document.fonts?.ready) {
      document.fonts.ready.then(startWhenFontsSettle);
    } else {
      startWhenFontsSettle();
    }

    const handleResize = () => updateDistance(track.dataset.marqueeReady === 'true');
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(group);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelled = true;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [atmosphereDisplayKey]);

  return (
    <section className="scent-atmosphere-marquee relative" aria-label="Current atmosphere" aria-busy={pendingWeather}>
      <div className="scent-atmosphere-marquee-track" ref={trackRef}>
        {[...Array(ATMOSPHERE_TRACK_COPIES)].map((_, copyIndex) => (
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
                  {metric.subtitle && (
                    <span className="scent-atmosphere-subtitle">({metric.subtitle})</span>
                  )}
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

function DashboardView() {
  const { authToken, authEmail, authPictureUrl, authUsername, handleSignOut, setIsAuthModalOpen, setIsProfileModalOpen } = useAuth();
  const {
    items,
    wardrobeLoaded,
    onboardingCompleted,
    onboardingResolved,
    wardrobeError,
    retryLoadWardrobe,
    isIntentModalOpen,
    activeRecommendation,
    activeEngineRecommendation,
    recommendationReason,
    wardrobeRevertSnapshot,
    wardrobeFixBusy,
    wardrobeFixHint,
    vaultSearchUiActive,
    isImageSyncing,
    isAdmin,
    setIsIntentModalOpen,
    setIsShareModalOpen,
    handleAddItem,
    handlePersistWardrobeImage,
    uploadAdminBottleImage,
    handleRevertWardrobe,
    handleDeleteItem,
    handleIntentComplete,
    closeRecommendationOverlay,
    handleVaultSearchStateChange,
    handleExpandArchive,
  } = useWardrobe();
  const recommendationOverlayRef = useRef<HTMLDivElement | null>(null);
  const recommendationCloseRef = useRef<HTMLButtonElement | null>(null);

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
  const showOnboardingSteps =
    stateSettled && !onboardingCompleted && items.length === 0 && !vaultSearchUiActive;

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

  const handleViewVault = useCallback(() => {
    document
      .getElementById('scent-vault-section')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div className="min-h-[100svh] relative overflow-x-hidden">
      <SEO />
      <AppTopNav
        authToken={authToken}
        authEmail={authEmail}
        authPictureUrl={authPictureUrl}
        authUsername={authUsername}
        renderedRoute="home"
        onSignIn={() => setIsAuthModalOpen(true)}
        onShare={() => setIsShareModalOpen(true)}
        onSignOut={handleSignOut}
        onEditProfile={() => setIsProfileModalOpen(true)}
      />

      <div style={{ height: 'var(--topbar-h)' }} />

      <main className="relative z-10 pb-24 px-4 sm:px-8 max-w-[1760px] mx-auto">
        <div className="space-y-20 sm:space-y-28 pt-10 sm:pt-14">
          <HomepageHeroMarquee />

          <section className="mx-auto w-full max-w-[60rem] min-w-0 space-y-7 text-center">
            <FragranceCapture
              onAdd={handleAddItem}
              onVaultSearchStateChange={handleVaultSearchStateChange}
              existingVaultKeys={vaultIdentityKeys}
              onViewVault={handleViewVault}
            />
            <AnimatePresence initial={false}>
              {showOnboardingSteps ? (
                <motion.div
                  key="how-it-works"
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: '1.75rem' }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="relative overflow-hidden rounded-[var(--radius-scent)] border border-scent-accent/22 bg-[linear-gradient(180deg,rgba(255,247,236,0.045),rgba(0,0,0,0.36))] p-3 shadow-[inset_0_1px_0_rgba(255,236,183,0.08),0_18px_46px_-38px_rgba(212,175,55,0.52)] sm:p-4">
                    <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-scent-accent/45 to-transparent" aria-hidden />
                    <div className="relative grid gap-2 text-left sm:grid-cols-3 sm:text-center">
                      <div className="pointer-events-none absolute left-[16.666%] right-[16.666%] top-4 hidden h-px bg-gradient-to-r from-scent-accent/18 via-scent-accent/42 to-scent-accent/18 sm:block" aria-hidden />
                      {([
                        { step: '1', title: 'Search', text: 'Find a fragrance you own or love' },
                        { step: '2', title: 'Vault', text: 'Add three bottles for a useful profile' },
                        { step: '3', title: 'Match', text: 'Unlock a weather-aware recommendation' },
                      ] as const).map(({ step, title, text }) => (
                        <div key={step} className="relative flex min-w-0 items-center gap-3 rounded-[calc(var(--radius-scent)-10px)] border border-white/8 bg-black/28 px-3 py-3 sm:flex-col sm:gap-2 sm:px-3 sm:py-4">
                          <span className="relative z-[1] flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-scent-accent/68 bg-[#080604] text-[12px] font-bold tabular-nums text-scent-accent shadow-[0_0_0_4px_rgba(0,0,0,0.72),0_8px_20px_-14px_rgba(212,175,55,0.9)] sm:h-7 sm:w-7">{step}</span>
                          <div className="min-w-0">
                            <p className="scent-type-label text-scent-accent/88 sm:mb-1">{title}</p>
                            <p className="text-[12px] leading-snug text-scent-text-muted sm:mx-auto sm:max-w-[10.5rem]">{text}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {!vaultSearchUiActive && stateSettled ? (
                <motion.div
                  key="discover-cta"
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: '1.75rem' }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  {discoveryReady ? (
                    <motion.button
                      type="button"
                      onClick={() => setIsIntentModalOpen(true)}
                      className="scent-primary-button w-full min-h-[60px] sm:h-16 flex items-center justify-center gap-2.5 sm:gap-4 px-4 transition-all group rounded-[var(--radius-scent)]"
                    >
                      <Play size={19} className="fill-current shrink-0 group-hover:scale-110 transition-transform" aria-hidden />
                      <span className="font-serif italic text-lg sm:text-2xl leading-tight text-center">Discover Your Signature Scent</span>
                    </motion.button>
                  ) : (
                    <div className="flex w-full min-h-[84px] flex-col items-center justify-center rounded-[var(--radius-scent)] border border-scent-accent/22 bg-[linear-gradient(180deg,rgba(255,247,236,0.04),rgba(0,0,0,0.34))] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,236,183,0.08),0_18px_46px_-40px_rgba(212,175,55,0.48)] sm:min-h-24 sm:px-6">
                      <div className="flex w-full max-w-[34rem] flex-col items-center gap-3.5">
                        <div className="flex w-full items-center justify-between gap-4">
                          <span className="scent-type-label text-scent-accent/85">Discovery readiness</span>
                          <span className="font-mono text-[11px] font-semibold tabular-nums text-scent-accent">{Math.min(items.length, 3)}/3</span>
                        </div>
                        <div className="grid w-full grid-cols-3 gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={Math.min(items.length, 3)} aria-label="Fragrances added toward discovery">
                          {[0, 1, 2].map((i) => (
                            <span
                              key={i}
                              className={`h-2 rounded-full transition-colors duration-300 ${
                                i < items.length ? 'bg-scent-accent/85 shadow-[0_0_10px_rgba(212,175,55,0.35)]' : 'bg-white/12'
                              }`}
                            />
                          ))}
                        </div>
                        <span className="text-center font-serif italic text-base leading-tight text-white/58 sm:text-lg">
                          {items.length === 0
                            ? 'Add 3 fragrances to unlock discovery'
                            : `${3 - items.length} more to unlock discovery`}
                        </span>
                      </div>
                    </div>
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </section>

          <HomepageAtmosphereChrome />

          <div id="scent-vault-section" style={{ scrollMarginTop: 'var(--topbar-h)' }}>
            <Wardrobe
              items={items}
              onDelete={handleDeleteItem}
              onPersistWardrobeImage={handlePersistWardrobeImage}
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
          </div>
        </div>
      </main>

      <ScentIntentModal isOpen={isIntentModalOpen} onClose={() => setIsIntentModalOpen(false)} onComplete={handleIntentComplete} />

      <AnimatePresence mode="wait">
        {activeRecommendation && (
          <motion.div
            ref={recommendationOverlayRef}
            key="recommendation-overlay"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeInOut' }}
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
              <button ref={recommendationCloseRef} onClick={closeRecommendationOverlay} className="-m-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-scent-text-subtle hover:text-white hover:bg-white/10 transition-all active:scale-95" aria-label="Close recommendation">
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
                      <ScentNotesInfographic
                        derivedMetrics={
                          activeRecommendation.derived_metrics ??
                          activeRecommendation.raw_engine_detail?.derived_metrics ??
                          null
                        }
                        legacyPyramid={activeRecommendation.pyramid}
                        scentAxesFallback={activeRecommendation.scent_vector ?? null}
                      />
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
          </motion.div>
        )}
      </AnimatePresence>

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
  const guestBanner = (
    <AnimatePresence>
      {showGuestBanner ? (
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
      ) : null}
    </AnimatePresence>
  );

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

  const shareModal = (
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
  );

  const profileModal = (
    <ProfileSettingsModal
      isOpen={isProfileModalOpen}
      onClose={() => setIsProfileModalOpen(false)}
      authToken={authToken}
      currentUsername={authUsername}
      onSaved={setAuthUsername}
    />
  );

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

const AppContent = React.memo(function AppContent({ location }: { location: Location }) {
  return (
    <>
      <React.Suspense fallback={<RouteChunkFallback />}>
        <Routes location={location}>
          <Route path="/" element={<DashboardView />} />
          <Route path="/community" element={<CommunityPageView />} />
          <Route path="/debug/ipad-freeze" element={<IpadFreezeLab />} />
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
}: {
  renderedLocation: Location;
  showThreadBackground: boolean;
}) {
  return (
    <AuthProvider>
      <WeatherProvider>
        <WardrobeProvider>
          <div className="scent-app-shell min-h-[100svh] bg-scent-bg selection:bg-scent-accent selection:text-black text-white relative overflow-x-hidden">
            {showThreadBackground ? <ThreadBackground /> : null}
            <AppContent location={renderedLocation} />
            <Toaster />
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
  const isFreezeLab = renderedLocation.pathname === '/debug/ipad-freeze';
  // The thread background's per-frame rAF transform loop presents smoothly on
  // iPhone/desktop, but on iPad's large retina viewport it contends with
  // Safari's compositor during fast scroll and image decode (janky scroll, late
  // image paint, laggy card taps). Render it everywhere except iPad and the
  // freeze lab. It still composes a static (no rAF loop) arrangement under
  // prefers-reduced-motion — that branch lives inside ThreadBackground itself.
  const { lowMotionRenderMode, isIpad } = useRenderBudget();
  const showThreadBackground = !isFreezeLab && !isIpad;
  const transitionTiming = useMemo(
    () => (lowMotionRenderMode ? PAGE_TRANSITION_TIMING.lowMotion : PAGE_TRANSITION_TIMING.standard),
    [lowMotionRenderMode],
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

  useLayoutEffect(() => {
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

  return (
    <>
      <AppShell renderedLocation={renderedLocation} showThreadBackground={showThreadBackground} />
      <PageTransitionOverlay visible={transitionVisible} animationKey={transitionKey} />
    </>
  );
}
