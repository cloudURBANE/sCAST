import React from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Cookie, ShieldCheck, X } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { useModalBehavior } from "@/hooks/use-modal-behavior";
import {
  acceptAllConsent,
  hasDecidedConsent,
  readConsent,
  rejectNonEssentialConsent,
  writeConsent,
  CONSENT_OPEN_EVENT,
} from "@/lib/consent";

// First-visit consent surface for the ScentBeam SPA. Rendered once, globally
// (AppShell). Two faces:
//   - a contained bottom banner shown until the user makes an explicit choice
//   - a centered preferences modal (the "Manage" path, also re-openable from the
//     footer / Cookie Policy page after the banner is gone)
//
// Theme-native: warm-black surface, gold hairline, neutral drop shadow (no
// projected gold glow — see the no-projected-gold-glow rule), serif display.
// Never auto-accepts and never auto-rejects: the banner simply waits.

type Mode = "hidden" | "banner" | "manage";

export function CookieConsentBanner() {
  const [mode, setMode] = React.useState<Mode>("hidden");

  // First paint: only surface the banner once, after a calm beat, and only if no
  // explicit choice is on record. The delay keeps it from racing the auth modal
  // / hero entrance on a cold load.
  React.useEffect(() => {
    if (hasDecidedConsent()) return;
    const timer = window.setTimeout(() => {
      setMode((current) => (current === "hidden" ? "banner" : current));
    }, 900);
    return () => window.clearTimeout(timer);
  }, []);

  // Footer / Cookie page can re-open the manager at any time, even post-decision.
  React.useEffect(() => {
    const open = () => setMode("manage");
    window.addEventListener(CONSENT_OPEN_EVENT, open);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, open);
  }, []);

  const handleAcceptAll = () => {
    acceptAllConsent();
    setMode("hidden");
  };

  const handleEssentialOnly = () => {
    rejectNonEssentialConsent();
    setMode("hidden");
  };

  return (
    <>
      <AnimatePresence>
        {mode === "banner" ? (
          <motion.div
            key="cookie-banner"
            role="region"
            aria-label="Cookie consent"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-0 z-[120] flex justify-center px-[max(0.75rem,env(safe-area-inset-left,0px))] bottom-[max(0.75rem,calc(env(safe-area-inset-bottom,0px)+0.75rem))] md:bottom-6"
          >
            <div className="pointer-events-auto w-full max-w-2xl rounded-[18px] border border-scent-accent/22 bg-[#0b0805]/95 p-4 text-scent-text-primary shadow-[0_22px_60px_rgba(0,0,0,0.66)] backdrop-blur-md sm:p-5">
              <div className="flex items-start gap-3.5">
                <span className="mt-0.5 hidden h-10 w-10 shrink-0 items-center justify-center rounded-full border border-scent-accent/30 bg-black/40 text-scent-accent sm:inline-flex">
                  <Cookie size={18} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="scent-type-label text-scent-accent/80">Your privacy</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-scent-text-muted">
                    We use essential storage to run ScentBeam and keep you signed in. With your
                    consent we also measure anonymous performance to improve the experience — no
                    advertising or cross-site tracking, ever. Read our{" "}
                    <Link
                      to="/cookies"
                      className="text-scent-accent underline-offset-2 hover:underline"
                    >
                      Cookie Policy
                    </Link>
                    .
                  </p>
                  <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
                    <button
                      type="button"
                      onClick={handleAcceptAll}
                      className="scent-primary-button inline-flex min-h-11 items-center justify-center rounded-full px-5 text-[11px] font-bold uppercase tracking-[0.16em]"
                    >
                      <span>Accept all</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleEssentialOnly}
                      className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/14 px-5 text-[11px] font-bold uppercase tracking-[0.16em] text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
                    >
                      Essential only
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("manage")}
                      className="inline-flex min-h-11 items-center justify-center rounded-full px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-scent-text-subtle transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 sm:ml-auto"
                    >
                      Manage
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {mode === "manage" ? (
        <ConsentManager onClose={() => setMode("hidden")} />
      ) : null}
    </>
  );
}

function ConsentManager({ onClose }: { onClose: () => void }) {
  const modalRef = React.useRef<HTMLDivElement | null>(null);
  const saveRef = React.useRef<HTMLButtonElement | null>(null);
  const [analytics, setAnalytics] = React.useState<boolean>(() => readConsent().analytics);

  useModalBehavior({
    isOpen: true,
    containerRef: modalRef,
    initialFocusRef: saveRef,
    onDismiss: onClose,
    closeOnEscape: true,
  });

  const handleSave = () => {
    writeConsent({ analytics });
    onClose();
  };

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/80 px-4 py-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cookie-manager-title"
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-lg rounded-[20px] border border-scent-accent/22 bg-[#0b0805]/97 p-5 text-scent-text-primary shadow-[0_28px_70px_rgba(0,0,0,0.72)] sm:p-7"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="scent-type-label text-scent-accent/80">Cookie preferences</p>
            <h2
              id="cookie-manager-title"
              className="mt-1.5 font-serif text-2xl italic leading-tight text-scent-text-primary"
            >
              Choose what we store
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cookie preferences"
            className="-m-1 inline-flex min-h-10 min-w-10 items-center justify-center rounded-full text-scent-text-subtle transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="mt-6 space-y-3">
          <PreferenceRow
            icon={<ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />}
            title="Essential"
            description="Keeps you signed in and remembers your wardrobe and settings. Required for ScentBeam to work, so it can't be switched off."
            control={
              <Switch
                checked
                disabled
                aria-label="Essential storage is always on"
                className="data-[state=checked]:bg-scent-accent/60"
              />
            }
          />
          <PreferenceRow
            icon={<Cookie size={16} strokeWidth={1.75} aria-hidden="true" />}
            title="Performance analytics"
            description="Anonymous speed and stability measurements that help us make the app faster. No advertising, no cross-site tracking, no profiles."
            control={
              <Switch
                checked={analytics}
                onCheckedChange={setAnalytics}
                aria-label="Performance analytics"
                className="data-[state=checked]:bg-scent-accent data-[state=unchecked]:bg-white/12"
              />
            }
          />
        </div>

        <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/14 px-5 text-[11px] font-bold uppercase tracking-[0.16em] text-scent-text-muted transition-colors hover:border-scent-accent/45 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
          >
            Cancel
          </button>
          <button
            ref={saveRef}
            type="button"
            onClick={handleSave}
            className="scent-primary-button inline-flex min-h-11 items-center justify-center rounded-full px-6 text-[11px] font-bold uppercase tracking-[0.16em]"
          >
            <span>Save preferences</span>
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function PreferenceRow({
  icon,
  title,
  description,
  control,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  control: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-3.5 rounded-[14px] border border-white/8 bg-white/[0.02] p-4">
      <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-scent-accent/22 bg-black/35 text-scent-accent">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold tracking-[0.02em] text-scent-text-primary">{title}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-scent-text-subtle">{description}</p>
      </div>
      <div className="shrink-0 pt-1">{control}</div>
    </div>
  );
}
