import React, { useEffect, useRef, useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { SCENT_EASE_OUT_EXPO } from '@/lib/motion';
import { BellRing, Check, CloudSun, Languages, LocateFixed, LoaderCircle, Palette, UserRound, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useModalBehavior } from '@/hooks/use-modal-behavior';
import { useWeather } from '@/context/WeatherContext';
import { useTheme, type AccentName, type ThemeMode } from '@/context/ThemeContext';
import { useTranslation, LOCALE_LABELS, DELIVERED_LOCALES, type Locale } from '@/i18n';
import { savePreferences } from '@/lib/preferences';
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
      aria-label={label}
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

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  swatch?: string;
}

/** Pill-segmented selector matching the panel's dark cards. The active segment
 *  picks up the live accent, so it doubles as a preview of the accent choice. */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 2)}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`flex min-h-[3.25rem] flex-col items-start justify-center gap-0.5 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40 ${
              active
                ? 'border-scent-accent/60 bg-scent-accent/[0.12]'
                : 'border-white/10 bg-black/20 hover:border-white/20'
            }`}
          >
            <span className="flex items-center gap-2">
              {option.swatch ? (
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/25"
                  style={{ background: option.swatch }}
                />
              ) : null}
              <span className={`text-[12px] font-semibold leading-snug ${active ? 'text-[#fff7ec]' : 'text-white/80'}`}>
                {option.label}
              </span>
            </span>
            {option.hint ? (
              <span className="text-[10px] leading-snug text-white/40">{option.hint}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

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
  const { t, locale, setLocale } = useTranslation();
  const { theme, accent, setTheme, setAccent } = useTheme();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState>('unknown');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushPrefs, setPushPrefs] = useState<PushPreferences>({ weather: true, community: true, curation: true });
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
    ? t('atmosphere.refreshLocation')
    : t('atmosphere.useLocation');
  const locationSourceLabel = locating
    ? t('atmosphere.awaitingPermission')
    : t(`atmosphere.source.${locationSource}`);
  const weatherLocation = typeof weather?.location === 'string' && weather.location.trim()
    ? weather.location.trim()
    : t('atmosphere.notSet');

  // Appearance + language: apply locally for an instant, offline-capable switch,
  // then best-effort sync to the account so the choice follows the user across
  // devices (no-op for guests / offline — the local change still sticks).
  const handleThemeChange = (next: ThemeMode) => {
    if (next === theme) return;
    setTheme(next);
    if (authToken) void savePreferences(authToken, { theme: next });
  };
  const handleAccentChange = (next: AccentName) => {
    if (next === accent) return;
    setAccent(next);
    if (authToken) void savePreferences(authToken, { accent: next });
  };
  const handleLocaleChange = (next: Locale) => {
    if (next === locale) return;
    setLocale(next);
    if (authToken) void savePreferences(authToken, { locale: next });
    toast({
      title: t('language.savedTitle'),
      description: t('language.savedDescription', { language: LOCALE_LABELS[next] }),
    });
  };

  const handleSave = async () => {
    if (!authToken || saving) return;
    if (formatInvalid) {
      setError(t('profile.formatError'));
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
        title: savedUsername ? t('profile.savedTitle') : t('profile.clearedTitle'),
        description: savedUsername
          ? t('profile.savedDescription', { username: savedUsername })
          : t('profile.clearedDescription'),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.genericError'));
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
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/90"
          />
          <m.div
            ref={modalRef}
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ duration: 0.25, ease: SCENT_EASE_OUT_EXPO }}
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
                    {t('settings.eyebrow')}
                  </p>
                  <p className="mt-0.5 font-sans text-[9px] text-white/40">{t('settings.subtitle')}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('common.close')}
                className="group ml-3 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              >
                <X size={16} className="transition-transform duration-300 group-hover:rotate-90" />
              </button>
            </div>

            {/* pb honors the home-indicator safe area — on phones this modal is
                a bottom sheet, so the last card must not sit under the inset. */}
            <div className="max-h-[calc(92svh-5.5rem)] overflow-y-auto px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] sm:px-6 sm:pt-6 sm:pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
              <div className="space-y-4">
                <section className="rounded-[12px] border border-white/10 bg-white/[0.025] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/20 bg-scent-accent/[0.08] text-scent-accent">
                      <UserRound size={16} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.34em] text-[#fff7ec]">{t('profile.title')}</h3>
                      <p className="mt-0.5 text-[11px] text-white/35">{t('profile.subtitle')}</p>
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
                      <span className="text-[9px] font-bold uppercase tracking-[0.32em] text-white/35">{t('profile.usernameLabel')}</span>
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
                        placeholder={t('profile.usernamePlaceholder')}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="mt-2 w-full rounded-[10px] border border-white/10 bg-black/30 px-4 py-3 font-sans text-base text-white outline-none transition-[border-color,box-shadow] placeholder:text-white/35 focus:border-scent-accent/45 focus:ring-2 focus:ring-scent-accent/10"
                      />
                    </label>

                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] leading-snug text-white/35" aria-live="polite">
                        {error ? (
                          <span className="text-red-300">{error}</span>
                        ) : (
                          t('profile.help')
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
                      {saving ? t('profile.saving') : t('profile.save')}
                    </button>
                  </form>
                </section>

                <section className="rounded-[12px] border border-white/10 bg-white/[0.025] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/20 bg-scent-accent/[0.08] text-scent-accent">
                      <Palette size={16} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.34em] text-[#fff7ec]">{t('appearance.title')}</h3>
                      <p className="mt-0.5 text-[11px] text-white/35">{t('appearance.subtitle')}</p>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.28em] text-white/30">{t('appearance.themeLabel')}</p>
                      <SegmentedControl<ThemeMode>
                        ariaLabel={t('appearance.themeLabel')}
                        value={theme}
                        onChange={handleThemeChange}
                        options={[
                          { value: 'dark', label: t('appearance.themeDark'), hint: t('appearance.themeDarkHint') },
                          { value: 'light', label: t('appearance.themeLight'), hint: t('appearance.themeLightHint') },
                        ]}
                      />
                    </div>
                    <div>
                      <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.28em] text-white/30">{t('appearance.accentLabel')}</p>
                      <SegmentedControl<AccentName>
                        ariaLabel={t('appearance.accentLabel')}
                        value={accent}
                        onChange={handleAccentChange}
                        options={[
                          { value: 'gold', label: t('appearance.accentGold'), hint: t('appearance.accentGoldHint'), swatch: '#d4af37' },
                          { value: 'green', label: t('appearance.accentGreen'), hint: t('appearance.accentGreenHint'), swatch: '#5e984e' },
                        ]}
                      />
                    </div>
                  </div>
                </section>

                {/* Only surface the language picker when more than one locale is
                    fully delivered (see DELIVERED_LOCALES). With a single
                    delivered locale a picker would be a dead one-option control,
                    so the section is hidden until another language is complete. */}
                {DELIVERED_LOCALES.length > 1 ? (
                  <section className="rounded-[12px] border border-white/10 bg-white/[0.025] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    <div className="mb-4 flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/20 bg-scent-accent/[0.08] text-scent-accent">
                        <Languages size={16} aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-[10px] font-bold uppercase tracking-[0.34em] text-[#fff7ec]">{t('language.title')}</h3>
                        <p className="mt-0.5 text-[11px] text-white/35">{t('language.subtitle')}</p>
                      </div>
                    </div>

                    <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.28em] text-white/30">{t('language.label')}</p>
                    <SegmentedControl<Locale>
                      ariaLabel={t('language.label')}
                      value={locale}
                      onChange={handleLocaleChange}
                      options={DELIVERED_LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code] }))}
                    />
                  </section>
                ) : null}

                <section className="rounded-[12px] border border-scent-accent/20 bg-[linear-gradient(180deg,rgb(var(--scent-accent-rgb)/0.07),rgba(255,255,255,0.025))] p-4 shadow-[inset_0_1px_0_rgba(255,236,183,0.08)]">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/24 bg-black/35 text-scent-accent">
                      <CloudSun size={17} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.34em] text-[#fff7ec]">{t('atmosphere.title')}</h3>
                      <p className="mt-0.5 text-[11px] text-white/35">{locationSourceLabel}</p>
                    </div>
                  </div>

                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-[10px] border border-white/10 bg-black/25 px-3.5 py-3">
                      <dt className="text-[9px] font-bold uppercase tracking-[0.28em] text-white/30">{t('atmosphere.locationLabel')}</dt>
                      <dd className="mt-1 min-w-0 truncate text-sm text-[#fff7ec]" title={weatherLoading ? t('atmosphere.loading') : weatherLocation}>
                        {weatherLoading ? t('atmosphere.loading') : weatherLocation}
                      </dd>
                    </div>
                    <div className="rounded-[10px] border border-white/10 bg-black/25 px-3.5 py-3">
                      <dt className="text-[9px] font-bold uppercase tracking-[0.28em] text-white/30">{t('atmosphere.statusLabel')}</dt>
                      <dd className="mt-1 min-w-0 truncate text-sm text-[#fff7ec]" title={t(`atmosphere.status.${locationStatus}`)}>
                        {t(`atmosphere.status.${locationStatus}`)}
                      </dd>
                    </div>
                  </dl>

                  <button
                    type="button"
                    onClick={handleLocationRequest}
                    disabled={locating}
                    className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-scent-accent/35 bg-scent-accent px-4 py-3 text-[13px] font-bold uppercase tracking-[0.16em] text-black shadow-[0_14px_34px_-20px_rgba(0,0,0,0.6)] transition-[filter,background-color] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:cursor-wait disabled:opacity-70"
                  >
                    {locating ? (
                      <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <LocateFixed size={15} strokeWidth={2} aria-hidden="true" />
                    )}
                    {locating ? t('atmosphere.locating') : locationButtonLabel}
                  </button>
                </section>

                {showPushSection && (
                  <section className="rounded-[12px] border border-white/10 bg-white/[0.025] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    <div className="mb-4 flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/20 bg-scent-accent/[0.08] text-scent-accent">
                        <BellRing size={16} aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-[10px] font-bold uppercase tracking-[0.34em] text-[#fff7ec]">{t('notifications.title')}</h3>
                        <p className="mt-0.5 text-[11px] text-white/35">{t('notifications.subtitle')}</p>
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
                              ? t('notifications.on')
                              : t('notifications.off')}
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleTogglePush()}
                            disabled={pushBusy}
                            role="switch"
                            aria-checked={pushState === 'on'}
                            aria-label={t('notifications.toggleAria')}
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
                              {t('notifications.whatToSend')}
                            </p>
                            <NotificationToggle
                              label={t('notifications.weatherLabel')}
                              description={t('notifications.weatherDescription')}
                              checked={pushPrefs.weather}
                              busy={prefBusy === 'weather'}
                              onToggle={() => void handleToggleCategory('weather')}
                            />
                            <NotificationToggle
                              label={t('notifications.communityLabel')}
                              description={t('notifications.communityDescription')}
                              checked={pushPrefs.community}
                              busy={prefBusy === 'community'}
                              onToggle={() => void handleToggleCategory('community')}
                            />
                            <NotificationToggle
                              label={t('notifications.curationLabel')}
                              description={t('notifications.curationDescription')}
                              checked={pushPrefs.curation}
                              busy={prefBusy === 'curation'}
                              onToggle={() => void handleToggleCategory('curation')}
                            />
                          </div>
                        )}

                        <p className="mt-3 text-[10px] leading-snug text-white/35">
                          {t('notifications.privacyNote')}
                        </p>
                      </>
                    )}
                  </section>
                )}
              </div>
            </div>
          </m.div>
        </div>
      )}
    </AnimatePresence>
  );
};
