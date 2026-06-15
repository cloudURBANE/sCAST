import { useEffect, useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";

import { isIpadDevice, isStandalonePwa } from "@/lib/platform";

/**
 * Home-screen install affordance.
 *
 * Two paths, because the platforms differ:
 *  - Chromium (Android / desktop) fires `beforeinstallprompt`; we capture it,
 *    suppress the default mini-infobar, and drive the native prompt from our own
 *    button so it matches the app.
 *  - iOS Safari never fires that event, so we show manual "Share → Add to Home
 *    Screen" guidance instead.
 *
 * Self-contained: it manages its own visibility and a 14-day dismissal memory,
 * so mounting it is a one-liner. Renders nothing when already installed.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISS_KEY = "scent_pwa_install_dismissed";
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const IOS_HINT_DELAY_MS = 4000;

function recentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* storage unavailable (private mode / quota) — in-memory dismissal only */
  }
}

/** iOS WebKit Safari, where Add-to-Home-Screen is a manual Share-sheet action. */
function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIos = /iphone|ipod|ipad/i.test(ua) || isIpadDevice();
  if (!isIos) return false;
  // Embedded browsers / alt iOS shells either can't A2HS or do it differently —
  // don't show misleading Safari instructions there.
  const isAltShell = /(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|YaBrowser|FBAN|FBAV|Instagram|Line|GSA)/i.test(ua);
  return !isAltShell;
}

export function InstallPrompt() {
  const [mode, setMode] = useState<null | "native" | "ios">(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalonePwa() || recentlyDismissed()) return;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setMode("native");
    };
    const onInstalled = () => {
      setDeferred(null);
      setMode(null);
      rememberDismissal();
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    let iosTimer: number | undefined;
    if (isIosSafari()) {
      iosTimer = window.setTimeout(() => setMode((current) => current ?? "ios"), IOS_HINT_DELAY_MS);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      if (iosTimer) window.clearTimeout(iosTimer);
    };
  }, []);

  if (!mode) return null;

  const dismiss = () => {
    setMode(null);
    rememberDismissal();
  };

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* user dismissed the native sheet — treat as a dismissal */
    }
    setDeferred(null);
    dismiss();
  };

  return (
    <div
      className="fixed inset-x-3 bottom-[calc(var(--bottomnav-h,0px)+0.5rem)] z-[100] md:inset-x-auto md:right-4 md:bottom-4 md:w-[22rem]"
      role="dialog"
      aria-label="Install ScentBeam"
    >
      <div className="mx-auto flex w-full max-w-2xl items-start gap-3 rounded-2xl border border-scent-accent/30 bg-neutral-950/95 px-4 py-3 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.95)] backdrop-blur-sm md:max-w-none">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-scent-accent/40 bg-scent-accent/10 text-scent-accent">
          {mode === "native" ? <Download size={18} strokeWidth={2} aria-hidden /> : <Share size={18} strokeWidth={2} aria-hidden />}
        </span>

        <div className="min-w-0 flex-1">
          {mode === "native" ? (
            <>
              <p className="text-[13px] font-semibold leading-snug text-white">Install ScentBeam</p>
              <p className="mt-0.5 text-[12px] leading-snug text-white/65 font-sans">
                Add it to your home screen for a full-screen, offline-ready app.
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={install}
                  className="rounded-full border border-scent-accent/70 bg-scent-accent/15 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[#fff7ec] transition-colors hover:bg-scent-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40"
                >
                  Install
                </button>
                <button
                  type="button"
                  onClick={dismiss}
                  className="rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45 transition-colors hover:text-white/75"
                >
                  Not now
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[13px] font-semibold leading-snug text-white">Add ScentBeam to your Home Screen</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] leading-snug text-white/65 font-sans">
                <span>Tap</span>
                <Share size={13} strokeWidth={2} aria-hidden className="inline text-white/80" />
                <span>in the Safari toolbar, then</span>
                <span className="inline-flex items-center gap-1 font-semibold text-white/90">
                  <SquarePlus size={13} strokeWidth={2} aria-hidden /> Add to Home Screen
                </span>
                <span>.</span>
              </p>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="-my-1 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/10 hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
        >
          <X size={15} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
