import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BellRing, Check, CloudSun, LocateFixed, LoaderCircle, UserRound, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useModalBehavior } from '@/hooks/use-modal-behavior';
import { useWeather } from '@/context/WeatherContext';
import {
  getPushSupport,
  getServerPushConfig,
  getPushPreferences,
  isPushSubscribed,
  setPushPreferences,
  subscribeToPush,
  unsubscribeFromPush,
  type PushPreferences,
} from '@/lib/pushNotifications';
import { isIosDevice, isStandalonePwa } from '@/lib/platform';

// Notification toggle states. 'unsupported'/'unconfigured' hide the section
// (no point offering a control that can't work); the rest render it.
type PushState = 'unknown' | 'unsupported' | 'unconfigured' | 'on' | 'off' | 'denied';

interface ProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  authToken: string | null;
  currentUsername: string | null;
  onSaved: (username: string | null) => void;
}

const USERNAME_MAX = 20;
// Mirrors the server contract (PUT /api/me/profile): 3-20 chars, letters/numbers
// and . _ -, never at the start or end. Empty clears the username.
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.\-]{1,18}[a-zA-Z0-9])$/;

const LOCATION_STATUS_COPY = {
  idle: 'Default weather source',
  requesting: 'Requesting location',
  granted: 'Current location active',
  denied: 'Location access blocked',
  unsupported: 'Location unavailable',
} as const;

const LOCATION_SOURCE_COPY = {
  fallback: 'Regional fallback',
  preferred: 'Saved preference',
  browser: 'Device location',
} as const;

