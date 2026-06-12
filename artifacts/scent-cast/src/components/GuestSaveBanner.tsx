import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// How long the gentle nudge lingers before it bows out on its own.
const AUTO_DISMISS_MS = 9000;

interface GuestSaveBannerProps {
  itemCount: number;
  onSignIn: () => void;
  onDismiss: () => void;
}

/**
 * A gentle, dismissible nudge for guests who have started building a wardrobe
 * locally — the soft counterpart to the hard sign-in modal (which now only
 * interrupts at GUEST_SAVE_PROMPT_THRESHOLD). Anchored just under the topbar so
 * it never collides with FragranceCapture's fixed mobile "Add to Vault" bar at
 * the bottom of the viewport.
 */
interface GuestModeBannerProps {
  onSignIn: () => void;
  onDismiss: () => void;
}

/**
 * Persistent guest-state banner shown immediately after "Continue as guest".
 * Unlike GuestSaveBanner it never auto-dismisses: guest mode is an ongoing
 * state the user should be able to read at their own pace, so it stays until
 * they dismiss it (acknowledgement is persisted upstream) or sign in.
 */
export const GuestModeBanner: React.FC<GuestModeBannerProps> = ({
  onSignIn,
  onDismiss,
}) => {
  return (
    <div
      className="fixed inset-x-0 z-[110] px-3"
      style={{ top: 'var(--topbar-h, 4rem)' }}
      role="status"
    >
      <div className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-scent-accent/30 bg-neutral-950/95 px-4 py-3 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.95)] backdrop-blur-sm">
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-white/75 font-sans sm:text-[13px]">
          <span className="font-semibold text-white">Browsing as guest.</span>{' '}
          Your vault is saved on this device only.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          className="shrink-0 rounded-full border border-scent-accent/70 bg-scent-accent/15 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[#fff7ec] transition-colors hover:bg-scent-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40"
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss guest mode notice"
          className="shrink-0 -my-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/10 hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
        >
          <X size={15} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
};

export const GuestSaveBanner: React.FC<GuestSaveBannerProps> = ({
  itemCount,
  onSignIn,
  onDismiss,
}) => {
  const countLabel = itemCount === 1 ? '1 fragrance' : `${itemCount} fragrances`;

  // Auto-retire after a short while so the nudge makes its point and then bows
  // out instead of permanently occupying the top of the viewport. A ref keeps
  // the timer from resetting on every parent re-render (onDismiss is an inline
  // closure upstream, so its identity changes each render).
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className="fixed inset-x-0 z-[110] px-3"
      style={{ top: 'var(--topbar-h, 4rem)' }}
      role="status"
    >
      <div className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-scent-accent/30 bg-neutral-950/95 px-4 py-3 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.95)] backdrop-blur-sm">
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-white/75 font-sans sm:text-[13px]">
          <span className="font-semibold text-white">{countLabel}</span> saved on this device.
          Sign in to keep them across devices.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          className="shrink-0 rounded-full border border-scent-accent/70 bg-scent-accent/15 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[#fff7ec] transition-colors hover:bg-scent-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40"
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 -my-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/10 hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
        >
          <X size={15} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
};
