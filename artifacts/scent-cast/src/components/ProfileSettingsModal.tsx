import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, CloudSun, LocateFixed, LoaderCircle, UserRound, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useModalBehavior } from '@/hooks/use-modal-behavior';
import { useWeather } from '@/context/WeatherContext';

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
  const modalRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(currentUsername ?? '');
      setError(null);
    }
  }, [isOpen, currentUsername]);

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
                    className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-scent-accent/35 bg-[#d4af37] px-4 py-3 text-[13px] font-bold uppercase tracking-[0.16em] text-black shadow-[0_14px_34px_rgba(212,175,55,0.16)] transition-colors hover:bg-[#e6c85e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:cursor-wait disabled:opacity-70"
                  >
                    {locating ? (
                      <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <LocateFixed size={15} strokeWidth={2} aria-hidden="true" />
                    )}
                    {locating ? 'Locating' : locationButtonLabel}
                  </button>
                </section>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
