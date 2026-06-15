import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { isStandalonePwa } from "@/lib/platform";
import {
  getPushSupport,
  getServerPushConfig,
  isPushSubscribed,
  subscribeToPush,
} from "@/lib/pushNotifications";

/**
 * Web-push consent banner.
 *
 * The push *plumbing* already exists (lib/pushNotifications.ts + the Express
 * /api/push routes); the only opt-in surface before this was the settings
 * toggle. This is a gentle, self-dismissing nudge for users who'd otherwise
 * never open settings.
 *
 * Coordination with InstallPrompt: this renders ONLY when running as an
 * installed PWA (`isStandalonePwa()`), and InstallPrompt renders only when NOT
 * standalone — so the two never occupy the shared bottom slot at the same time.
 * That gate also matches iOS, where web push is available exclusively inside an
 * installed PWA. (Mirrors `ProfileSettingsModal.handleTogglePush`.)
 */

const DISMISS_KEY = "scent_push_prompt_dismissed";
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SHOW_DELAY_MS = 5000;

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

export function PushPrompt() {
  const { authToken } = useAuth();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Signed-in only — subscribeToPush needs a bearer token.
    if (!authToken) {
      setVisible(false);
      return;
    }
    if (!isStandalonePwa() || recentlyDismissed()) return;

    const support = getPushSupport();
    // Hide on unsupported browsers and on users who already blocked us (the
    // browser-level block is sticky; re-nagging can't help).
    if (!support.supported || support.permission === "denied") return;

    let cancelled = false;
    let timer: number | undefined;

    void (async () => {
      const [{ configured }, alreadySubscribed] = await Promise.all([
        getServerPushConfig(),
        isPushSubscribed(),
      ]);
      if (cancelled || !configured || alreadySubscribed) return;
      // Let the app settle before surfacing the nudge.
      timer = window.setTimeout(() => {
        if (!cancelled) setVisible(true);
      }, SHOW_DELAY_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [authToken]);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    rememberDismissal();
  };

  const enable = async () => {
    if (!authToken || busy) return;
    setBusy(true);
    try {
      const result = await subscribeToPush(authToken);
      // Success or a hard "denied"/"not-configured" all resolve the prompt; only
      // a transient server error leaves the banner up to retry.
      if (result.ok || result.reason === "denied" || result.reason === "not-configured") {
        setVisible(false);
        rememberDismissal();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-x-3 bottom-[calc(var(--mobile-nav-offset,var(--bottomnav-h))+0.5rem)] z-[100] transition-[bottom] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] md:inset-x-auto md:right-4 md:bottom-4 md:w-[22rem]"
      role="dialog"
      aria-label="Enable ScentBeam notifications"
    >
      <div className="mx-auto flex w-full max-w-2xl items-start gap-3 rounded-2xl border border-scent-accent/30 bg-neutral-950/95 px-4 py-3 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.95)] backdrop-blur-sm md:max-w-none">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-scent-accent/40 bg-scent-accent/10 text-scent-accent">
          <Bell size={18} strokeWidth={2} aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-white">Turn on scent nudges</p>
          <p className="mt-0.5 text-[12px] leading-snug text-white/65 font-sans">
            Get the occasional notification when the weather shifts your perfect wear.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={enable}
              disabled={busy}
              className="rounded-full border border-scent-accent/70 bg-scent-accent/15 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[#fff7ec] transition-colors hover:bg-scent-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/40 disabled:pointer-events-none disabled:opacity-60"
            >
              {busy ? "Enabling…" : "Enable"}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45 transition-colors hover:text-white/75"
            >
              Not now
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss notification prompt"
          className="-my-1 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/10 hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
        >
          <X size={15} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