/** Compact labelled switch used for the per-category notification toggles. */
const NotificationToggle: React.FC<{
  label: string;
  description: string;
  checked: boolean;
  busy: boolean;
  disabled?: boolean;
  onToggle: () => void;
}> = ({ label, description, checked, busy, disabled, onToggle }) => (
  <div className="flex items-center justify-between gap-3 rounded-[10px] border border-white/10 bg-black/20 px-3.5 py-3">
    <div className="min-w-0 flex-1">
      <p className="text-[12px] font-semibold leading-snug text-white/80">{label}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-white/40">{description}</p>
    </div>
    <button
      type="button"
      onClick={onToggle}
      disabled={busy || disabled}
      role="switch"
      aria-checked={checked}
      aria-label={`Toggle ${label}`}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40 disabled:cursor-wait disabled:opacity-70 ${
        checked ? 'border-scent-accent/60 bg-scent-accent/30' : 'border-white/15 bg-white/5'
      }`}
    >
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      >
        {busy && <LoaderCircle size={11} className="animate-spin text-black/60" aria-hidden="true" />}
      </span>
    </button>
  </div>
);

export const ProfileSettingsModal: React.FC<ProfileSettingsModalProps> = ({
  isOpen,
  onClose,
  authToken,
  currentUsername,
  onSaved,
}) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { weather, weatherLoading, locationStatus, locationSource, requestLocation } = useWeather();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState>('unknown');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushPrefs, setPushPrefs] = useState<PushPreferences>({ weather: true, community: true });
  const [prefBusy, setPrefBusy] = useState<null | keyof PushPreferences>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(currentUsername ?? '');
      setError(null);
    }
  }, [isOpen, currentUsername]);

  // Resolve the notification toggle's state when the modal opens: browser
  // support, then server VAPID config, then this device's current subscription.
  useEffect(() => {
    if (!isOpen || !authToken) return;
    let cancelled = false;
    void (async () => {
      const support = getPushSupport();
      if (!support.supported) {
        if (!cancelled) setPushState('unsupported');
        return;
      }
      if (support.permission === 'denied') {
        if (!cancelled) setPushState('denied');
        return;
      }
      const config = await getServerPushConfig();
      if (cancelled) return;
      if (!config.configured) {
        setPushState('unconfigured');
        return;
      }
      const subscribed = await isPushSubscribed();
      if (!cancelled) setPushState(subscribed ? 'on' : 'off');
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, authToken]);

  // Load per-category opt-ins once notifications are actually on for this device.
  useEffect(() => {
    if (!isOpen || !authToken || pushState !== 'on') return;
    let cancelled = false;
    void (async () => {
      const data = await getPushPreferences(authToken);
      if (!cancelled && data) setPushPrefs(data.preferences);
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, authToken, pushState]);

  useModalBehavior({
    isOpen,
    containerRef: modalRef,
    initialFocusRef: inputRef,
    onDismiss: onClose,
  });

  const trimmed = value.trim();
  const unchanged = trimmed === (currentUsername ?? '');
  const formatInvalid = trimmed.length > 0 && !USERNAME_RE.test(trimmed);
  const locating = locationStatus === 'requesting';
  const locationButtonLabel = locationStatus === 'granted'
    ? 'Refresh current location'
    : 'Use current location';
  const locationSourceLabel = locating
    ? 'Awaiting permission'
    : LOCATION_SOURCE_COPY[locationSource];
  const weatherLocation = typeof weather?.location === 'string' && weather.location.trim()
    ? weather.location.trim()
    : 'Not set';

  const handleSave = async () => {
    if (!authToken || saving) return;
    if (formatInvalid) {
      setError('Use 3-20 characters: letters, numbers, and . _ - only (not at the start or end).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/me/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ username: trimmed }),
      });
      const data = (await res.json().catch(() => null)) as { username?: string | null; error?: string } | null;
      if (!res.ok) {
        throw new Error(data?.error || `Could not save (HTTP ${res.status}).`);
      }
      const savedUsername = typeof data?.username === 'string' ? data.username : null;
      onSaved(savedUsername);
      // Author names are baked into cached community payloads, so refetch after a rename.
      void queryClient.invalidateQueries({ queryKey: ['community'] });
      toast({
        title: savedUsername ? 'Username updated' : 'Username cleared',
        description: savedUsername
          ? `You'll appear as "${savedUsername}" in the community.`
          : 'Your posts now show a private alias.',
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your username.');
    } finally {
      setSaving(false);
    }
  };

  const handleLocationRequest = () => {
    if (locating) return;
    void requestLocation();
  };

  const handleTogglePush = async () => {
    if (!authToken || pushBusy) return;
    setPushBusy(true);
    try {
      if (pushState === 'on') {
        await unsubscribeFromPush(authToken);
        setPushState('off');
        toast({ title: 'Notifications off', description: "You won't get scent nudges on this device." });
        return;
      }
      const result = await subscribeToPush(authToken);
      if (result.ok) {
        setPushState('on');
        toast({ title: 'Notifications on', description: "We'll send the occasional scent nudge." });
      } else if (result.reason === 'denied') {
        setPushState('denied');
        toast({
          title: 'Permission blocked',
          description:
            isIosDevice() && isStandalonePwa()
              ? 'Open the iOS Settings app ▸ Notifications ▸ ScentBeam to allow them, then try again.'
              : 'Enable notifications for ScentBeam in your browser settings, then try again.',
        });
      } else if (result.reason === 'not-configured') {
        setPushState('unconfigured');
      } else {
        toast({ title: 'Could not enable notifications', description: 'Please try again in a moment.' });
      }
    } finally {
      setPushBusy(false);
    }
  };

  const handleToggleCategory = async (category: keyof PushPreferences) => {
    if (!authToken || prefBusy) return;
    const nextValue = !pushPrefs[category];
    setPushPrefs((prev) => ({ ...prev, [category]: nextValue })); // optimistic
    setPrefBusy(category);
    try {
      const saved = await setPushPreferences(authToken, { [category]: nextValue });
      if (saved) {
        setPushPrefs(saved);
      } else {
        setPushPrefs((prev) => ({ ...prev, [category]: !nextValue })); // revert
        toast({ title: "Couldn't update", description: 'Please try again in a moment.' });
      }
    } finally {
      setPrefBusy(null);
    }
  };

  // iOS only grants Web Push inside an installed PWA. When unsupported there but
  // not yet installed, show an install nudge instead of silently hiding push.
  const iosNeedsInstall = pushState === 'unsupported' && isIosDevice() && !isStandalonePwa();
  // Where a blocked user must go to re-allow: iOS standalone has no browser
  // chrome, so it's the system Settings app, not "site settings".
  const deniedHelp =
    isIosDevice() && isStandalonePwa()
      ? 'Open the iOS Settings app ▸ Notifications ▸ ScentBeam to allow them, then come back.'
      : 'Allow notifications for ScentBeam in your browser site settings, then try again.';
  const showPushSection =
    Boolean(authToken) &&
    (pushState === 'on' || pushState === 'off' || pushState === 'denied' || iosNeedsInstall);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-end justify-center sm:items-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/90"
          />
          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="relative max-h-[92svh] w-full overflow-hidden border-t border-white/10 bg-neutral-950 shadow-2xl sm:mx-6 sm:max-w-xl sm:rounded-[1.5rem] sm:border"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-modal-title"
          >
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-scent-accent" />
                <div className="min-w-0">
                  <p id="profile-modal-title" className="text-[9px] font-bold uppercase tracking-[0.5em] text-scent-accent">
                    Settings
                  </p>
                  <p className="mt-0.5 font-sans text-[9px] text-white/40">Account and atmosphere</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="group ml-3 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              >
                <X size={16} className="transition-transform duration-300 group-hover:rotate-90" />
              </button>
            </div>

            <div className="max-h-[calc(92svh-5.5rem)] overflow-y-auto px-5 py-5 sm:px-6 sm:py-6">
              <div className="space-y-4">
                <section className="rounded-[12px] border border-white/10 bg-white/[0.025] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/20 bg-scent-accent/[0.08] text-scent-accent">
                      <UserRound size={16} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.34em] text-[#fff7ec]">Profile</h3>
                      <p className="mt-0.5 text-[11px] text-white/35">Community identity</p>
                    </div>
                  </div>

                  <form
                    className="space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSave();
                    }}
                  >
                    <label htmlFor="profile-username" className="block">
                      <span className="text-[9px] font-bold uppercase tracking-[0.32em] text-white/35">Username</span>
                      <input
                        id="profile-username"
                        ref={inputRef}
                        type="text"
                        value={value}
                        maxLength={USERNAME_MAX}
                        onChange={(event) => {
                          setValue(event.target.value);
                          if (error) setError(null);
                        }}
                        placeholder="e.g. velvet_oud"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="mt-2 w-full rounded-[10px] border border-white/10 bg-black/30 px-4 py-3 font-sans text-base text-white outline-none transition-all placeholder:text-white/35 focus:border-scent-accent/45 focus:ring-2 focus:ring-scent-accent/10"
                      />
                    </label>

                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] leading-snug text-white/35" aria-live="polite">
                        {error ? (
                          <span className="text-red-300">{error}</span>
                        ) : (
                          'Letters, numbers, and . _ -; leave blank to stay anonymous.'
                        )}
                      </p>
                      <span className="shrink-0 font-mono text-[11px] text-white/30">
                        {trimmed.length}/{USERNAME_MAX}
                      </span>
                    </div>

                    <button
                      type="submit"
                      disabled={saving || unchanged || formatInvalid || !authToken}
                      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-scent-accent/30 bg-scent-accent/[0.08] px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.16em] text-[#fff7ec] transition-colors hover:border-scent-accent/55 hover:bg-scent-accent/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/35 disabled:pointer-events-none disabled:opacity-45"
                    >
                      {saving ? (
                        <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Check size={15} strokeWidth={2} aria-hidden="true" />
                      )}
                      {saving ? 'Saving' : 'Save username'}
                    </button>
                  </form>
                </section>

                <section className="rounded-[12px] border border-scent-accent/20 bg-[linear-gradient(180deg,rgba(212,175,55,0.07),rgba(255,255,255,0.025))] p-4 shadow-[inset_0_1px_0_rgba(255,236,183,0.08)]">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/24 bg-black/35 text-scent-accent">
                      <CloudSun size={17} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.34em] text-[#fff7ec]">Atmosphere</h3>
                      <p className="mt-0.5 text-[11px] text-white/35">{locationSourceLabel}</p>
                    </div>
                  </div>

                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-[10px] border border-white/10 bg-black/25 px-3.5 py-3">
                      <dt className="text-[9px] font-bold uppercase tracking-[0.28em] text-white/30">Location</dt>
                      <dd className="mt-1 min-w-0 truncate text-sm text-[#fff7ec]" title={weatherLoading ? 'Loading' : weatherLocation}>
                        {weatherLoading ? 'Loading' : weatherLocation}
                      </dd>
                    </div>
                    <div className="rounded-[10px] border border-white/10 bg-black/25 px-3.5 py-3">
                      <dt className="text-[9px] font-bold uppercase tracking-[0.28em] text-white/30">Status</dt>
                      <dd className="mt-1 min-w-0 truncate text-sm text-[#fff7ec]" title={LOCATION_STATUS_COPY[locationStatus]}>
                        {LOCATION_STATUS_COPY[locationStatus]}
                      </dd>
                    </div>
                  </dl>

                  <button
                    type="button"
                    onClick={handleLocationRequest}
                    disabled={locating}
                    className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-scent-accent/35 bg-[#d4af37] px-4 py-3 text-[13px] font-bold uppercase tracking-[0.16em] text-black shadow-[0_14px_34px_-20px_rgba(0,0,0,0.6)] transition-colors hover:bg-[#e6c85e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:cursor-wait disabled:opacity-70"
                  >
                    {locating ? (
                      <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <LocateFixed size={15} strokeWidth={2} aria-hidden="true" />
                    )}
                    {locating ? 'Locating' : locationButtonLabel}
                  </button>
                </section>

                {showPushSection && (
                  <section className="rounded-[12px] border border-white/10 bg-white/[0.025] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    <div className="mb-4 flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/20 bg-scent-accent/[0.08] text-scent-accent">
                        <BellRing size={16} aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-[10px] font-bold uppercase tracking-[0.34em] text-[#fff7ec]">Notifications</h3>
                        <p className="mt-0.5 text-[11px] text-white/35">Scent nudges on this device</p>
                      </div>
                    </div>

                    {iosNeedsInstall ? (
                      <div className="rounded-[10px] border border-scent-accent/20 bg-scent-accent/[0.06] px-3.5 py-3">
                        <p className="text-[11px] font-semibold leading-snug text-[#fff7ec]">
                          Add ScentBeam to your Home Screen first
                        </p>
                        <p className="mt-1 text-[11px] leading-snug text-white/50">
                          On iPhone &amp; iPad, notifications work only in the installed app. In Safari,
                          tap the <span className="text-white/75">Share</span> icon, then{' '}
                          <span className="text-white/75">Add to Home Screen</span> — open ScentBeam from
                          there and this toggle appears.
                        </p>
                      </div>
                    ) : pushState === 'denied' ? (
                      <p className="text-[11px] leading-snug text-white/45">
                        Notifications are blocked for ScentBeam. {deniedHelp}
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <p className="min-w-0 flex-1 text-[11px] leading-snug text-white/45">
                            {pushState === 'on'
                              ? "Notifications are on for this device."
                              : 'Get the occasional scent-of-the-day nudge.'}
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleTogglePush()}
                            disabled={pushBusy}
                            role="switch"
                            aria-checked={pushState === 'on'}
                            aria-label="Toggle scent notifications"
                            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40 disabled:cursor-wait disabled:opacity-70 ${
                              pushState === 'on'
                                ? 'border-scent-accent/60 bg-scent-accent/30'
                                : 'border-white/15 bg-white/5'
                            }`}
                          >
                            <span
                              className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-transform ${
                                pushState === 'on' ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            >
                              {pushBusy && <LoaderCircle size={11} className="animate-spin text-black/60" aria-hidden="true" />}
                            </span>
                          </button>
                        </div>

                        {pushState === 'on' && (
                          <div className="mt-3 space-y-2">
                            <p className="text-[9px] font-bold uppercase tracking-[0.28em] text-white/30">
                              What to send
                            </p>
                            <NotificationToggle
                              label="Scent weather nudges"
                              description="When the weather shifts your perfect wear."
                              checked={pushPrefs.weather}
                              busy={prefBusy === 'weather'}
                              onToggle={() => void handleToggleCategory('weather')}
                            />
                            <NotificationToggle
                              label="Community replies"
                              description="When someone replies to your posts or comments."
                              checked={pushPrefs.community}
                              busy={prefBusy === 'community'}
                              onToggle={() => void handleToggleCategory('community')}
                            />
                          </div>
                        )}

                        <p className="mt-3 text-[10px] leading-snug text-white/35">
                          We only use your saved city and weather to time these — no tracking, no
                          message content leaves your device. Turn them off anytime here or in your
                          device settings.
                        </p>
                      </>
                    )}
                  </section>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
