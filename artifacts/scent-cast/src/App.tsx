import React, { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'react';
import { Routes, Route, useParams } from 'react-router-dom';
import { FragranceCapture } from './components/FragranceCapture';
import { Wardrobe, Fragrance, DestinationType, EnergyState } from './components/Wardrobe';
import { Wind, Play, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScentIntentModal } from './components/ScentIntentModal';
import { ScentNotesInfographic } from './components/ScentNotesInfographic';
import { LavaBackground } from './components/LavaBackground';
import { AppTopNav } from './components/AppTopNav';
import { AuthModal } from './components/AuthModal';
import { SharePage } from './components/SharePage';
import { ShareModal } from './components/ShareModal';
import { APP_BRAND_MARK } from './lib/appBrand';
import type { ScentFamily, ScentWeatherRecommendation } from './lib/scentWeatherEngine';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WeatherProvider, useWeather } from './context/WeatherContext';
import { WardrobeProvider, useWardrobe, useWardrobeShareModalActions } from './context/WardrobeContext';
import { Toaster } from './components/ui/toaster';
import CommunityPage from '@/pages/community';

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
  return (
    <span
      className="font-serif italic tracking-normal text-inherit leading-[1.05] text-[#fff7ec] tabular-nums"
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}
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

const AtmosphereBar: React.FC<AtmosphereBarProps> = React.memo(({ weather, weatherLoading }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);

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
  const temp = weatherLoading ? '—' : Number.isFinite(tempValue) ? `${Math.round(tempValue)}°F` : '—';
  const condition = weatherLoading ? '—' : getWeatherString(weather, ['condition', 'description'], '—');
  const humidity = weatherLoading ? '—' : Number.isFinite(humidityValue) ? `${humidityValue}%` : '—';
  const location = weather?.location ?? '—';
  const atmosphereTrackKey = [condition, humidity, temp, location].join('|');

  const metrics = [
    { label: 'Matrix', value: condition },
    { label: 'Saturation', value: humidity },
    { label: 'Chronos', value: <LiveClock /> },
    { label: 'Atmosphere', value: temp },
    { label: 'Coordinate', value: location },
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
        ? 240
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

    track.dataset.marqueeReady = 'false';

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
  }, [condition, humidity, temp, location]);

  return (
    <section className="scent-atmosphere-marquee" aria-label="Current atmosphere">
      <div className="scent-atmosphere-marquee-track" key={atmosphereTrackKey} ref={trackRef}>
        {[...Array(ATMOSPHERE_TRACK_COPIES)].map((_, copyIndex) => (
          <div
            className="scent-atmosphere-marquee-group"
            key={copyIndex}
            ref={copyIndex === 0 ? groupRef : undefined}
            aria-hidden={copyIndex > 0}
          >
            {metrics.map((metric) => (
              <div key={metric.label} className="scent-atmosphere-marquee-cell">
                <span className="scent-atmosphere-label">{metric.label}</span>
                <span className="scent-atmosphere-value">{metric.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
});

function DashboardView() {
  const { authToken, handleSignOut, setIsAuthModalOpen } = useAuth();
  const { weather, weatherLoading } = useWeather();
  const {
    items,
    wardrobeLoaded,
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
    setIsIntentModalOpen,
    setIsShareModalOpen,
    handleAddItem,
    handlePersistWardrobeImage,
    handleRevertWardrobe,
    handleDeleteItem,
    handleIntentComplete,
    closeRecommendationOverlay,
    handleVaultSearchStateChange,
    handleExpandArchive,
  } = useWardrobe();

  const tickerPhrases = useMemo(() => {
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
  }, [items]);

  const tickerTrackKey = tickerPhrases.join('|');

  return (
    <div className="min-h-[100svh] relative overflow-x-hidden">
      <AppTopNav
        authToken={authToken}
        onSignIn={() => setIsAuthModalOpen(true)}
        onShare={() => setIsShareModalOpen(true)}
        onSignOut={handleSignOut}
      />

      <div className="pt-16 sm:pt-[72px]" />

      <main className="relative z-10 pb-24 px-4 sm:px-8 max-w-[1760px] mx-auto">
        <div className="space-y-20 sm:space-y-28 pt-10 sm:pt-14">
          <div className="scent-marquee-band scent-full-bleed w-full overflow-hidden py-[17px] sm:py-[18px] flex select-none relative">
            <div key={tickerTrackKey} className="scent-marquee-track-row flex animate-infinite-scroll whitespace-nowrap scent-marquee-text">
              {[...Array(4)].map((_, i) => (
                <span key={i} className="scent-marquee-phrase-group flex items-center" aria-hidden={i > 0}>
                  {tickerPhrases.map((phrase, j) => (
                    <React.Fragment key={phrase}>
                      <span className="scent-marquee-phrase whitespace-nowrap">{phrase}</span>
                      {j < tickerPhrases.length - 1 ? (
                        <span className="scent-marquee-divider shrink-0" aria-hidden="true" />
                      ) : null}
                    </React.Fragment>
                  ))}
                </span>
              ))}
            </div>
          </div>

          <section className="scent-hero-zone mx-auto w-full max-w-2xl space-y-7 text-center">
            <h2 className="font-serif italic text-[clamp(2.15rem,7vw,3.8rem)] text-[#fff7ec] leading-[0.98] tracking-normal">
              Find your signature for the current atmosphere.
            </h2>
            <FragranceCapture onAdd={handleAddItem} onVaultSearchStateChange={handleVaultSearchStateChange} />
            <AnimatePresence initial={false}>
              {items.length >= 3 ? (
                <motion.div
                  key="discover-button"
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: '1.75rem' }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <motion.button
                    type="button"
                    animate={{
                      opacity: vaultSearchUiActive ? 0 : 1,
                      y: vaultSearchUiActive ? 8 : 0,
                    }}
                    transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                    style={{ pointerEvents: vaultSearchUiActive ? 'none' : 'auto' }}
                    tabIndex={vaultSearchUiActive ? -1 : undefined}
                    onClick={() => {
                      setIsIntentModalOpen(true);
                    }}
                    className="scent-primary-button w-full min-h-[60px] sm:h-16 flex items-center justify-center gap-2.5 sm:gap-4 px-4 transition-all group rounded-[var(--radius-scent)]"
                  >
                    <Play size={19} className="fill-current shrink-0 group-hover:scale-110 transition-transform" />
                    <span className="font-serif italic text-lg sm:text-2xl leading-tight text-center">Discover Your Signature Scent</span>
                  </motion.button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </section>

          <div className="scent-full-bleed">
            <AtmosphereBar weather={weather} weatherLoading={weatherLoading} />
          </div>

          <div>
            <Wardrobe
              items={items}
              onDelete={handleDeleteItem}
              onPersistWardrobeImage={authToken ? handlePersistWardrobeImage : undefined}
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
            />
          </div>
          <section className="hidden">
            <FragranceCapture onAdd={handleAddItem} />
            <button
              onClick={() => {
                if (items.length === 0) { alert("Your vault is empty! Add at least one fragrance to discover your match."); return; }
                setIsIntentModalOpen(true);
              }}
              className="scent-primary-button w-full h-14 flex items-center justify-center gap-4 transition-all group rounded-[var(--radius-scent)]"
            >
              <Play size={19} className="fill-current group-hover:scale-110 transition-transform" />
              <span className="font-serif italic text-xl sm:text-2xl">Discover Your Signature Scent</span>
            </button>
          </section>
        </div>
      </main>

      <ScentIntentModal isOpen={isIntentModalOpen} onClose={() => setIsIntentModalOpen(false)} onComplete={handleIntentComplete} />

      <AnimatePresence mode="wait">
        {activeRecommendation && (
          <motion.div
            key="recommendation-overlay"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeInOut' }}
            className="fixed inset-0 z-[110] bg-black/95 backdrop-blur-3xl flex flex-col"
          >
            {/* Pinned top bar — X always visible */}
            <div
              className="flex items-center justify-between px-5 pb-4 shrink-0"
              style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))' }}
            >
              <p className="text-[9px] uppercase tracking-[0.4em] text-scent-accent font-bold">Strategic Alignment Found</p>
              <button onClick={closeRecommendationOverlay} className="p-2 text-white/40 hover:text-white hover:bg-white/10 transition-all active:scale-95">
                <X size={20} />
              </button>
            </div>

            {/* Scrollable middle */}
            <div
              className="flex-1 overflow-y-auto"
              style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
            >
              <div className="flex items-center justify-center min-h-full px-5 py-6 sm:px-16 sm:py-12">
                <div className="max-w-2xl w-full text-center space-y-6 sm:space-y-12">
                  <header>
                    <h2 className="font-serif italic text-2xl sm:text-6xl mb-4">You should wear</h2>
                    <div className="h-px w-16 bg-white/20 mx-auto" />
                  </header>
                  <div className="py-6 sm:py-16 border-y border-white/10 group cursor-pointer" onClick={closeRecommendationOverlay}>
                    <p className="text-sm uppercase tracking-[0.2em] text-white/40 mb-2 font-serif">{activeRecommendation.brand}</p>
                    <h3 className="font-serif italic text-3xl sm:text-8xl text-white leading-tight transition-transform group-hover:scale-105">{activeRecommendation.name}</h3>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-12 text-left">
                    <div>
                      <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Olfactory Reason</p>
                      <p className="text-sm italic text-scent-muted leading-relaxed">{recommendationReason || 'Optimal olfactory alignment with your current atmospheric conditions.'}</p>
                    </div>
                    {activeRecommendation.concentration && activeRecommendation.concentration !== 'Unknown' && (
                    <div>
                      <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Concentration</p>
                      <p className="text-sm italic text-scent-muted leading-relaxed">{activeRecommendation.concentration}</p>
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
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Best Families</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{formatFamilyList(activeEngineRecommendation.best_scent_families)}</p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Avoid Today</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{formatAvoidList(activeEngineRecommendation.avoid_scent_families)}</p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Sprays</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{formatSprayCount(activeEngineRecommendation.spray_count)}</p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Projection Risk</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{titleCaseToken(activeEngineRecommendation.projection_risk)}</p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase tracking-[0.3em] text-scent-muted mb-2 font-bold">Confidence</p>
                          <p className="text-sm italic text-scent-muted leading-relaxed">{titleCaseToken(activeEngineRecommendation.confidence)}</p>
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
              style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-top))' }}
            >
              <button onClick={closeRecommendationOverlay} className="w-full py-4 bg-scent-accent text-black uppercase tracking-[0.3em] text-[10px] font-bold hover:opacity-90 transition-opacity active:scale-[0.98]">
                Confirm Alignment
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="relative z-10 border-t border-scent-accent/10 py-16 px-8 mt-24">
        <div className="max-w-[1400px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center gap-2 opacity-30">
            <Wind size={18} />
            <p className="font-serif font-bold italic tracking-tighter uppercase">{APP_BRAND_MARK}</p>
          </div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-scent-muted">© 2026 Olfactory Intelligence Systems</p>
        </div>
      </footer>
    </div>
  );
}

function CommunityPageView() {
  const { authToken, handleSignOut, setIsAuthModalOpen } = useAuth();
  const { setIsShareModalOpen } = useWardrobeShareModalActions();
  return (
    <CommunityPage
      authToken={authToken}
      onSignIn={() => setIsAuthModalOpen(true)}
      onShare={() => setIsShareModalOpen(true)}
      onSignOut={handleSignOut}
    />
  );
}

function SharePageView() {
  const { userId } = useParams<{ userId: string }>();
  return <SharePage userId={userId || ''} />;
}

function GlobalModals() {
  const {
    authToken,
    isAuthModalOpen,
    setIsAuthModalOpen,
    guestPromptDismissed,
    setGuestPromptDismissed,
    handleAuth,
  } = useAuth();

  const { items, setItems, isShareModalOpen, setIsShareModalOpen, userId } = useWardrobe();

  const authModal = isAuthModalOpen ? (
    <AuthModal
      onAuth={handleAuth}
      onClose={() => {
        setIsAuthModalOpen(false);
        setGuestPromptDismissed(true);
      }}
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

  return (
    <>
      {authModal}
      {shareModal}
    </>
  );
}

function AppContent() {
  return (
    <>
      <Routes>
        <Route path="/" element={<DashboardView />} />
        <Route path="/community" element={<CommunityPageView />} />
        <Route path="/share/:userId" element={<SharePageView />} />
      </Routes>
      <GlobalModals />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <WeatherProvider>
        <WardrobeProvider>
          <div className="scent-app-shell min-h-[100svh] bg-scent-bg selection:bg-scent-accent selection:text-black text-white relative overflow-x-hidden">
            <LavaBackground />
            <AppContent />
            <Toaster />
          </div>
        </WardrobeProvider>
      </WeatherProvider>
    </AuthProvider>
  );
}
